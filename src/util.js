import os from 'node:os';
import path from 'node:path';
import { redactSecrets } from './redact.js';

/** Placeholder expansion for argv templates: `{model}`, `{prompt}`, `{system}`, `{session}`. */
export function expandTemplate(token, vars) {
  return token.replace(/\{(\w+)\}/g, (all, key) => (key in vars ? String(vars[key]) : all));
}

export function joinArgs(templates, vars) {
  const out = [];
  for (const t of templates) {
    if (typeof t === 'string') {
      // A placeholder that is the whole token keeps its value as one argv entry,
      // so a 40 KB prompt never gets word-split.
      if (/^\{(\w+)\}$/.test(t)) {
        const v = vars[t.slice(1, -1)];
        if (v !== undefined && v !== null && v !== '') out.push(String(v));
        continue;
      }
      out.push(expandTemplate(t, vars));
      continue;
    }
    // A nested group is a flag + its value: it is included only when every
    // placeholder inside it resolves to something, so `["-m","{model}"]` never
    // leaves a bare `-m` behind for a model-less request — and
    // `["-c","model_reasoning_effort=\"{effort}\""]` no empty setting for an effort-less one.
    const parts = [];
    let skip = false;
    const empty = (v) => v === undefined || v === null || v === '';
    for (const g of t) {
      if (typeof g === 'string' && /^\{(\w+)\}$/.test(g)) {
        const v = vars[g.slice(1, -1)];
        if (empty(v)) {
          skip = true;
          break;
        }
        parts.push(String(v));
      } else {
        // A placeholder inside a token: the group goes when it has no value, as a whole-token one does.
        if ([...String(g).matchAll(/\{(\w+)\}/g)].some(([, k]) => empty(vars[k]))) {
          skip = true;
          break;
        }
        parts.push(expandTemplate(String(g), vars));
      }
    }
    if (!skip) out.push(...parts);
  }
  return out;
}

/**
 * Flatten an OpenAI-style message list into one prompt for CLIs that take a single
 * string. The system turn is hoisted out when `systemVar` is set, so the adapter can
 * pass it through a dedicated flag instead of burying it in the user text.
 */
export function flattenMessages(messages, { systemSeparator = '\n\n', roleSeparator = '\n\n', includeSystem = true, media } = {}) {
  const sys = [];
  const turns = [];
  for (const m of messages || []) {
    const text = contentToText(m.content, { media });
    if (!text) continue;
    if (m.role === 'system') {
      if (includeSystem) sys.push(text);
      continue;
    }
    const who = m.role === 'assistant' ? 'Assistant' : m.role === 'tool' ? 'Tool output' : 'User';
    turns.push(`${who}: ${text}`);
  }
  const prompt = turns.join(roleSeparator);
  return { system: sys.join(systemSeparator), prompt, history: prompt };
}

export const IMAGE_OMITTED = '[image omitted by keysmith]';

/** How a message names each kind of media: `[PDF omitted by keysmith]`. `file` is one whose kind its part does not say. */
const KIND_NAMES = { image: 'image', pdf: 'PDF', audio: 'audio', video: 'video', file: 'file' };

export function kindName(kind) {
  return KIND_NAMES[kind] || 'file';
}

/** The text that stands where media was, for a reader that cannot take it. */
export function mediaOmitted(kind) {
  return `[${kindName(kind)} omitted by keysmith]`;
}

/**
 * A media part as a client sends one: an image (OpenAI Chat `image_url`, Anthropic `image`,
 * Responses `input_image`), audio (`input_audio`), video (`video_url`, the shape vLLM and
 * OpenRouter take), a file (Chat `file`, Responses `input_file`) or an Anthropic `document`
 * with bytes in it. A `document` whose source is text is no media: it reads as it always has
 * (test/fixtures/flatten-snapshot.json).
 */
export function isMediaPart(part) {
  if (!part || typeof part !== 'object') return false;
  if (part.type === 'document') return part.source?.type !== 'text' && part.source?.type !== 'content';
  return ['image_url', 'image', 'input_image', 'input_audio', 'video_url', 'file', 'input_file'].includes(part.type);
}

/**
 * The kind a media part says it is, before a byte of it is read: what its type names, or for a
 * file, its data: URL's type or its file name. `file` when neither tells. The bytes decide in the
 * end (src/media.js): this is what a label says, and what a reader that takes no such kind skips.
 */
export function declaredKind(part) {
  switch (part?.type) {
    case 'image_url':
    case 'image':
    case 'input_image':
      return 'image';
    case 'input_audio':
      return 'audio';
    case 'video_url':
      return 'video';
    case 'document':
      return 'pdf';
    default: {
      const f = part?.type === 'file' ? part.file || {} : part || {};
      const type = (/^data:([^;,]*)/i.exec(String(f.file_data ?? ''))?.[1] || '').toLowerCase();
      if (type === 'application/pdf' || /\.pdf$/i.test(String(f.filename ?? f.file_url ?? ''))) return 'pdf';
      return ['image', 'audio', 'video'].find((k) => type.startsWith(`${k}/`)) || 'file';
    }
  }
}

/**
 * Message content as text. Media becomes `media(part)`: a label naming its kind by default
 * (`[image omitted by keysmith]`), because a request that arrives as text must say what it lost;
 * an adapter that takes media (src/media.js) marks the spot instead and puts it back there.
 */
export function contentToText(content, { media = (part) => mediaOmitted(declaredKind(part)) } = {}) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (!part || typeof part !== 'object') return '';
        if (part.type === 'text' || part.type === 'input_text' || part.type === 'output_text') return part.text || '';
        if (isMediaPart(part)) return media(part);
        return part.text || '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return String(content);
}

/**
 * A message as the protocol faces build it (`{ role, content }`, the content as text), with its
 * original parts kept as `msg.parts` when they hold media: what an adapter that takes media reads
 * (src/media.js). Every other reader goes on reading the text. Not enumerable, so the message
 * still reads, compares and serializes as `{ role, content }`, and a copy of it is text alone.
 */
export function keepMediaParts(msg, content) {
  if (Array.isArray(content) && content.some(isMediaPart)) Object.defineProperty(msg, 'parts', { value: content, enumerable: false });
  return msg;
}

export class LlmError extends Error {
  constructor(message, { status = 502, type = 'upstream_error', provider = null, retriable = false } = {}) {
    super(message);
    this.name = 'LlmError';
    this.status = status;
    this.type = type;
    this.provider = provider;
    this.retriable = retriable;
  }
}

/**
 * Of a route's failures, the one to answer with. Failover moves on after a 429 or a 503,
 * and the leg it moves on to can refuse for a reason of its own (a 400, a missing key); that
 * refusal only happened because the first leg backed off, so a client that sees it gives up
 * where it should have waited. A 429/503 from an earlier leg is kept over a later leg's
 * other refusal; otherwise the latest failure is the answer.
 */
export function routeError(kept, next) {
  const backoff = (e) => e?.status === 429 || e?.status === 503;
  return kept && backoff(kept) && !backoff(next) ? kept : next;
}

export function nowMs() {
  return Number(process.hrtime.bigint() / 1000n) / 1000;
}

export function rel(p) {
  return p.startsWith(os.homedir()) ? '~' + p.slice(os.homedir().length) : path.relative(process.cwd(), p) || '.';
}

/**
 * One line of at most `n` characters, for a log line or an error message. Redacted before it
 * is cut: a cut through the middle of a key leaves `ks_` and 31 of its 32 characters, which
 * is neither the key nor anything shaped like one, and is the key in 64 guesses.
 */
export function truncate(s, n = 160) {
  s = redactSecrets(String(s ?? '')).replace(/\s+/g, ' ');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/**
 * The last `n` characters of a growing buffer (a child's stderr), starting at a token
 * boundary. A plain `slice(-n)` can start inside a key and keep its 32 random characters
 * without the `ks_` that marks them as one.
 */
export function keepTail(s, n) {
  s = String(s ?? '');
  if (s.length <= n) return s;
  return '…' + s.slice(-n).replace(/^[A-Za-z0-9_-]+/, '');
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Environment for a nested agent run.
 *
 * When keysmith is started from inside a coding agent, that agent's marker variables
 * are inherited and child CLIs change behaviour because they believe they are an SDK
 * subprocess — Qoder CLI exits 42, others print an entrypoint error. Those markers say
 * "who launched me", never "what the user wants", so they are dropped here.
 */
const NESTED_AGENT_MARKERS = [
  'QODER_AGENT_SDK_ENTRYPOINT',
  'QODER_AGENT_SDK_VERSION',
  'QODER_SDK_AUTH_PAYLOAD_FILE',
  'QODER_SESSION_TYPE',
  'CLAUDE_AGENT_SDK_ENTRYPOINT',
  'CLAUDE_CODE_ENTRYPOINT',
];

export function agentCleanEnv(base = process.env) {
  const env = { ...base };
  for (const k of NESTED_AGENT_MARKERS) delete env[k];
  return env;
}

/** Simple counting semaphore for adapters that must not run more than N processes. */
export class Semaphore {
  constructor(max = Infinity) {
    this.max = max;
    this.active = 0;
    this.waiters = [];
  }
  async acquire() {
    if (this.active < this.max) {
      this.active++;
      return () => this._release();
    }
    await new Promise((resolve) => this.waiters.push(resolve));
    this.active++;
    return () => this._release();
  }
  _release() {
    this.active--;
    const next = this.waiters.shift();
    if (next) next();
  }
}
