// Sprint Hybrid: a pump.fun paper-trading bot for the 6-hour replay window.
// Two legs in one bot — a filtered launch sniper for breadth (the 20+ coins
// the guardrail bar needs) and a selective real-SOL crossing flipper for the
// winners the sniper's birth filter rejected — both flipping fast, because
// this market mean-reverts within minutes. See strategy.ts for the research.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
