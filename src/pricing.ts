import type { Turn } from './types.js';

/**
 * USD per million tokens. Base input and cache-read prices come from LiteLLM's
 * model_prices_and_context_window.json (the same source ccusage uses); cache-write multipliers
 * (1.25x for 5-minute, 2x for 1-hour) are from Anthropic's prompt-caching documentation.
 * These are approximations for the pay-as-you-go API. Subscription plans do not bill per token,
 * so for them the dollar figure is only a proxy for "how much of my window this consumed".
 */
interface Price {
  input: number;
  read: number;
}
const PRICES: Array<[match: string, price: Price]> = [
  ['opus-5', { input: 4, read: 0.2 }],
  ['sonnet-5', { input: 2, read: 0.1 }],
  ['haiku-5', { input: 0.1, read: 0.01 }],
  ['fable-5', { input: 10, read: 0.25 }],
  ['opus-4', { input: 5, read: 0.5 }],
  ['sonnet-4', { input: 3, read: 0.3 }],
  ['haiku-4', { input: 1, read: 0.1 }],
  ['opus', { input: 5, read: 0.5 }],
  ['sonnet', { input: 3, read: 0.3 }],
  ['haiku', { input: 1, read: 0.1 }],
];
const FALLBACK: Price = { input: 3, read: 0.3 };

export function priceFor(model: string): Price {
  const m = model.toLowerCase();
  return PRICES.find(([k]) => m.includes(k))?.[1] ?? FALLBACK;
}

/**
 * Extra cost of a rebuild: the tokens were written (1.25x or 2x base) instead of read (0.1x base).
 * Uses the turn's own 5m/1h split to pick the write multiplier.
 */
export function rebuildCostUsd(turn: Turn, rewrittenTokens: number): number {
  const p = priceFor(turn.model);
  const oneHourShare = turn.cacheWrite ? turn.cacheWrite1h / turn.cacheWrite : 0;
  const writeMultiplier = 1.25 * (1 - oneHourShare) + 2 * oneHourShare;
  return (rewrittenTokens * (p.input * writeMultiplier - p.read)) / 1_000_000;
}
