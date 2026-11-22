/**
 * Pure structured-output specification, linear JSON healing, and schema enforcement.
 *
 * No I/O, no external dependencies, no regex backtracking: reuses `validate()` from
 * `./tools/jsonschema.js`. Bounded to `MAX_STRUCTURED_CHARS` (4 MB) so oversized
 * non-JSON responses fail immediately without scanning. Error reasons never include
 * the model's answer text or schema literal values (`enum`, `const`).
 */

import { validate } from './tools/jsonschema.js';

export const MAX_STRUCTURED_CHARS = 4 * 1024 * 1024;
export const STRUCTURED_DEFAULTS = Object.freeze({ mode: 'off' });

const MAX_INLINE_SCHEMA_CHARS = 32 * 1024;
const MAX_NESTING = 512;
const CLOSABLE_STATES = new Set(['comma_or_end', 'key_after_comma', 'value_after_comma']);

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Resolve `structuredOutput` config block. Absent or null defaults to `mode: "off"`.
 * Invalid shapes or values stay off and return an `error` for startup logs and `keysmith doctor`.
 */
export function resolveStructuredConfig(raw) {
  const off = { mode: 'off', enabled: false };
  if (raw == null) return { ...off, error: null };
  if (!isPlainObject(raw)) {
    return {
      ...off,
      error: 'structuredOutput must be an object, e.g. {"mode": "off"} — structured-output healing stays off',
    };
  }
  const errors = [];
  if (Object.hasOwn(raw, 'mode') && raw.mode !== 'off' && raw.mode !== 'heal') {
    errors.push('structuredOutput.mode must be "off" or "heal"');
  }
  for (const k of Object.keys(raw)) {
    if (k !== 'mode') errors.push(`structuredOutput has an unknown field "${k}"`);
  }
  if (errors.length) {
    return { ...off, error: `${errors.join('; ')} — structured-output healing stays off` };
  }
  const mode = raw.mode === 'heal' ? 'heal' : 'off';
  return { mode, enabled: mode === 'heal', error: null };
}

/**
 * Extract the structured-output specification from a client request body on `chat`
 * (`response_format`) or `responses` (`text.format`). Returns null for `"text"`,
 * absent/invalid shapes, or other faces.
 */
export function extractResponseFormatSpec(body, face) {
  if (!isPlainObject(body)) return null;
  if (face === 'chat' || face === 'openai') {
    const rf = body.response_format;
    if (!isPlainObject(rf)) return null;
    if (rf.type === 'json_object') return { type: 'json_object' };
    if (rf.type === 'json_schema') {
      const js = rf.json_schema;
      if (!isPlainObject(js) || !isPlainObject(js.schema)) return null;
      return {
        type: 'json_schema',
        name: typeof js.name === 'string' && js.name ? js.name : 'output',
        strict: js.strict === true,
        schema: js.schema,
      };
    }
    return null;
  }
  if (face === 'responses') {
    const fmt = body.text?.format;
    if (!isPlainObject(fmt)) return null;
    if (fmt.type === 'json_object') return { type: 'json_object' };
    if (fmt.type === 'json_schema') {
      if (!isPlainObject(fmt.schema)) return null;
      return {
        type: 'json_schema',
        name: typeof fmt.name === 'string' && fmt.name ? fmt.name : 'output',
        strict: fmt.strict === true,
        schema: fmt.schema,
      };
    }
    return null;
  }
  return null;
}

/**
 * One short single-line instruction describing the requested JSON shape.
 */
export function structuredInstruction(spec) {
  if (!spec) return '';
  if (spec.type === 'json_schema') {
    let schemaText = '';
    try {
      const s = JSON.stringify(spec.schema);
      if (typeof s === 'string' && s.length <= MAX_INLINE_SCHEMA_CHARS) schemaText = s;
    } catch {
      schemaText = '';
    }
    return schemaText
      ? `Answer with a single valid JSON value only, with no markdown fences or surrounding prose, conforming to this JSON Schema: ${schemaText}`
      : 'Answer with a single valid JSON value only, with no markdown fences or surrounding prose, conforming to the requested JSON Schema.';
  }
  return 'Answer with a single valid JSON object only, with no markdown fences or surrounding prose.';
}

/**
 * Return a new message list carrying the structured-output instruction without mutating
 * the input array or any message object. Merges into an existing leading string system turn
 * so adapters that read only the first system message keep both instructions.
 */
export function prependStructuredInstruction(messages, spec) {
  if (!spec || !Array.isArray(messages)) return messages;
  const line = structuredInstruction(spec);
  if (!line) return messages;
  if (messages.length > 0 && messages[0]?.role === 'system' && typeof messages[0].content === 'string') {
    const first = messages[0];
    return [{ ...first, content: first.content ? `${line}\n\n${first.content}` : line }, ...messages.slice(1)];
  }
  return [{ role: 'system', content: line }, ...messages];
}

function extractFence(str) {
  const jsonFence = /```json(?=[\s{[])/i.exec(str);
  const openIdx = jsonFence ? jsonFence.index : str.indexOf('```');
  if (openIdx < 0) return null;
  let contentStart = openIdx + 3;
  if (jsonFence) {
    contentStart += 4;
  } else {
    const tag = /^[A-Za-z0-9_-]{1,32}(?=\s|$)/.exec(str.slice(contentStart, contentStart + 33));
    if (tag) contentStart += tag[0].length;
  }
  while (contentStart < str.length && isWs(str.charCodeAt(contentStart))) contentStart++;
  const closeIdx = str.lastIndexOf('```');
  const contentEnd = closeIdx > contentStart ? closeIdx : str.length;
  return str.slice(contentStart, contentEnd);
}

function isWs(c) {
  return c === 32 || c === 9 || c === 10 || c === 13;
}

function isDigit(c) {
  return c >= 48 && c <= 57;
}

function scanString(src, pos) {
  let j = pos + 1;
  while (j < src.length) {
    const c = src.charCodeAt(j);
    if (c === 92) {
      j += 2;
      continue;
    }
    if (c === 34) return { ok: true, end: j + 1 };
    j++;
  }
  return { ok: false, reason: 'unterminated string' };
}

function scanNumber(src, pos) {
  let j = pos;
  if (src.charCodeAt(j) === 45) {
    j++;
    if (j >= src.length || !isDigit(src.charCodeAt(j))) return { ok: false, reason: 'truncated number' };
  }
  if (src.charCodeAt(j) === 48) {
    j++;
    if (j < src.length && isDigit(src.charCodeAt(j))) return { ok: false, reason: 'invalid number' };
  } else if (j < src.length && src.charCodeAt(j) >= 49 && src.charCodeAt(j) <= 57) {
    j++;
    while (j < src.length && isDigit(src.charCodeAt(j))) j++;
  } else {
    return { ok: false, reason: 'invalid number' };
  }
  if (j < src.length && src.charCodeAt(j) === 46) {
    j++;
    if (j >= src.length || !isDigit(src.charCodeAt(j))) return { ok: false, reason: 'truncated number' };
    while (j < src.length && isDigit(src.charCodeAt(j))) j++;
  }
  if (j < src.length && (src.charCodeAt(j) === 101 || src.charCodeAt(j) === 69)) {
    j++;
    if (j < src.length && (src.charCodeAt(j) === 43 || src.charCodeAt(j) === 45)) j++;
    if (j >= src.length || !isDigit(src.charCodeAt(j))) return { ok: false, reason: 'truncated number' };
    while (j < src.length && isDigit(src.charCodeAt(j))) j++;
  }
  // A number directly touching EOF may be cut mid-digit; require a following delimiter or whitespace.
  if (j === src.length) return { ok: false, reason: 'truncated number' };
  return { ok: true, end: j };
}

function scanLiteral(src, pos, word) {
  if (src.startsWith(word, pos)) return { ok: true, end: pos + word.length };
  const tail = src.slice(pos, pos + word.length);
  if (pos + tail.length === src.length && word.startsWith(tail)) {
    return { ok: false, reason: 'truncated literal' };
  }
  return { ok: false, reason: 'unexpected token' };
}

function flushPendingComma(frame, out) {
  if (frame.pendingComma) {
    out.push(',');
    frame.pendingComma = false;
  }
}

function truncatedReason(frame) {
  if (frame.type === '{') {
    if (frame.expect === 'colon') return 'truncated object key';
    if (frame.expect === 'value') return 'truncated object value';
    return 'truncated object';
  }
  return 'truncated array';
}

function scanAndHeal(src) {
  let start = -1;
  for (let k = 0; k < src.length; k++) {
    const ch = src.charCodeAt(k);
    if (ch === 123 || ch === 91) {
      start = k;
      break;
    }
  }
  if (start < 0) return { ok: false, reason: 'no JSON object or array found' };

  const first = src[start];
  const stack = [{ type: first, expect: first === '{' ? 'key_or_end' : 'value_or_end', pendingComma: false }];
  const out = [first];
  let i = start + 1;

  while (i < src.length && stack.length > 0) {
    const code = src.charCodeAt(i);
    if (isWs(code)) {
      i++;
      continue;
    }
    const frame = stack[stack.length - 1];
    const ch = src[i];

    if (frame.type === '{' && (frame.expect === 'key_or_end' || frame.expect === 'key_after_comma')) {
      if (ch === '}') {
        frame.pendingComma = false;
        out.push('}');
        stack.pop();
        i++;
        if (stack.length > 0) stack[stack.length - 1].expect = 'comma_or_end';
        continue;
      }
      if (ch === '"') {
        const s = scanString(src, i);
        if (!s.ok) return s;
        flushPendingComma(frame, out);
        out.push(src.slice(i, s.end));
        frame.expect = 'colon';
        i = s.end;
        continue;
      }
      return { ok: false, reason: 'expected object key' };
    }

    if (frame.type === '{' && frame.expect === 'colon') {
      if (ch === ':') {
        out.push(':');
        frame.expect = 'value';
        i++;
        continue;
      }
      return { ok: false, reason: 'expected ":" after object key' };
    }

    if (frame.expect === 'comma_or_end') {
      const wantClose = frame.type === '{' ? '}' : ']';
      if (ch === wantClose) {
        out.push(wantClose);
        stack.pop();
        i++;
        if (stack.length > 0) stack[stack.length - 1].expect = 'comma_or_end';
        continue;
      }
      if (ch === ',') {
        frame.pendingComma = true;
        frame.expect = frame.type === '{' ? 'key_after_comma' : 'value_after_comma';
        i++;
        continue;
      }
      return { ok: false, reason: 'expected "," or closing delimiter' };
    }

    // Value position: object 'value' or array 'value_or_end' / 'value_after_comma'
    if (frame.type === '[' && (frame.expect === 'value_or_end' || frame.expect === 'value_after_comma') && ch === ']') {
      frame.pendingComma = false;
      out.push(']');
      stack.pop();
      i++;
      if (stack.length > 0) stack[stack.length - 1].expect = 'comma_or_end';
      continue;
    }

    if (ch === '{' || ch === '[') {
      if (stack.length >= MAX_NESTING) return { ok: false, reason: 'JSON nested too deeply' };
      flushPendingComma(frame, out);
      out.push(ch);
      stack.push({ type: ch, expect: ch === '{' ? 'key_or_end' : 'value_or_end', pendingComma: false });
      i++;
      continue;
    }

    if (ch === '"') {
      const s = scanString(src, i);
      if (!s.ok) return s;
      flushPendingComma(frame, out);
      out.push(src.slice(i, s.end));
      frame.expect = 'comma_or_end';
      i = s.end;
      continue;
    }

    if (ch === '-' || isDigit(code)) {
      const n = scanNumber(src, i);
      if (!n.ok) return n;
      flushPendingComma(frame, out);
      out.push(src.slice(i, n.end));
      frame.expect = 'comma_or_end';
      i = n.end;
      continue;
    }

    const literal = ch === 't' ? 'true' : ch === 'f' ? 'false' : ch === 'n' ? 'null' : null;
    if (literal) {
      const l = scanLiteral(src, i, literal);
      if (!l.ok) return l;
      flushPendingComma(frame, out);
      out.push(literal);
      frame.expect = 'comma_or_end';
      i = l.end;
      continue;
    }

    return { ok: false, reason: 'unexpected token in JSON' };
  }

  if (stack.length > 0) {
    const top = stack[stack.length - 1];
    if (!CLOSABLE_STATES.has(top.expect)) {
      return { ok: false, reason: truncatedReason(top) };
    }
    while (stack.length > 0) {
      const f = stack.pop();
      f.pendingComma = false;
      out.push(f.type === '{' ? '}' : ']');
      if (stack.length > 0) {
        const parent = stack[stack.length - 1];
        if (parent.expect === 'value' || parent.expect === 'value_or_end' || parent.expect === 'value_after_comma') {
          parent.expect = 'comma_or_end';
        }
      }
    }
  }

  try {
    return { ok: true, value: JSON.parse(out.join('')) };
  } catch {
    return { ok: false, reason: 'malformed JSON' };
  }
}

function tryFenced(str) {
  const inner = extractFence(str);
  if (inner == null) return null;
  const trimmed = inner.trim();
  if (!trimmed) return { ok: false, reason: 'output is empty' };
  try {
    return { ok: true, value: JSON.parse(trimmed) };
  } catch {
    return scanAndHeal(inner);
  }
}

/**
 * Parse and optionally heal a model's text into a JSON value.
 * Never returns model text inside `reason`.
 */
export function healAndParseJson(text, { maxChars = MAX_STRUCTURED_CHARS } = {}) {
  if (typeof text !== 'string') return { ok: false, reason: 'output is not a string' };
  const limit = Number.isInteger(maxChars) && maxChars > 0 ? maxChars : MAX_STRUCTURED_CHARS;
  if (text.length > limit) {
    return { ok: false, reason: `output exceeds maximum size (${limit} characters)` };
  }
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, reason: 'output is empty' };

  try {
    return { ok: true, value: JSON.parse(text), healed: false };
  } catch {}

  const hasFence = text.includes('```');
  let res;
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    res = scanAndHeal(text);
    if (!res.ok && hasFence) {
      const fenced = tryFenced(text);
      if (fenced?.ok) res = fenced;
    }
  } else if (hasFence) {
    res = tryFenced(text);
    if (!res?.ok) {
      const scanned = scanAndHeal(text);
      if (scanned.ok) res = scanned;
    }
  } else {
    res = scanAndHeal(text);
  }

  return res?.ok ? { ok: true, value: res.value, healed: true } : { ok: false, reason: res?.reason || 'malformed JSON' };
}

function sanitizeSchemaReason(reason) {
  let out = String(reason || 'schema validation failed');
  out = out.replace(/not one of the allowed values \(.*/, 'not one of the allowed values');
  out = out.replace(/(^|: |\(|; )must be (?!greater than |less than )[\s\S]*/, '$1does not match expected constant');
  out = out.replace(/unexpected property (?:"[^"]*"|\(a name that is not an identifier\))/g, 'unexpected property');
  return out;
}

/**
 * Heal and validate `text` against `spec`, returning canonical JSON text on success.
 */
export function enforceStructuredOutput(text, spec, { maxChars = MAX_STRUCTURED_CHARS } = {}) {
  const parsed = healAndParseJson(text, { maxChars });
  if (!parsed.ok) return { ok: false, reason: parsed.reason };

  if (spec?.type === 'json_object') {
    if (!isPlainObject(parsed.value)) {
      return { ok: false, reason: '$: expected a JSON object' };
    }
  } else if (spec?.type === 'json_schema') {
    const checked = validate(spec.schema, parsed.value, { path: '$' });
    if (!checked.ok) {
      return { ok: false, reason: sanitizeSchemaReason(checked.reason) };
    }
  }

  return {
    ok: true,
    text: JSON.stringify(parsed.value),
    value: parsed.value,
    healed: parsed.healed,
  };
}
