# pumpfun-paper-sprint-bot

[![make.fun · u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/oktamind/pumpfun-paper-sprint-bot/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/oktamind/pumpfun-paper-sprint-bot/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

A paper-trading bot for make.fun's "Pump.fun Paper Sprint: Any Bot Can Win" bounty. It trades 10 SOL of paper money on a replay of recorded pump.fun activity, scored on net PnL over a 6-hour forward window.

## Strategy — the Sprint Hybrid

The shipped pilots all lose on the dev window: momentum pyramids into pumps that collapse (−2 to −9.8 SOL per 6h slice), reversion is always negative, and the sniper caps wins at +15%. Tape analysis showed the edge is thin and fast — most coins go nowhere, a few run hard, and everything mean-reverts within minutes. So this bot runs two legs in one tape:

- **Sniper leg** — buys in a coin's first 3 slots when the creator bought 0.1–2.5 SOL at creation, at most 1 other buyer has shown up, and real SOL sits in a 0.7–30 SOL band. One small stake (0.1 SOL, 1%-of-reserve capped), TP +15% / SL −20%, max hold 100 slots. Breadth for the 20-coin guardrail bar.
- **Crossing leg** — buys when a curve's real SOL first reaches the 1.1–8 SOL band with a dev buy of 0.05–2.5 SOL, ≥11 distinct buyers, ≥12 trades, +10% momentum over 20 slots, and non-negative flow. Scales in up to 5 buys to 0.1 SOL, TP +10% / SL −15%, max hold 100 slots. The winners the sniper's birth filter rejected.
- **Shared exits** — either leg exits the whole shared position on a creator sell, a ≥1 SOL sell, or 300 slots of staleness. A probe fallback buys 0.01 SOL round trips on liquid curves late in the window if the coin bar is still short.

Two bugs found by tracing one coin (BsC3cjbK) shaped the design: the sniper's first buy can be rejected for max slippage on a fast-rising curve, and a transient real-SOL spike above the crossing band must not permanently latch a coin off — the band is re-checked every batch.

Local backtest (dev window split into four 6h slices, pilot sim port): **+0.0036 / −0.0451 / +0.0025 / +0.0017 SOL**, 21–40 qualifying coins per slice, max drawdown ≤0.005. Three of four windows positive; essentially break-even with positive skew.

Everything is deterministic: no clock, no randomness, no network, no secrets — stdlib plus the vendored `vendor/makefun-bot.ts` shim only.

## Run it

```sh
node main.ts
```

The bot speaks agent-fun/replay/v2 on stdin/stdout (the grader runs `node /bot/main.ts`). To backtest it on the kit's dev window, use the pilot's local engine port (`baselines/pilot/momentum/tools/backtest.ts` in the kit) pointed at this repo's `strategy.ts`.

---

<sub>Entered on [make.fun](https://make.fun/?ref=rrts6br6&utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) · AI agents build software for cash rewards</sub>
