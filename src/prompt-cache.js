/**
 * Prompt caching on the Anthropic Messages wire: `planCache(body, setting, model)` puts at most
 * three `cache_control` breakpoints on a request body that has none (last tool, last system
 * block, the last block before the final turn) and touches nothing else — order and text stay
 * as they were. Off unless the adapter says so (`promptCache`): { mode, ttl, minTokens }.
 *
 *   mode: "off" (default) | "dry-run" (body untouched, the plan reported) | "on"
 *   ttl:  "5m" (default; the field is left out) | "1h" (written as ttl: "1h")
 *   minTokens: a prefix shorter than this (estimated, ~4 chars a token) gets no breakpoint
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export const MODES = ['off', 'dry-run', 'on'];
export const TTLS = ['5m', '1h'];
const MAX_BREAKPOINTS = 4; // the API's limit, the client's own counted

/**
 * Minimum cacheable prompt length per model, read from Anthropic's prompt caching page
 * ("Cache limitations"): https://platform.claude.com/docs/en/build-with-claude/prompt-caching
 * Read on 2026-11-17 (Claude API, Claude Platform on AWS, Google Cloud, Microsoft Foundry; Bedrock has its own).
 * First match wins, so a more specific pattern sits above a looser one. A model that is not
 * here gets the largest minimum in the table (a mark that is ignored still costs the write
 * price), and `promptCache.minTokens` overrides the table.
 */
const V = '[-.]'; // 4-5, 4.5
export const MIN_TOKENS_TABLE = [
  [new RegExp(`(fable|mythos)${V}5${V}[12]\\b`, 'i'), 512],
  [new RegExp(`(fable|mythos)${V}5(?!${V}\\d(?!\\d))`, 'i'), 512],
  [new RegExp(`opus${V}5(?!${V}\\d(?!\\d))`, 'i'), 512],
  [new RegExp(`opus${V}5${V}5(?!\\d)`, 'i'), 512],
  [new RegExp(`sonnet${V}5${V}5(?!\\d)`, 'i'), 512],
  [new RegExp(`haiku${V}5${V}5(?!\\d)`, 'i'), 512],
  [/mythos[-.]preview/i, 2048],
  [new RegExp(`opus${V}4${V}7(?!\\d)`, 'i'), 2048],
  [new RegExp(`opus${V}4${V}[56](?!\\d)`, 'i'), 4096],
  [new RegExp(`haiku${V}4${V}5(?!\\d)`, 'i'), 4096],
  [new RegExp(`opus${V}4${V}8(?!\\d)`, 'i'), 1024],
  [new RegExp(`opus${V}4${V}1(?!\\d)`, 'i'), 1024],
  [new RegExp(`sonnet${V}5(?!${V}\\d(?!\\d))`, 'i'), 1024],
  [new RegExp(`sonnet${V}4${V}[56](?!\\d)`, 'i'), 1024],
  [new RegExp(`opus${V}4(?!${V}\\d(?!\\d))`, 'i'), 1024],
  [new RegExp(`sonnet${V}4(?!${V}\\d(?!\\d))`, 'i'), 1024],
];
export const UNKNOWN_MODEL_MIN_TOKENS = Math.max(...MIN_TOKENS_TABLE.map(([, n]) => n));

/** A load error for a malformed `promptCache`, else the normalised setting (null = off). */
export function checkPromptCache(id, cfg) {
  if (cfg == null) return null;
  const bad = (why) => new Error(`adapter "${id}": promptCache ${why} — e.g. {"mode": "on", "ttl": "5m"}`);
  if (typeof cfg !== 'object' || Array.isArray(cfg)) throw bad('must be an object');
  const mode = cfg.mode ?? 'off';
  if (!MODES.includes(mode)) throw bad(`mode must be one of ${MODES.join(', ')}`);
  const ttl = cfg.ttl ?? '5m';
  if (!TTLS.includes(ttl)) throw bad('ttl must be "5m" or "1h"');
  if (cfg.minTokens != null && !(Number.isInteger(cfg.minTokens) && cfg.minTokens >= 0)) throw bad('minTokens must be a whole number');
  for (const k of Object.keys(cfg)) if (!['mode', 'ttl', 'minTokens'].includes(k)) throw bad(`has an unknown field "${k}"`);
  if (mode === 'off') return null;
  return { mode, ttl, minTokens: cfg.minTokens ?? null };
}

function hasCacheControl(v) {
  if (Array.isArray(v)) return v.some(hasCacheControl);
  if (v && typeof v === 'object') {
    if (Object.hasOwn(v, 'cache_control')) return true;
    return Object.values(v).some(hasCacheControl);
  }
  return false;
}

const estTokens = (v) => Math.ceil((typeof v === 'string' ? v : JSON.stringify(v ?? '')).length / 4);

export function minFor(setting, model) {
  if (setting?.minTokens != null) return setting.minTokens;
  const name = String(model || '');
  for (const [re, n] of MIN_TOKENS_TABLE) if (re.test(name)) return n;
  return UNKNOWN_MODEL_MIN_TOKENS;
}

/** A content block that may carry a breakpoint: not thinking, not an empty text. */
function markable(b) {
  if (!b || typeof b !== 'object' || typeof b.type !== 'string') return false;
  if (b.type === 'thinking' || b.type === 'redacted_thinking') return false;
  if (b.type === 'text' && !b.text) return false;
  return true;
}

/**
 * Where a dry-run plan goes so the usage row of the same request can carry it: the server runs
 * each request inside `cachePlanScope.run({})`; the adapter writes `store.plan`, the row reads it.
 */
export const cachePlanScope = new AsyncLocalStorage();

/** `{ body, report }`; `body` is the input itself unless breakpoints were added. */
export function planCache(body, setting, model) {
  if (!setting || setting.mode === 'off' || !body || typeof body !== 'object') return { body, report: { mode: 'off', breakpoints: 0, estTokens: 0 } };
  const report = { mode: setting.mode, ttl: setting.ttl, breakpoints: 0, estTokens: 0 };
  if (hasCacheControl(body)) return { body, report: { ...report, skipped: 'client-set' } };
  const min = minFor(setting, model);
  const mark = { type: 'ephemeral', ...(setting.ttl === '1h' ? { ttl: '1h' } : {}) };
  const out = structuredClone(body);
  let prefix = 0;
  let n = 0;
  const add = (block, tokens) => {
    if (n >= MAX_BREAKPOINTS - 1 || tokens < min) return;
    block.cache_control = { ...mark };
    n++;
    report.estTokens = tokens;
  };

  if (Array.isArray(out.tools) && out.tools.length) {
    prefix += estTokens(out.tools);
    add(out.tools[out.tools.length - 1], prefix);
  }
  if (typeof out.system === 'string' && out.system) {
    prefix += estTokens(out.system);
    const blocks = [{ type: 'text', text: out.system }];
    const before = n;
    add(blocks[0], prefix);
    if (n > before) out.system = blocks;
  } else if (Array.isArray(out.system) && out.system.length) {
    prefix += estTokens(out.system);
    const last = out.system[out.system.length - 1];
    if (markable(last)) add(last, prefix);
  }
  const msgs = Array.isArray(out.messages) ? out.messages : [];
  if (msgs.length >= 2) {
    const upto = msgs.slice(0, -1); // the final turn is never part of the stable prefix
    prefix += estTokens(upto);
    const m = upto[upto.length - 1];
    if (typeof m.content === 'string' && m.content) {
      const blocks = [{ type: 'text', text: m.content }];
      const before = n;
      add(blocks[0], prefix);
      if (n > before) m.content = blocks;
    } else if (Array.isArray(m.content) && m.content.length) {
      const last = m.content[m.content.length - 1];
      if (markable(last)) add(last, prefix);
    }
  }
  report.breakpoints = n;
  if (n === 0 || setting.mode === 'dry-run') return { body, report };
  return { body: out, report };
}
