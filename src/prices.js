/**
 * The built-in Claude price table (USD per 1,000,000 tokens). A leaf module, so both
 * `config.js` (the shipped `pricing` default) and `usage.js` (the fallback table) read one copy.
 *
 * Source: https://platform.claude.com/docs/en/about-claude/pricing (Anthropic's official pricing
 * page, "Model pricing" and "Batch processing" tables), opened and read on 2026-11-17.
 *  - `cacheWrite` is the 5-minute write rate, `cacheWrite1h` the 1-hour one, `cacheRead` the
 *    "cache hits and refreshes" rate (Fable 5.1/5.2: 0.025x input; Opus 5.5 and Sonnet 5.5: 0.05x).
 *  - `batchFactor` is the Batch API share of the list price (the page: 50 percent off, every model).
 *  - Claude Haiku 5.5 is priced by prompt length; this table holds its rate for prompts up to
 *    100,000 tokens (a request over 100K pays 5x: 0.50 in / 2.50 out; one rate cannot tell them apart).
 *  - Sonnet 5's $2/$10 is the standard price now (the page: the 1 September 2026 increase will not occur).
 *  - Patterns carry no trailing `*` where a sibling model shares the prefix (`claude-opus-5` vs
 *    `claude-opus-5-5`); a dated name (`-20251101`) is matched by the extra `-20*` pattern.
 */
export const PRICE_SOURCE = {
  url: 'https://platform.claude.com/docs/en/about-claude/pricing',
  date: '2026-11-17',
};

const row = (input, output, cacheRead, cacheWrite, cacheWrite1h) => ({
  input, output, cacheRead, cacheWrite, cacheWrite1h, batchFactor: 0.5,
});

export const CLAUDE_PRICING = {
  '*/claude-fable-5-2*': row(8, 40, 0.2, 10, 16),
  '*/claude-fable-5-1*': row(10, 50, 0.25, 12.5, 20),
  '*/claude-fable-5': row(10, 50, 1, 12.5, 20),
  '*/claude-fable-5-20*': row(10, 50, 1, 12.5, 20),
  '*/claude-opus-5-5*': row(4, 20, 0.2, 5, 8),
  '*/claude-opus-5': row(5, 25, 0.5, 6.25, 10),
  '*/claude-opus-5-20*': row(5, 25, 0.5, 6.25, 10),
  '*/claude-opus-4-8*': row(5, 25, 0.5, 6.25, 10),
  '*/claude-opus-4-7*': row(5, 25, 0.5, 6.25, 10),
  '*/claude-opus-4-6*': row(5, 25, 0.5, 6.25, 10),
  '*/claude-opus-4-5*': row(5, 25, 0.5, 6.25, 10),
  '*/claude-sonnet-5-5*': row(2, 10, 0.1, 2.5, 4),
  '*/claude-sonnet-5': row(2, 10, 0.2, 2.5, 4),
  '*/claude-sonnet-5-20*': row(2, 10, 0.2, 2.5, 4),
  '*/claude-sonnet-4-6*': row(3, 15, 0.3, 3.75, 6),
  '*/claude-sonnet-4-5*': row(3, 15, 0.3, 3.75, 6),
  '*/claude-haiku-5-5*': row(0.1, 0.5, 0.01, 0.125, 0.2),
  '*/claude-haiku-4-5*': row(1, 5, 0.1, 1.25, 2),
};
