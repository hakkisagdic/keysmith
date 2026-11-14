import { LlmError } from './util.js';

/**
 * Structured Output / JSON Schema Enforcement & Response Healing (`P2-4` / Matrix #18).
 *
 * Supports OpenAI Chat (`response_format: { type: "json_object" | "json_schema", json_schema: { name, schema, strict } }`)
 * and OpenAI Responses (`text: { format: { type: "json_object" | "json_schema", name, schema, strict } }` or `response_format`).
 */
export function extractResponseFormatSpec(body = {}) {
  if (!body || typeof body !== 'object') return null;
  const rf = body.response_format || body.text?.format || null;
  if (!rf || typeof rf !== 'object') return null;
  const type = String(rf.type || '').trim();
  if (type !== 'json_object' && type !== 'json_schema') return null;

  if (type === 'json_object') {
    return {
      type: 'json_object',
      name: null,
      schema: null,
      strict: rf.strict !== false,
    };
  }

  const js = rf.json_schema && typeof rf.json_schema === 'object' ? rf.json_schema : rf;
  return {
    type: 'json_schema',
    name: typeof js.name === 'string' && js.name.trim() ? js.name.trim() : 'response',
    schema: js.schema && typeof js.schema === 'object' ? js.schema : null,
    strict: js.strict !== false,
  };
}

/**
 * Inject a concise JSON formatting instruction into the messages array so CLI and non-schema
 * HTTP adapters reliably produce conforming JSON.
 */
export function injectStructuredOutputInstruction(messages = [], spec = null) {
  if (!spec || !Array.isArray(messages) || !messages.length) return messages;
  const schemaHint =
    spec.type === 'json_schema' && spec.schema
      ? `Follow this exact JSON Schema (${spec.name || 'response'}): ${JSON.stringify(spec.schema)}`
      : 'Return a valid JSON object.';
  const instruction = `[Structured Output Requirement: Respond ONLY with raw, valid JSON (no markdown code fences, no commentary). ${schemaHint}]`;

  const copy = messages.map((m) => ({ ...m }));
  const sysIdx = copy.findIndex((m) => m.role === 'system');
  if (sysIdx >= 0 && typeof copy[sysIdx].content === 'string') {
    if (!copy[sysIdx].content.includes('[Structured Output Requirement:')) {
      copy[sysIdx].content = `${copy[sysIdx].content}\n\n${instruction}`;
    }
    return copy;
  }
  return [{ role: 'system', content: instruction }, ...copy];
}

/**
 * Attempt to parse raw LLM output as JSON, automatically healing common LLM formatting issues:
 * 1. Markdown code fences (```json ... ```)
 * 2. Leading/trailing conversational prose around a `{ ... }` or `[ ... ]` payload
 * 3. Trailing commas before `}` or `]`
 *
 * Returns `{ ok: true, value, jsonText, healed: boolean }` or `{ ok: false, error }`.
 */
export function healAndParseJson(rawText = '') {
  const trimmed = String(rawText ?? '').trim();
  if (!trimmed) {
    return { ok: false, error: 'response text is empty' };
  }

  // 1. Direct parse
  try {
    const val = JSON.parse(trimmed);
    return { ok: true, value: val, jsonText: JSON.stringify(val), healed: false };
  } catch {}

  // 2. Strip markdown code fence ```json ... ``` or ``` ... ```
  let candidate = trimmed;
  const fenceMatch = candidate.match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
  if (fenceMatch && fenceMatch[1]) {
    candidate = fenceMatch[1].trim();
    try {
      const val = JSON.parse(candidate);
      return { ok: true, value: val, jsonText: JSON.stringify(val), healed: true };
    } catch {}
  }

  // 3. Extract outermost balanced `{ ... }` or `[ ... ]`
  const extracted = extractBalancedJson(candidate) || extractBalancedJson(trimmed);
  if (extracted) {
    try {
      const val = JSON.parse(extracted);
      return { ok: true, value: val, jsonText: JSON.stringify(val), healed: true };
    } catch {}
    // 4. Heal trailing commas before `}` or `]`
    const deComma = extracted.replace(/,\s*([}\]])/g, '$1');
    try {
      const val = JSON.parse(deComma);
      return { ok: true, value: val, jsonText: JSON.stringify(val), healed: true };
    } catch {}
  }

  return { ok: false, error: 'output could not be parsed or healed as valid JSON' };
}

function extractBalancedJson(str) {
  const firstObj = str.indexOf('{');
  const firstArr = str.indexOf('[');
  let start = -1;
  if (firstObj >= 0 && firstArr >= 0) start = Math.min(firstObj, firstArr);
  else start = Math.max(firstObj, firstArr);
  if (start < 0) return null;

  const openChar = str[start];
  const closeChar = openChar === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < str.length; i++) {
    const ch = str[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\' && inString) {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === openChar) depth++;
    else if (ch === closeChar) {
      depth--;
      if (depth === 0) {
        return str.slice(start, i + 1);
      }
    }
  }
  return null;
}

/**
 * Zero-dependency JSON Schema validator supporting `type`, `properties`, `required`,
 * `additionalProperties`, `items`, `enum`, `minimum`, `maximum`, `minLength`, `maxLength`.
 *
 * Returns `{ valid: true, errors: [] }` or `{ valid: false, errors: Array<string> }`.
 */
export function validateJsonSchema(value, schema, path = '$') {
  const errors = [];
  if (!schema || typeof schema !== 'object') return { valid: true, errors };

  if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) {
    const okAny = schema.anyOf.some((sub) => validateJsonSchema(value, sub, path).valid);
    if (!okAny) errors.push(`${path}: value did not match anyOf schemas`);
    return { valid: errors.length === 0, errors };
  }

  if (Array.isArray(schema.enum)) {
    const matched = schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value));
    if (!matched) {
      errors.push(`${path}: expected one of ${JSON.stringify(schema.enum)}, got ${JSON.stringify(value)}`);
      return { valid: false, errors };
    }
  }

  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actualType = getJsonType(value);
    const typeOk = types.some((t) => t === actualType || (t === 'number' && actualType === 'integer'));
    if (!typeOk) {
      errors.push(`${path}: expected type "${types.join('|')}", got "${actualType}"`);
      return { valid: false, errors };
    }
  }

  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      errors.push(`${path}: string length ${value.length} is less than minLength ${schema.minLength}`);
    }
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
      errors.push(`${path}: string length ${value.length} exceeds maxLength ${schema.maxLength}`);
    }
  }

  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      errors.push(`${path}: ${value} is less than minimum ${schema.minimum}`);
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      errors.push(`${path}: ${value} exceeds maximum ${schema.maximum}`);
    }
  }

  if (Array.isArray(value)) {
    if (schema.items && typeof schema.items === 'object') {
      for (let i = 0; i < value.length; i++) {
        const sub = validateJsonSchema(value[i], schema.items, `${path}[${i}]`);
        if (!sub.valid) errors.push(...sub.errors);
      }
    }
  } else if (value !== null && typeof value === 'object') {
    if (Array.isArray(schema.required)) {
      for (const reqKey of schema.required) {
        if (!Object.hasOwn(value, reqKey) || value[reqKey] === undefined) {
          errors.push(`${path}: missing required property "${reqKey}"`);
        }
      }
    }
    const props = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
    for (const [k, v] of Object.entries(value)) {
      if (Object.hasOwn(props, k)) {
        const sub = validateJsonSchema(v, props[k], `${path}.${k}`);
        if (!sub.valid) errors.push(...sub.errors);
      } else if (schema.additionalProperties === false) {
        errors.push(`${path}: unexpected additional property "${k}"`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

function getJsonType(val) {
  if (val === null) return 'null';
  if (Array.isArray(val)) return 'array';
  if (typeof val === 'number') return Number.isInteger(val) ? 'integer' : 'number';
  return typeof val;
}

/**
 * Enforce and heal a non-streaming response text against `spec` (`extractResponseFormatSpec`).
 * Returns `{ text, status: 'valid' | 'healed' }` or throws a `422 Unprocessable Entity` `LlmError`
 * with `code: 'schema_validation_failed'`.
 */
export function enforceStructuredOutput(rawText, spec) {
  if (!spec) return { text: rawText, status: null };
  const parsed = healAndParseJson(rawText);
  if (!parsed.ok) {
    const err = new LlmError(`structured output validation failed: ${parsed.error}`, {
      status: 422,
      type: 'invalid_response_format',
    });
    err.code = 'schema_validation_failed';
    throw err;
  }

  if (spec.type === 'json_object') {
    if (parsed.value === null || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) {
      const err = new LlmError('structured output validation failed: expected a JSON object at root', {
        status: 422,
        type: 'invalid_response_format',
      });
      err.code = 'schema_validation_failed';
      throw err;
    }
    return { text: parsed.jsonText, status: parsed.healed ? 'healed' : 'valid' };
  }

  if (spec.type === 'json_schema' && spec.schema) {
    const check = validateJsonSchema(parsed.value, spec.schema);
    if (!check.valid && spec.strict) {
      const err = new LlmError(`structured output schema validation failed: ${check.errors.join('; ')}`, {
        status: 422,
        type: 'invalid_response_format',
      });
      err.code = 'schema_validation_failed';
      throw err;
    }
  }

  return { text: parsed.jsonText, status: parsed.healed ? 'healed' : 'valid' };
}
