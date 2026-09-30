import os from 'node:os';
import path from 'node:path';

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
    // leaves a bare `-m` behind for a model-less request.
    const parts = [];
    let skip = false;
    for (const g of t) {
      if (typeof g === 'string' && /^\{(\w+)\}$/.test(g)) {
        const v = vars[g.slice(1, -1)];
        if (v === undefined || v === null || v === '') {
          skip = true;
          break;
        }
        parts.push(String(v));
      } else {
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
export function flattenMessages(messages, { systemSeparator = '\n\n', roleSeparator = '\n\n', includeSystem = true } = {}) {
  const sys = [];
  const turns = [];
  for (const m of messages || []) {
    const text = contentToText(m.content);
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

export function contentToText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (!part || typeof part !== 'object') return '';
        if (part.type === 'text' || part.type === 'input_text' || part.type === 'output_text') return part.text || '';
        if (part.type === 'image_url' || part.type === 'image') return '[image omitted by keysmith]';
        return part.text || '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return String(content);
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

export function nowMs() {
  return Number(process.hrtime.bigint() / 1000n) / 1000;
}

export function rel(p) {
  return p.startsWith(os.homedir()) ? '~' + p.slice(os.homedir().length) : path.relative(process.cwd(), p) || '.';
}

export function truncate(s, n = 160) {
  s = String(s ?? '').replace(/\s+/g, ' ');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
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
