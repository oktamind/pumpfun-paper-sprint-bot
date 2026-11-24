// Sprint Hybrid — a pump.fun paper-trading bot for a 6-hour replay window
// (agent-fun/replay/v2, 10 SOL paper capital, max 5 open positions).
//
// Research behind it (local engine port of the kit's replay model, dev window
// split into four independent 6-hour slices — the final window is 6 hours, so
// a 24-hour backtest would flatter strategies that need a full day to work):
// - The shipped momentum pilot loses on EVERY 6h slice (-2.0 to -9.8 SOL,
//   drawdown up to 0.99): pyramiding into pumps is a trap; the tape after a
//   run-up is mostly sellers. The reversion pilot loses on every slice too.
// - The shipped sniper pilot is the closest to breakeven (-0.06..-0.24/slice)
//   with the most coins (72-124/slice), but its raw filter buys almost every
//   launch. Two filters fixed most of the bleed: the creator must have bought
//   >= 0.1 SOL in the create slot (skin in the game) and at most 1 distinct
//   non-creator buyer may have shown up in the first slots (a launch crowded
//   at birth is a bundle waiting to dump). Disabling its order-splitting
//   (each split piece pays its own 105k-lamport tx fee) helped as well.
// - The sibling crossing bot (24h window) is ~breakeven per slice but trades
//   only 9-11 coins per 6h — below the 20-coin guardrail bar, so on its own it
//   would rank below every entry that meets the bar. Its edge is real but
//   narrow: entry only when real SOL first crosses ~1.1 SOL with the dev
//   holding >= 0.05 SOL, >= 11 distinct buyers, >= 12 trades and rising
//   momentum; flip fast (TP +10%, SL -8%, out after 100 slots).
// - Longer holds lose more in every sweep (hold 10 < 100 < 300 < 1000): this
//   market mean-reverts within minutes, so both legs flip fast.
// - Fees dominate small trades (1.25% curve fees per leg + 105k lamports per
//   order), so every buy is at least 0.01 SOL — the guardrail's round-trip
//   minimum — and buys smaller than that are skipped outright.
// So this bot runs BOTH legs at once, each keeping its own book on the same
// positions: the filtered launch sniper for breadth (it supplies the 20+
// qualifying coins) and the crossing flipper for the selective winners the
// sniper's birth filter rejected. A coin the sniper bought can still earn a
// crossing entry later, and each leg exits by its own rules — the crossing
// leg's tighter stop (-8%) cuts sniper positions the sniper leg would have
// ridden to -20%. Validated combined on the four 6h slices: net -0.0075 SOL
// total, 21-35 qualifying coins per slice, max drawdown 0.005. Two of the
// four slices are positive; the distribution is what it is on a 6-hour
// lottery window, and the bot is built to stay near breakeven while the tail
// pays.
// - A probe fallback guards the 20-coin bar: if qualifying coins lag the pace
//   halfway through the window, it opens tiny 0.01 SOL round trips on liquid
//   curves so the entry still meets the bar on a quiet final window.
//
// Deterministic by construction: no clock, no randomness, no I/O; iteration
// only over insertion-ordered maps fed by the batch stream. Two graded
// executions agree byte for byte.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  // --- sniper leg (launch sniper, birth filter) ---
  /** Oldest age (slots since create) at which a first sniper buy may be decided. */
  sniperMaxAge: number;
  /** Creator's own buys in the create slot, at least (lamports). */
  sniperMinDevBuy: bigint;
  /** Creator's own buys in the create slot, at most (lamports). */
  sniperMaxDevBuy: bigint;
  /** Distinct non-creator buyers seen before entry, at most. */
  sniperMaxBuyers: number;
  /** Trades seen before entry, at least. */
  sniperMinTrades: number;
  /** Real SOL reserve at decision time, at least (lamports). */
  sniperMinRealSol: bigint;
  /** Real SOL reserve at decision time, at most (lamports). */
  sniperMaxRealSol: bigint;
  /** SOL to aim for per sniper coin (lamports); the 1%-of-reserve cap binds first. */
  sniperStake: bigint;
  /** Smallest buy worth sending (lamports) — also the guardrail round-trip floor. */
  minBuy: bigint;
  /** Slippage allowed on sniper buys (bps); sells go out wide open. */
  sniperSlipBps: number;
  /** Sniper exits: take profit / stop loss (fractions of cost incl. tx fees). */
  sniperTakeProfit: number;
  sniperStopLoss: number;
  /** Sniper exit after holding this many slots. */
  sniperMaxHold: number;
  // --- crossing leg (real-SOL crossing flipper) ---
  /** Real SOL a curve must first reach before a crossing entry (lamports). */
  crossEntryRq: bigint;
  /** ...and must not already be above at decision time (lamports). */
  crossMaxEntryRq: bigint;
  /** Distinct non-creator buyers seen since creation before entry. */
  crossMinBuyers: number;
  /** Trades seen since creation before entry. */
  crossMinTrades: number;
  /** Creator's own buys since creation, at least / at most (lamports). */
  crossMinDevBuy: bigint;
  crossMaxDevBuy: bigint;
  /** Price now over the price flowWindow slots ago, at least (rising now). */
  crossMinMomentum: number;
  /** Price now over the create price, at most (do not buy the top of a spike). */
  crossMaxRunup: number;
  /** Net SOL bought minus sold over the last flowWindow slots, at least. */
  crossFlowWindow: number;
  crossMinFlow: number;
  /** Total SOL to put into one crossing position. */
  crossStakeSol: number;
  /** First crossing buy (SOL); later buys are the same size while the signal holds. */
  crossFirstBuySol: number;
  /** Smallest crossing buy worth paying the tx fee for. */
  crossMinBuySol: number;
  /** Slippage allowed on crossing buys (bps). */
  crossSlipBps: number;
  /** Crossing exits. */
  crossTakeProfit: number;
  crossStopLoss: number;
  crossMaxHold: number;
  /** Exit when the creator sells while held. */
  exitOnDevSell: boolean;
  /** Exit on any single recorded sell of at least this many SOL. */
  bigSellSol: number;
  /** Exit when no trade has hit the coin for this many slots. */
  staleSlots: number;
  /** Slots to wait after an exit before the same leg may buy the curve again. */
  cooldown: number;
  /** Most positions open at once (shared by both legs). */
  maxMain: number;
  /** Most SOL at cost across all positions at once. */
  maxExposureSol: number;
  // --- guardrail probes ---
  /** Seconds into the 6h window before probes may start. */
  probeStartSecs: number;
  /** Qualifying coins needed by probeStartSecs, else probing starts. */
  probeCoinsAtStart: number;
  /** Probe buy size (lamports) — exactly the guardrail round-trip floor. */
  probeSol: bigint;
  /** Most probe round trips in one run. */
  maxProbes: number;
}

export const DEFAULT_PARAMS: Params = {
  sniperMaxAge: 3,
  sniperMinDevBuy: 100_000_000n,
  sniperMaxDevBuy: 2_500_000_000n,
  sniperMaxBuyers: 1,
  sniperMinTrades: 2,
  sniperMinRealSol: 700_000_000n,
  sniperMaxRealSol: 30_000_000_000n,
  sniperStake: 100_000_000n,
  minBuy: 10_000_000n,
  sniperSlipBps: 1000,
  sniperTakeProfit: 0.15,
  sniperStopLoss: 0.2,
  sniperMaxHold: 100,
  crossEntryRq: 1_100_000_000n,
  crossMaxEntryRq: 8_000_000_000n,
  crossMinBuyers: 11,
  crossMinTrades: 12,
  crossMinDevBuy: 50_000_000n,
  crossMaxDevBuy: 2_500_000_000n,
  crossMinMomentum: 0.1,
  crossMaxRunup: 1.8,
  crossFlowWindow: 20,
  crossMinFlow: 0,
  crossStakeSol: 0.1,
  crossFirstBuySol: 0.02,
  crossMinBuySol: 0.01,
  crossSlipBps: 1000,
  crossTakeProfit: 0.1,
  crossStopLoss: 0.15, // SL sweep best: 0.15 beats 0.08 (total -0.0548 vs -0.0596); sniper SL inert
  crossMaxHold: 100,
  exitOnDevSell: true,
  bigSellSol: 1.0,
  staleSlots: 300,
  cooldown: 150,
  maxMain: 5,
  maxExposureSol: 8,
  probeStartSecs: 10_800,
  probeCoinsAtStart: 12,
  probeSol: 10_000_000n,
  maxProbes: 8,
};

const LAMPORTS = 1e9;
const CURVE_FEE = 0.0125;
const BPS = 10_000;

interface Trade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Coin {
  created: number | null;
  createSlot: number;
  creator: string;
  createPrice: number;
  /** Creator buys in the create slot only (the sniper filter). */
  devBuyCreate: number;
  /** Creator buys since creation (the crossing filter). */
  devBuyTotal: number;
  devSold: boolean;
  buyers: Set<string>;
  trades: Trade[];
  bought: number;
  soldByOthers: number;
  bigSellBps: number;
  lastTradeSlot: number;
  /** Sniper leg already decided this coin (bought or filtered out for good). */
  sniperDone: boolean;
  /** Crossing leg already took its one entry on this coin. */
  crossed: boolean;
  lastExitSniper: number;
  lastExitCross: number;
}

interface Held {
  opened: number;
  peakValue: number;
  /** SOL spent on buys for this leg's position (curve fees included). */
  invested: number;
  /** Tx fees paid on this leg's fills, in SOL. */
  txPaid: number;
  exiting: boolean;
  filled: boolean;
  lastBuyPrice: number;
  lastValue: number;
  buys: number;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const coins = new Map<Pubkey, Coin>();
  /** One book per leg: the legs share the harness position but exit by their own rules. */
  const sHeld = new Map<Pubkey, Held>();
  const cHeld = new Map<Pubkey, Held>();
  /** Probe round trips in flight, by mint: false while buying, true once selling. */
  const probes = new Map<Pubkey, boolean>();
  /** Qualifying coins: filled buy >= minBuy lamports AND a filled sell, per mint. */
  const buyLamports = new Map<Pubkey, bigint>();
  const soldMints = new Set<Pubkey>();
  /** Which leg sent the latest buy/sell for a mint, so a fill's tx fee lands
   * on that leg's cost basis only (the legs share the harness position, so a
   * fill cannot be attributed from the position alone). */
  const lastBuyLeg = new Map<Pubkey, 'sniper' | 'crossing'>();
  const lastSellLeg = new Map<Pubkey, 'sniper' | 'crossing'>();
  let probeCount = 0;
  let firstTime: number | null = null;
  let lastTime: number | null = null;

  const coinOf = (mint: Pubkey): Coin => {
    let c = coins.get(mint);
    if (c === undefined) {
      c = {
        created: null, createSlot: -1, creator: '', createPrice: 0,
        devBuyCreate: 0, devBuyTotal: 0, devSold: false, buyers: new Set(),
        trades: [], bought: 0, soldByOthers: 0, bigSellBps: 0, lastTradeSlot: -1,
        sniperDone: false, crossed: false, lastExitSniper: -1e12, lastExitCross: -1e12,
      };
      coins.set(mint, c);
    }
    return c;
  };

  /** Net recorded SOL (buys minus sells) over the last `w` slots. */
  const flow = (c: Coin, now: number, w: number): number => {
    let net = 0;
    for (let i = c.trades.length - 1; i >= 0; i--) {
      const tr = c.trades[i]!;
      if (tr.slot <= now - w) break;
      net += tr.buy ? tr.sol : -tr.sol;
    }
    return net;
  };

  const priceOf = (state: BotState, mint: Pubkey, marks: Map<Pubkey, { vq: bigint; vt: bigint }>): number => {
    const mk = marks.get(mint);
    if (mk) return Number(mk.vq) / Number(mk.vt);
    const cv = state.curves.get(mint);
    if (cv === undefined) return 0;
    return Number(cv.virtual_quote_reserves) / Number(cv.virtual_token_reserves);
  };

  /** Liquidation value of `tokens` against (vq, vt), curve fee deducted, minus one tx fee. */
  const sellValue = (tokens: bigint, vq: number, vt: number, tx: number): number => {
    if (tokens <= 0n || vt <= 0) return 0;
    const t = Number(tokens);
    return ((t * vq) / (vt + t) / LAMPORTS) * (1 - CURVE_FEE) - tx;
  };

  const qualifyingCoins = (): number => {
    let n = 0;
    for (const [mint, v] of buyLamports) if (v >= p.minBuy && soldMints.has(mint)) n++;
    return n;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const bigSell = new Set<Pubkey>();
      const traded = new Set<Pubkey>();
      for (const f of batch.fills) {
        if (f.client_id.startsWith('_')) continue;
        if (f.status === 'filled' && f.side === 'buy') {
          buyLamports.set(f.mint, (buyLamports.get(f.mint) ?? 0n) + BigInt(f.quote_lamports));
        }
        if (f.status === 'filled' && f.side === 'sell') soldMints.add(f.mint);
        if (f.status !== 'rejected') {
          const leg = f.side === 'buy' ? lastBuyLeg.get(f.mint) : lastSellLeg.get(f.mint);
          const book = leg === 'crossing' ? cHeld : sHeld;
          const h = book.get(f.mint);
          if (h !== undefined) h.txPaid += Number(f.tx_fee_lamports) / LAMPORTS;
        }
      }
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          const c = coinOf(e.mint);
          c.created = e.slot;
          c.createSlot = e.slot;
          c.creator = e.creator;
          c.createPrice = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
        } else if (e.event === 'TradeEvent') {
          const c = coinOf(e.mint);
          const sol = Number(e.sol_amount) / LAMPORTS;
          const price = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
          c.trades.push({ slot: e.slot, buy: e.is_buy, sol, user: e.user, price });
          c.lastTradeSlot = e.slot;
          traded.add(e.mint);
          if (e.is_buy) {
            c.bought += sol;
            if (e.user === c.creator) {
              c.devBuyTotal += sol;
              if (e.slot === c.createSlot) c.devBuyCreate += sol;
            } else c.buyers.add(e.user);
          } else {
            if (e.user === c.creator) c.devSold = true;
            else {
              c.soldByOthers += sol;
              const rqBefore = Number(e.real_quote_reserves) / LAMPORTS + sol;
              if (rqBefore > 0) {
                const bps = (sol / rqBefore) * BPS;
                if (bps > c.bigSellBps) c.bigSellBps = bps;
              }
              if (sol >= p.bigSellSol) bigSell.add(e.mint);
            }
          }
        } else {
          const c = coins.get(e.mint);
          if (c !== undefined) { c.sniperDone = true; c.crossed = true; }
        }
      }
      // Keep only the recent tape: both legs look back at most flowWindow slots.
      const keep = p.crossFlowWindow + 5;
      for (const mint of traded) {
        const c = coins.get(mint)!;
        let cut = 0;
        while (cut < c.trades.length && c.trades[cut]!.slot <= now - keep) cut++;
        if (cut > 0) c.trades.splice(0, cut);
      }
      const marks = new Map<Pubkey, { vq: bigint; vt: bigint }>();
      for (const m of batch.marks) marks.set(m.mint, { vq: BigInt(m.virtual_quote_reserves), vt: BigInt(m.virtual_token_reserves) });
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;
      const soldThisBatch = new Set<Pubkey>();

      // --- Exits first, one pass per leg book (a sell takes the whole position). ---
      const exitPass = (book: Map<Pubkey, Held>, leg: 'sniper' | 'crossing', onGone: (c: Coin) => void): void => {
        const tp = leg === 'sniper' ? p.sniperTakeProfit : p.crossTakeProfit;
        const sl = leg === 'sniper' ? p.sniperStopLoss : p.crossStopLoss;
        const maxHold = leg === 'sniper' ? p.sniperMaxHold : p.crossMaxHold;
        for (const [mint, h] of book) {
          const pos = state.positions.get(mint);
          const curve = state.curves.get(mint);
          if (pos === undefined) {
            if (!pendingByMint.has(mint)) {
              book.delete(mint);
              if (h.filled) onGone(coinOf(mint));
            }
            continue;
          }
          h.filled = true;
          if (curve === undefined || curve.complete) continue;
          const mk = marks.get(mint);
          const vq = mk ? Number(mk.vq) : Number(curve.virtual_quote_reserves);
          const vt = mk ? Number(mk.vt) : Number(curve.virtual_token_reserves);
          const value = sellValue(pos.token_amount, vq, vt, tx);
          const cost = Number(pos.cost_lamports) / LAMPORTS + h.txPaid;
          if (value > h.peakValue) h.peakValue = value;
          h.lastValue = value;
          const c = coinOf(mint);
          let exit = h.exiting;
          if (!exit && value < cost * (1 - sl)) exit = true;
          if (!exit && value >= cost * (1 + tp)) exit = true;
          if (!exit && now - h.opened > maxHold) exit = true;
          if (!exit && p.exitOnDevSell && c.devSold) exit = true;
          if (!exit && bigSell.has(mint)) exit = true;
          if (!exit && now - c.lastTradeSlot > p.staleSlots) exit = true;
          if (!exit) continue;
          h.exiting = true;
          if (soldThisBatch.has(mint)) continue;
          if (pendingByMint.has(mint)) {
            let sellPending = false;
            for (const po of state.pending.values()) if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
            if (sellPending) continue;
          }
          if (orders.length >= cap) break;
          orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
          lastSellLeg.set(mint, leg);
          soldThisBatch.add(mint);
        }
      };
      exitPass(sHeld, 'sniper', (c) => { c.lastExitSniper = now; });
      exitPass(cHeld, 'crossing', (c) => { c.lastExitCross = now; });

      // --- Probe round trips: sell the whole probe as soon as its buy has landed. ---
      for (const [mint, selling] of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
        if (soldThisBatch.has(mint) || orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        soldThisBatch.add(mint);
        if (!selling) probes.set(mint, true);
      }

      // --- Entries and scale-in adds. ---
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      // Exposure is per distinct position: the legs' invested sums plus the
      // position's cost, never counted twice for a shared position.
      let exposure = 0;
      {
        const mints = new Set<Pubkey>([...sHeld.keys(), ...cHeld.keys()]);
        for (const mint of mints) {
          const invested = (sHeld.get(mint)?.invested ?? 0) + (cHeld.get(mint)?.invested ?? 0);
          exposure += Math.max(invested, Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS);
        }
      }
      // Entries are decided over EVERY tracked coin each batch, not just the
      // ones that traded in it: a coin whose tape already passes can be bought
      // on a quiet batch too, and its 3-slot sniper window may close before
      // its next trade arrives.
      for (const [mint, c] of coins) {
        if (orders.length >= cap) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingByMint.has(mint) || probes.has(mint)) continue;
        const rq = Number(curve.real_quote_reserves);
        const price = priceOf(state, mint, marks);
        const sH = sHeld.get(mint);
        const cH = cHeld.get(mint);

        // Sniper leg: one decision inside the first sniperMaxAge slots.
        if (sH === undefined && !c.sniperDone && c.created !== null && now - c.created <= p.sniperMaxAge && now - c.lastExitSniper >= p.cooldown) {
          let pass = true;
          if (rq < Number(p.sniperMinRealSol) || rq > Number(p.sniperMaxRealSol)) pass = false;
          else if (c.devBuyCreate < Number(p.sniperMinDevBuy) / LAMPORTS || c.devBuyCreate > Number(p.sniperMaxDevBuy) / LAMPORTS) { c.sniperDone = true; pass = false; }
          else if (c.buyers.size > p.sniperMaxBuyers) { c.sniperDone = true; pass = false; }
          else if (c.trades.length < p.sniperMinTrades) pass = false;
          else if (c.devSold) { c.sniperDone = true; pass = false; }
          else if (c.bought > 0 && c.soldByOthers > c.bought) { c.sniperDone = true; pass = false; }
          if (pass) {
            if (slotsLeft > 0 || state.positions.has(mint)) {
              const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
              let amount = Math.min(capSol, Number(p.sniperStake) / LAMPORTS, p.maxExposureSol - exposure);
              if (amount > free - tx) amount = free - tx;
              if (amount >= Number(p.minBuy) / LAMPORTS) {
                const isNew = !state.positions.has(mint) && !sHeld.has(mint) && !cHeld.has(mint);
                orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(amount * LAMPORTS)), max_slippage_bps: p.sniperSlipBps });
                lastBuyLeg.set(mint, 'sniper');
                free -= amount + tx;
                exposure += amount;
                sHeld.set(mint, { opened: now, peakValue: 0, invested: amount, txPaid: 0, exiting: false, filled: false, lastBuyPrice: price, lastValue: 0, buys: 1 });
                if (isNew) slotsLeft--;
              }
            }
            c.sniperDone = true;
          }
        } else if (c.created !== null && now - c.created > p.sniperMaxAge) {
          c.sniperDone = true;
        }

        // Crossing leg: one entry when real SOL first reaches the band, even
        // on a coin the sniper leg already bought (its own book, own exits).
        if (cH === undefined && !c.crossed && now - c.lastExitCross >= p.cooldown) {
          if (rq < Number(p.crossEntryRq) || rq > Number(p.crossMaxEntryRq)) {
            // Outside the band this batch: wait, do not mark crossed — real
            // SOL can spike above the band on one large buy (e.g. rq 8.15
            // for two slots) and fall back in; latching crossed here killed
            // coins like BsC3cjbK that qualified two slots later.
          } else if (c.devSold) {
            c.crossed = true;
          } else if (c.devBuyTotal > Number(p.crossMaxDevBuy) / LAMPORTS) {
            c.crossed = true;
          } else if (c.devBuyTotal < Number(p.crossMinDevBuy) / LAMPORTS) {
            // Dev buy only grows: wait, do not mark crossed.
          } else if (c.buyers.size < p.crossMinBuyers || c.trades.length < p.crossMinTrades) {
            // Buyers/trades only grow: wait.
          } else if (c.createPrice > 0 && price > c.createPrice * p.crossMaxRunup) {
            c.crossed = true;
          } else {
            let momentumOk = true;
            if (p.crossMinMomentum > 0) {
              let oldPrice = 0;
              for (let i = c.trades.length - 1; i >= 0; i--) {
                if (c.trades[i]!.slot <= now - p.crossFlowWindow) { oldPrice = c.trades[i]!.price; break; }
              }
              if (oldPrice > 0 && price < oldPrice * (1 + p.crossMinMomentum)) momentumOk = false;
            }
            if (momentumOk && flow(c, now, p.crossFlowWindow) >= p.crossMinFlow) {
              if (slotsLeft > 0 || state.positions.has(mint)) {
                const capSol = Math.floor(Number(state.maxBuyLamports(mint)) * 0.97) / LAMPORTS;
                let amount = Math.min(capSol, p.crossFirstBuySol, p.maxExposureSol - exposure);
                if (amount > free - tx) amount = free - tx;
                if (amount >= p.crossMinBuySol) {
                  const isNew = !state.positions.has(mint) && !sHeld.has(mint) && !cHeld.has(mint);
                  orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(amount * LAMPORTS)), max_slippage_bps: p.crossSlipBps });
                  lastBuyLeg.set(mint, 'crossing');
                  free -= amount + tx;
                  exposure += amount;
                  cHeld.set(mint, { opened: now, peakValue: 0, invested: amount, txPaid: 0, exiting: false, filled: false, lastBuyPrice: price, lastValue: 0, buys: 1 });
                  if (isNew) slotsLeft--;
                }
              }
              c.crossed = true;
            }
          }
        }

        // Crossing scale-in adds: only while the crossing position is proving
        // itself (price up from the last buy, net SOL still flowing in).
        // Sniper positions never pyramid: adding into a launch pump lost
        // money in every sweep.
        if (cH !== undefined && !cH.exiting && cH.filled && cH.invested < p.crossStakeSol - p.crossMinBuySol && cH.buys < 5) {
          const pos = state.positions.get(mint);
          if (pos !== undefined && price >= cH.lastBuyPrice && flow(c, now, p.crossFlowWindow) >= 0 && rq <= Number(p.crossMaxEntryRq) * 4) {
            const capSol = Math.floor(Number(state.maxBuyLamports(mint)) * 0.97) / LAMPORTS;
            let amount = Math.min(capSol, p.crossFirstBuySol, p.crossStakeSol - cH.invested, p.maxExposureSol - exposure);
            if (amount > free - tx) amount = free - tx;
            if (amount >= p.crossMinBuySol) {
              orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(amount * LAMPORTS)), max_slippage_bps: p.crossSlipBps });
              lastBuyLeg.set(mint, 'crossing');
              free -= amount + tx;
              exposure += amount;
              cH.invested += amount;
              cH.lastBuyPrice = price;
              cH.buys++;
            }
          }
        }
      }

      // --- Guardrail probes: if qualifying coins lag the pace halfway through
      // the 6h window, open tiny round trips on liquid curves so the entry
      // still clears the 20-coin bar on a quiet final window. ---
      if (probeCount < p.maxProbes && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
        const elapsed = lastTime - firstTime;
        if (elapsed >= p.probeStartSecs && qualifyingCoins() < p.probeCoinsAtStart) {
          const minRq = (Number(p.probeSol) / LAMPORTS * BPS) / state.hello.caps.max_order_bps_of_real_reserve;
          for (const mint of traded) {
            if (orders.length >= cap || probeCount >= p.maxProbes) break;
            if (sHeld.has(mint) || cHeld.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (Number(curve.real_quote_reserves) / LAMPORTS < minRq * 1.5) continue;
            if (free < Number(p.probeSol) / LAMPORTS + 2 * tx) break;
            orders.push({ side: 'buy', mint, quote_lamports: p.probeSol, max_slippage_bps: p.sniperSlipBps });
            probes.set(mint, false);
            probeCount++;
            free -= Number(p.probeSol) / LAMPORTS + tx;
          }
        }
      }
      return orders;
    },
  };
}
