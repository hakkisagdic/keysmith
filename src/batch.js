/**
 * Batch jobs: work that can wait, sent to an upstream's Message Batches API (anthropic wire
 * only) at half the live price.
 *
 * Facts below were read from Anthropic's documentation on 2026-11-17 (batch-processing,
 * prompt-caching), not from memory:
 *  - POST {base}/messages/batches { requests: [{ custom_id, params }] }; at most 100,000
 *    requests or 256 MB; max_tokens >= 1 (0, cache pre-warming, is not allowed in a batch);
 *  - GET {base}/messages/batches/{id}: processing_status in_progress | canceling | ended,
 *    request_counts { processing, succeeded, errored, canceled, expired };
 *  - GET {base}/messages/batches/{id}/results: one JSON line per request, result.type is
 *    succeeded | errored | canceled | expired; only `succeeded` is billed; results stay 29 days;
 *  - POST {base}/messages/batches/{id}/cancel;
 *  - every token is billed at 50% of the live price, cache hits are best-effort and the
 *    discounts stack; a 1-hour cache write costs 2x the base input rate;
 *  - nothing is said about promotional credit: the first small job shows it (usage rows
 *    carry the real cost either way).
 * Everything is off unless `batch.enabled` is true in the config.
 */
import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from './config.js';
import { HttpAdapter } from './http-adapter.js';
import { prepareAdapter } from './gateway.js';
import { parseKeys, requestDecision } from './keys.js';
import { matchPrice, batchFactorOf, cacheWrite1hRate, roundUsd, fmtUsd, UsageLog } from './usage.js';
import { headerSecrets, redactSecrets, registerSecrets } from './redact.js';

export const MAX_REQUESTS = 100_000;
export const MAX_BYTES = 256 * 1024 * 1024;
export const BATCH_FACTOR = 0.5;
const CHARS_PER_TOKEN = 3.5; // pessimistic on purpose: an estimate below the truth lets a cap be passed
const TERMINAL = new Set(['ended', 'expired', 'canceled']);

export class BatchError extends Error {}

export function batchEnabled(cfg) {
  return cfg?.batch?.enabled === true;
}

export function batchDir() {
  return path.join(dataDir(), 'batch');
}

const safeName = (name) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(String(name || ''));
const jobFile = (name) => path.join(batchDir(), `${name}.json`);

export function loadJob(name) {
  if (!safeName(name)) throw new BatchError(`"${name}" is not a job name (letters, digits, . _ -; at most 64)`);
  try {
    return JSON.parse(fs.readFileSync(jobFile(name), 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') throw new BatchError(`no batch job "${name}"`);
    throw new BatchError(`batch job "${name}" is unreadable: ${e.code || e.message}`);
  }
}

export function listJobs() {
  let names = [];
  try { names = fs.readdirSync(batchDir()).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)); } catch { return []; }
  const jobs = [];
  for (const n of names.sort()) {
    try { jobs.push(loadJob(n)); } catch { /* skip unreadable */ }
  }
  return jobs;
}

function saveJob(job, { exclusive = false } = {}) {
  fs.mkdirSync(batchDir(), { recursive: true, mode: 0o700 });
  const file = jobFile(job.name);
  if (exclusive) {
    fs.writeFileSync(file, JSON.stringify(job, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  } else {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(job, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, file);
  }
}

/** Parse the input JSONL: { custom_id, params: { model, max_tokens, messages, ... } } per line. */
export function readRequests(file) {
  let stat;
  try { stat = fs.statSync(file); } catch (e) { throw new BatchError(`${file}: ${e.code || e.message}`); }
  if (stat.size > MAX_BYTES) throw new BatchError(`${file} is ${stat.size} bytes: a batch holds at most ${MAX_BYTES} (256 MB)`);
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const requests = [];
  const seen = new Set();
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    let r;
    try { r = JSON.parse(line); } catch { throw new BatchError(`${file} line ${i + 1}: not JSON`); }
    const at = `${file} line ${i + 1}`;
    if (!r || typeof r !== 'object' || typeof r.custom_id !== 'string' || !r.custom_id) throw new BatchError(`${at}: custom_id (a string) is required`);
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(r.custom_id)) throw new BatchError(`${at}: custom_id must match [a-zA-Z0-9_-]{1,64}`);
    if (seen.has(r.custom_id)) throw new BatchError(`${at}: custom_id "${r.custom_id}" is used twice`);
    seen.add(r.custom_id);
    const p = r.params;
    if (!p || typeof p !== 'object' || typeof p.model !== 'string' || !p.model) throw new BatchError(`${at}: params.model is required`);
    if (!Array.isArray(p.messages) || !p.messages.length) throw new BatchError(`${at}: params.messages is required`);
    if (!Number.isInteger(p.max_tokens) || p.max_tokens < 1) throw new BatchError(`${at}: params.max_tokens must be a whole number of at least 1 (0 is not allowed in a batch)`);
    requests.push({ custom_id: r.custom_id, params: p });
  });
  if (!requests.length) throw new BatchError(`${file} holds no request`);
  if (requests.length > MAX_REQUESTS) throw new BatchError(`${file} holds ${requests.length} requests: a batch holds at most ${MAX_REQUESTS}`);
  return requests;
}

/** The fewest tokens a cache entry needs, by model (prompt-caching docs, 2026-11-17); unknown models get the highest. */
export function cacheMinTokens(model) {
  const m = String(model || '');
  if (/(fable|mythos-5|opus-5|sonnet-5-5|haiku-5-5|opus-5-5|sonnet-5.5|haiku-5.5|opus-5.5)/.test(m)) return 512;
  if (/(opus-4-7|opus-4\.7)/.test(m)) return 2048;
  if (/(opus-4-8|sonnet-5|sonnet-4|opus-4-1|opus-4\.8)/.test(m) && !/haiku/.test(m)) return 1024;
  return 4096;
}

const hasCacheControl = (v) => JSON.stringify(v).includes('"cache_control"');
const tokensOf = (v) => Math.ceil(JSON.stringify(v ?? '').length / CHARS_PER_TOKEN);

/**
 * `--cache`: mark the system prompt once, 1-hour TTL, only where it is long enough to be cached
 * and nothing in the request carries a mark already. Returns the (possibly new) request and
 * the tokens it expects to write.
 */
export function withCache(req) {
  const p = req.params;
  if (p.system == null || hasCacheControl(p)) return { req, cachedTokens: 0 };
  if (tokensOf(p.system) < cacheMinTokens(p.model)) return { req, cachedTokens: 0 };
  const blocks = typeof p.system === 'string' ? [{ type: 'text', text: p.system }] : p.system.map((b) => ({ ...b }));
  if (!blocks.length) return { req, cachedTokens: 0 };
  blocks[blocks.length - 1].cache_control = { type: 'ephemeral', ttl: '1h' };
  return { req: { ...req, params: { ...p, system: blocks } }, cachedTokens: tokensOf(p.system) };
}

export function halfRates(rates) {
  const out = {};
  const f = batchFactorOf(rates);
  for (const k of ['input', 'output', 'cacheRead', 'cacheWrite']) out[k] = (Number(rates[k]) || 0) * f;
  out.cacheWrite1h = cacheWrite1hRate(rates) * f;
  return out;
}

/**
 * The most a batch can cost, before it is sent: every input token at the batch input rate
 * (a cached system prompt at the 1-hour write rate), every request answering with its
 * full max_tokens. Cache reads would only lower it.
 */
export function estimateUsd(requests, pricing, adapter, cachedTokens = new Map()) {
  let usd = 0;
  for (const r of requests) {
    const p = r.params;
    const rates = matchPrice(pricing, adapter.id, p.model, { upstreamModel: adapter.upstreamModel(p.model) });
    if (!rates) throw new BatchError(`no price for ${adapter.id}/${p.model} in the price table: a cap cannot be checked without one (add it under "pricing")`);
    const half = halfRates(rates);
    const total = tokensOf({ system: p.system, messages: p.messages, tools: p.tools });
    // A cache_control the user wrote is billed as a write (2x at most) and we cannot tell how much it
    // covers: every input token of that request is counted at the highest write rate.
    const ownMark = !cachedTokens.has(r.custom_id) && hasCacheControl(p);
    const cached = ownMark ? total : Math.min(total, cachedTokens.get(r.custom_id) || 0);
    usd += ((total - cached) * half.input + cached * half.cacheWrite1h + p.max_tokens * half.output) / 1_000_000;
  }
  return roundUsd(usd);
}

/** Cost of one succeeded result at half the live price, 1-hour cache writes at the table's 1-hour rate (2x input without one). */
export function resultUsd(usage, rates) {
  const u = usage || {};
  const half = halfRates(rates);
  const cacheRead = Number(u.cache_read_input_tokens) || 0;
  const write = Number(u.cache_creation_input_tokens) || 0;
  const write1h = Math.min(write, Number(u.cache_creation?.ephemeral_1h_input_tokens) || 0);
  const write5m = write - write1h;
  const input = Number(u.input_tokens) || 0;
  const usd =
    (input * half.input + (Number(u.output_tokens) || 0) * half.output + cacheRead * half.cacheRead + write5m * half.cacheWrite + write1h * half.cacheWrite1h) /
    1_000_000;
  return roundUsd(usd);
}

/** The adapter an id names, only when it can run a batch. */
export function batchAdapter(cfg, id) {
  const raw = cfg.adapters?.[id];
  if (!raw || typeof raw !== 'object') throw new BatchError(`no adapter "${id}"`);
  if (raw.kind === 'cli' || raw.bin || raw.wire !== 'anthropic') {
    throw new BatchError(`adapter "${id}" has no batch interface: only an adapter on the anthropic wire can take a batch (Gemini and OpenAI batches are not built)`);
  }
  let prepared;
  try { prepared = prepareAdapter(id, raw); } catch (e) { throw new BatchError(`adapter "${id}": ${e.message}`); }
  registerSecrets([prepared._apiKey]);
  registerSecrets(headerSecrets(prepared.headers));
  registerSecrets(headerSecrets(prepared.mediaHeaders));
  return new HttpAdapter(id, prepared);
}

/** The key entry `--key` names (fp:<8 hex>, the 8 hex, or its label), or null when none was given. */
export function callerKey(cfg, ref) {
  if (ref == null || ref === true || ref === '') return null;
  const { entries } = parseKeys(cfg.auth?.keys);
  const s = String(ref);
  const m = s.match(/^(?:fp:)?([0-9a-fA-F]{8})$/);
  const hit = entries.filter((e) => (m && e.fp === m[1].toLowerCase()) || (e.label && e.label === s));
  if (hit.length !== 1) throw new BatchError(`--key "${s}" names ${hit.length ? 'more than one key' : 'no key'}: use fp:<8 hex> or a label from \`keysmith key list\``);
  return hit[0];
}

function todaysRequests(fp) {
  const day = new Date();
  const start = new Date(day.getFullYear(), day.getMonth(), day.getDate()).toISOString();
  const startMs = Date.parse(start);
  let n = 0;
  try {
    const groups = new UsageLog().query({ by: ['key'], since: start }).groups || [];
    n = groups.filter((g) => g.key === `fp:${fp}`).reduce((a, g) => a + (g.requests || 0), 0);
  } catch { /* no log yet */ }
  for (const j of listJobs()) {
    // Jobs whose usage rows are not written yet are not in the log: count them, ended or not.
    if (j.key === `fp:${fp}` && !j.usageRecorded && Date.parse(j.createdAt) >= startMs) n += j.requests;
  }
  return n;
}

async function call(adapter, method, suffix, body) {
  const headers = { ...(adapter.headers || {}), ...adapter.authHeaders(), accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  let res;
  try {
    res = await fetch(adapter.route(suffix), { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(adapter.timeoutMs || 120_000) });
  } catch (e) {
    throw new BatchError(`${adapter.id}: ${method} ${suffix}: ${e.message}`);
  }
  const text = await res.text();
  if (!res.ok) throw new BatchError(`${adapter.id}: ${method} ${suffix} answered ${res.status}: ${redactSecrets(text.slice(0, 300))}`);
  return text;
}

/** Check everything and, if it all holds, send. Nothing leaves this process before the last check. */
export async function submit(cfg, { name, file, adapterId, capUsd, keyRef = null, cache = false, dryRun = false }) {
  if (!batchEnabled(cfg)) throw new BatchError('batch is off (set batch.enabled to true in the config)');
  if (!safeName(name)) throw new BatchError(`"${name}" is not a job name (letters, digits, . _ -; at most 64)`);
  if (!Number.isFinite(capUsd) || capUsd <= 0) throw new BatchError('--cap-usd is required and must be above 0');
  const adapter = batchAdapter(cfg, adapterId);
  if (!adapter._apiKey) throw new BatchError(`adapter "${adapterId}" has no credentials`);
  let requests = readRequests(file);
  const key = callerKey(cfg, keyRef);
  if (key) {
    for (const model of new Set(requests.map((r) => r.params.model))) {
      const d = requestDecision(key.scope, adapterId, adapter, model);
      if (!d.ok) throw new BatchError(`refused for key fp:${key.fp}${key.label ? ` (${key.label})` : ''}: ${d.reason}`);
    }
    if (key.perDay != null && todaysRequests(key.fp) + requests.length > key.perDay) {
      throw new BatchError(`refused for key fp:${key.fp}: ${requests.length} more requests would pass its daily cap of ${key.perDay}`);
    }
  }
  const cached = new Map();
  if (cache) {
    requests = requests.map((r) => {
      const w = withCache(r);
      if (w.cachedTokens) cached.set(r.custom_id, w.cachedTokens);
      return w.req;
    });
  }
  const estimate = estimateUsd(requests, cfg.pricing, adapter, cached);
  if (estimate > capUsd) {
    throw new BatchError(`refused: the estimate ${fmtUsd(estimate)} is above the cap ${fmtUsd(capUsd)} (nothing was sent)`);
  }
  const body = { requests };
  if (Buffer.byteLength(JSON.stringify(body)) > MAX_BYTES) throw new BatchError('the batch would be over 256 MB');
  const job = {
    name, adapter: adapterId, input: path.resolve(file), key: key ? `fp:${key.fp}` : null, label: key?.label || null,
    requests: requests.length, models: [...new Set(requests.map((r) => r.params.model))], cache: !!cache,
    estimateUsd: estimate, capUsd, status: 'submitting', createdAt: new Date().toISOString(), id: null,
  };
  if (dryRun) return { ...job, status: 'dry-run', dryRun: true };
  // The file is created first and exclusively: a name sends once, however many times it is asked.
  try { saveJob(job, { exclusive: true }); } catch (e) {
    if (e.code === 'EEXIST') throw new BatchError(`job "${name}" exists already (nothing was sent): pick another name`);
    throw e;
  }
  let reply;
  try {
    reply = JSON.parse(await call(adapter, 'POST', '/messages/batches', body));
  } catch (e) {
    job.status = 'failed';
    job.error = redactSecrets(e.message);
    saveJob(job);
    throw e;
  }
  job.id = reply.id;
  job.status = reply.processing_status === 'ended' ? 'ended' : 'in_progress';
  job.counts = reply.request_counts || null;
  job.polledAt = new Date().toISOString();
  saveJob(job);
  return job;
}

/** Ask the upstream where a job stands and keep it. */
export async function refresh(cfg, job) {
  if (TERMINAL.has(job.status) || job.status === 'failed' || !job.id) return job;
  const adapter = batchAdapter(cfg, job.adapter);
  const r = JSON.parse(await call(adapter, 'GET', `/messages/batches/${encodeURIComponent(job.id)}`));
  job.counts = r.request_counts || job.counts;
  job.polledAt = new Date().toISOString();
  if (r.processing_status === 'ended') {
    const c = job.counts || {};
    job.status = job.cancelRequested ? 'canceled' : (c.expired > 0 && !c.succeeded && !c.errored) ? 'expired' : 'ended';
  } else {
    job.status = r.processing_status === 'canceling' ? 'canceling' : 'in_progress';
  }
  saveJob(job);
  return job;
}

export async function cancel(cfg, job) {
  if (!job.id) throw new BatchError(`job "${job.name}" has no upstream id`);
  if (TERMINAL.has(job.status)) throw new BatchError(`job "${job.name}" is ${job.status} already`);
  const adapter = batchAdapter(cfg, job.adapter);
  await call(adapter, 'POST', `/messages/batches/${encodeURIComponent(job.id)}/cancel`);
  job.cancelRequested = true;
  job.status = 'canceling';
  saveJob(job);
  return refresh(cfg, job);
}

/** Download the results beside the input, write one usage row per request (once), report the real cost. */
export async function fetchResults(cfg, job) {
  await refresh(cfg, job);
  if (!TERMINAL.has(job.status)) throw new BatchError(`job "${job.name}" is ${job.status}: results come when it has ended`);
  const adapter = batchAdapter(cfg, job.adapter);
  const text = await call(adapter, 'GET', `/messages/batches/${encodeURIComponent(job.id)}/results`);
  const out = job.input.replace(/(\.jsonl)?$/, '') + '.results.jsonl';
  const lines = text.split('\n').filter((l) => l.trim());
  const written = [];
  let usd = 0;
  const rows = [];
  for (const line of lines) {
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    const type = r?.result?.type;
    const ok = type === 'succeeded';
    written.push(JSON.stringify(ok ? r : { ...r, failed: true }));
    const msg = ok ? r.result.message : null;
    const u = msg?.usage || {};
    const model = msg?.model || null;
    const rates = ok ? matchPrice(cfg.pricing, job.adapter, model || job.models[0], { upstreamModel: model }) : null;
    const cost = ok ? (rates ? resultUsd(u, rates) : null) : 0;
    if (cost) usd += cost;
    const cr = Number(u.cache_read_input_tokens) || 0;
    const cw = Number(u.cache_creation_input_tokens) || 0;
    rows.push({
      id: `${job.name}:${r?.custom_id}`,
      row: {
        face: 'batch', batch: true, adapter: job.adapter, kind: 'http', model, ...(job.key ? { key: job.key } : {}), ...(job.label ? { label: job.label } : {}),
        tag: `batch/${job.name}`.slice(0, 128), requests: 1, status: ok ? 'ok' : type === 'errored' ? 'error' : type || 'error',
        usage: { input: (Number(u.input_tokens) || 0) + cr + cw, output: Number(u.output_tokens) || 0, cacheRead: cr, cacheWrite: cw },
        cost: { usd: cost, basis: ok && rates ? 'metered' : 'unpriced', batch: true },
      },
    });
  }
  const tmp = `${out}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, written.join('\n') + (written.length ? '\n' : ''), { mode: 0o600 });
  fs.renameSync(tmp, out);
  if (!job.usageRecorded) {
    const log = new UsageLog(undefined, { pricing: cfg.pricing });
    for (const { row } of rows) log.record(row);
    job.usageRecorded = true;
  }
  job.resultsFile = out;
  job.actualUsd = roundUsd(usd);
  saveJob(job);
  return { job, file: out, count: written.length, usd: job.actualUsd };
}

export function describeJob(j) {
  const c = j.counts || {};
  const counts = j.counts ? `  succeeded ${c.succeeded ?? 0}, errored ${c.errored ?? 0}, expired ${c.expired ?? 0}, canceled ${c.canceled ?? 0}, processing ${c.processing ?? 0}` : '';
  return `${j.name}  ${j.status}  ${j.adapter}  ${j.requests} requests  estimate ${fmtUsd(j.estimateUsd)} (cap ${fmtUsd(j.capUsd)})${j.actualUsd != null ? `  actual ${fmtUsd(j.actualUsd)}` : ''}${counts}`;
}
