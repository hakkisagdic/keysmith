/**
 * A JSON Schema subset, enough to hold a model's tool call to the schema the client sent — no
 * dependency, no network, no code generation.
 *
 * Checked: `type` (one name or a list; `null`, and `integer` apart from `number`), `properties`,
 * `required`, `additionalProperties` (false or a schema; `patternProperties` keys are not
 * "additional"), `enum`, `const`, `items` (a schema, or a list: positional), `prefixItems`,
 * `anyOf` / `oneOf` / `allOf`, `minimum` / `maximum` / `exclusiveMinimum` / `exclusiveMaximum`,
 * `minLength` / `maxLength` (code points), `minItems` / `maxItems`, `pattern` (a `u` RegExp), and
 * local `$ref` (`#`, `#/$defs/…`, `#/definitions/…`, any JSON pointer into the same document),
 * with its siblings checked too. OpenAPI's `nullable: true` lets null through. Every other
 * keyword — `format`, `default`, `description`, `if`, `not`, remote refs — is ignored: a
 * keyword this file does not know can only make it accept more, never refuse a valid call.
 *
 * Bounded: a `$ref` chain that consumes no data stops after MAX_REF_HOPS (a schema that is its
 * own definition), data nested deeper than MAX_DEPTH is refused, and one check takes at most
 * MAX_STEPS steps (a schema whose alternatives multiply). A `pattern` is the client's own
 * regular expression and runs as one: a pathological pattern costs what it costs.
 *
 * A reason names the place (`arguments.limit`), what the schema wanted, and the JSON type it
 * got — never a value from the arguments. It goes back to the model to correct itself and may
 * end up in an error message or a log line, where a tool argument must not.
 */

const MAX_REF_HOPS = 32;
const MAX_DEPTH = 64;
const MAX_STEPS = 100_000;
const REASON_MAX = 200;

/** Keywords that only describe: a `$ref` whose siblings are all of these is just the reference. */
const ANNOTATIONS = new Set(['title', 'description', 'default', 'examples', 'deprecated', 'readOnly', 'writeOnly', '$comment']);

/**
 * `value` against `schema`: `{ ok: true }` or `{ ok: false, reason }`. `path` names the root in
 * the reason. Local `$ref`s are resolved against `schema` itself.
 */
export function validate(schema, value, { path = 'value' } = {}) {
  const ctx = { root: schema, steps: 0, patterns: new Map() };
  const reason = check(schema, value, path, ctx, 0, 0);
  return reason ? { ok: false, reason: clip(reason) } : { ok: true };
}

/**
 * Is `call` (`{ name, args }`, or `{ name, arguments: '<json>' }`) a call of one of `tools`
 * (`[{ name, parameters }]`, a ToolSpec's list) that its schema accepts?
 * `{ ok: true, args }` with the arguments as an object, or `{ ok: false, reason }`, the reason at
 * most 200 characters.
 */
export function validateCall(tools, call) {
  const name = call?.name;
  if (typeof name !== 'string' || !name) return { ok: false, reason: 'the call names no tool' };
  const list = Array.isArray(tools) ? tools : [];
  const tool = list.find((t) => t?.name === name);
  if (!tool) {
    const offered = list.map((t) => t?.name).filter((n) => typeof n === 'string');
    return { ok: false, reason: clip(`unknown tool ${quoteName(name)}; the tools are: ${offered.join(', ') || 'none'}`) };
  }
  let args = call.args;
  if (args === undefined && typeof call.arguments === 'string') {
    if (!call.arguments.trim()) args = {};
    else {
      try {
        args = JSON.parse(call.arguments);
      } catch {
        return { ok: false, reason: clip(`${name}: arguments are not valid JSON`) };
      }
    }
  }
  if (args === undefined) args = {};
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return { ok: false, reason: clip(`${name}: arguments must be a JSON object, got ${typeOf(args)}`) };
  }
  const r = validate(tool.parameters ?? {}, args, { path: `${name}.arguments` });
  return r.ok ? { ok: true, args } : r;
}

/**
 * `schema` with every local `$ref` written out in place, for a client that cannot follow one
 * (an MCP `tools/list`). A reference that points back into its own expansion (a tree of nodes),
 * one that does not resolve, and anything past `maxNodes` expanded nodes is written as `{}`
 * (any value), keeping its own description; `$defs` / `definitions` are dropped once nothing
 * refers to them. A call is still checked against the original schema, so a looser listing
 * never lets a wrong call through. The input is not changed.
 */
export function deref(schema, { maxNodes = 20_000 } = {}) {
  const root = schema;
  let budget = maxNodes;
  const walk = (s, stack) => {
    if (typeof s === 'boolean') return s;
    if (!s || typeof s !== 'object' || Array.isArray(s)) return clone(s);
    budget--;
    const { $ref, ...rest } = s;
    if (typeof $ref === 'string') {
      const target = budget > 0 && !stack.includes($ref) ? resolveRef(root, $ref) : undefined;
      const inlined = target === undefined ? {} : walk(target, [...stack, $ref]);
      return withSiblings(inlined, walkKeywords(rest, stack));
    }
    return walkKeywords(s, stack);
  };
  const walkKeywords = (s, stack) => {
    const out = {};
    for (const [k, v] of Object.entries(s)) {
      if (k === '$defs' || k === 'definitions' || k === '$ref') continue;
      if (SCHEMA_MAPS.has(k) && v && typeof v === 'object' && !Array.isArray(v)) {
        out[k] = Object.fromEntries(Object.entries(v).map(([name, sub]) => [name, walk(sub, stack)]));
      } else if (SCHEMA_LISTS.has(k) && Array.isArray(v)) {
        out[k] = v.map((sub) => walk(sub, stack));
      } else if (SCHEMA_ONE.has(k) || (k === 'items' && !Array.isArray(v))) {
        out[k] = walk(v, stack);
      } else if (k === 'items' && Array.isArray(v)) {
        out[k] = v.map((sub) => walk(sub, stack));
      } else {
        out[k] = clone(v);
      }
    }
    return out;
  };
  return walk(schema, []);
}

const SCHEMA_MAPS = new Set(['properties', 'patternProperties', 'dependentSchemas']);
const SCHEMA_LISTS = new Set(['anyOf', 'oneOf', 'allOf', 'prefixItems']);
const SCHEMA_ONE = new Set(['additionalProperties', 'additionalItems', 'contains', 'not', 'if', 'then', 'else', 'propertyNames', 'unevaluatedProperties', 'unevaluatedItems']);

function withSiblings(inlined, siblings) {
  const keys = Object.keys(siblings);
  if (!keys.length) return inlined;
  if (inlined === true) return siblings;
  if (inlined && typeof inlined === 'object' && keys.every((k) => ANNOTATIONS.has(k))) return { ...inlined, ...siblings };
  if (inlined && typeof inlined === 'object' && !Object.keys(inlined).length) return siblings;
  return { allOf: [inlined], ...siblings };
}

function clone(v) {
  return v === undefined ? v : JSON.parse(JSON.stringify(v));
}

/* ------------------------------------------------------------------ the checker */

function check(s, v, path, ctx, hops, depth) {
  // Out of steps is the answer for the whole check, not one alternative's failure.
  if (ctx.aborted) return ctx.aborted;
  if (++ctx.steps > MAX_STEPS) return (ctx.aborted = `${path}: the schema is too complex to check`);
  if (s === true || s == null) return null;
  if (s === false) return `${path}: no value is allowed here`;
  if (typeof s !== 'object' || Array.isArray(s)) return null;
  if (s.nullable === true && v === null) return null;

  if (typeof s.$ref === 'string') {
    const target = resolveRef(ctx.root, s.$ref);
    if (target !== undefined) {
      if (hops >= MAX_REF_HOPS) return `${path}: the schema's $ref chain does not end`;
      const r = check(target, v, path, ctx, hops + 1, depth);
      if (r) return r;
    }
  }

  if (s.type !== undefined) {
    const types = Array.isArray(s.type) ? s.type : [s.type];
    if (types.length && !types.some((t) => isType(t, v))) return `${path}: expected ${types.join(' or ')}, got ${typeOf(v)}`;
  }
  if (Array.isArray(s.enum) && !s.enum.some((e) => same(e, v))) {
    return `${path}: not one of the allowed values (${s.enum.map((e) => JSON.stringify(e)).join(', ')})`;
  }
  if (Object.hasOwn(s, 'const') && !same(s.const, v)) return `${path}: must be ${JSON.stringify(s.const)}`;

  if (typeof v === 'number') {
    if (typeof s.minimum === 'number' && (v < s.minimum || (s.exclusiveMinimum === true && v === s.minimum))) return `${path}: below the minimum ${s.minimum}`;
    if (typeof s.maximum === 'number' && (v > s.maximum || (s.exclusiveMaximum === true && v === s.maximum))) return `${path}: above the maximum ${s.maximum}`;
    if (typeof s.exclusiveMinimum === 'number' && v <= s.exclusiveMinimum) return `${path}: must be greater than ${s.exclusiveMinimum}`;
    if (typeof s.exclusiveMaximum === 'number' && v >= s.exclusiveMaximum) return `${path}: must be less than ${s.exclusiveMaximum}`;
  }
  if (typeof v === 'string') {
    const len = typeof s.minLength === 'number' || typeof s.maxLength === 'number' ? [...v].length : 0;
    if (typeof s.minLength === 'number' && len < s.minLength) return `${path}: shorter than ${s.minLength} characters`;
    if (typeof s.maxLength === 'number' && len > s.maxLength) return `${path}: longer than ${s.maxLength} characters`;
    if (typeof s.pattern === 'string') {
      const re = compiled(ctx, s.pattern);
      if (re && !re.test(v)) return `${path}: does not match the pattern ${s.pattern}`;
    }
  }
  if (Array.isArray(v)) {
    if (depth >= MAX_DEPTH) return `${path}: nested too deeply`;
    if (typeof s.minItems === 'number' && v.length < s.minItems) return `${path}: fewer than ${s.minItems} items`;
    if (typeof s.maxItems === 'number' && v.length > s.maxItems) return `${path}: more than ${s.maxItems} items`;
    const positional = Array.isArray(s.prefixItems) ? s.prefixItems : Array.isArray(s.items) ? s.items : null;
    const rest = Array.isArray(s.items) ? undefined : s.items;
    for (let i = 0; i < v.length; i++) {
      const sub = positional && i < positional.length ? positional[i] : rest;
      if (sub === undefined) continue;
      const r = check(sub, v[i], `${path}[${i}]`, ctx, 0, depth + 1);
      if (r) return r;
    }
  }
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    if (depth >= MAX_DEPTH) return `${path}: nested too deeply`;
    const props = s.properties && typeof s.properties === 'object' ? s.properties : {};
    for (const name of Array.isArray(s.required) ? s.required : []) {
      if (typeof name === 'string' && (!Object.hasOwn(v, name) || v[name] === undefined)) return `${path}: missing required property ${quoteName(name)}`;
    }
    const patterns = s.patternProperties && typeof s.patternProperties === 'object' ? Object.entries(s.patternProperties) : [];
    for (const [key, value] of Object.entries(v)) {
      const at = childPath(path, key);
      let known = false;
      if (Object.hasOwn(props, key)) {
        known = true;
        const r = check(props[key], value, at, ctx, 0, depth + 1);
        if (r) return r;
      }
      for (const [pattern, sub] of patterns) {
        const re = compiled(ctx, pattern);
        if (!re || !re.test(key)) continue;
        known = true;
        const r = check(sub, value, at, ctx, 0, depth + 1);
        if (r) return r;
      }
      if (known) continue;
      if (s.additionalProperties === false) return `${path}: unexpected property ${quoteName(key)}`;
      if (s.additionalProperties && typeof s.additionalProperties === 'object') {
        const r = check(s.additionalProperties, value, at, ctx, 0, depth + 1);
        if (r) return r;
      }
    }
  }

  if (Array.isArray(s.allOf)) {
    for (const sub of s.allOf) {
      const r = check(sub, v, path, ctx, hops, depth);
      if (r) return r;
    }
  }
  if (Array.isArray(s.anyOf) && s.anyOf.length) {
    const reasons = [];
    for (const sub of s.anyOf) {
      const r = check(sub, v, path, ctx, hops, depth);
      if (ctx.aborted) return ctx.aborted;
      if (!r) return null;
      reasons.push(r);
    }
    return noneOf(s.anyOf, v, path, reasons);
  }
  if (Array.isArray(s.oneOf) && s.oneOf.length) {
    const reasons = [];
    let passed = 0;
    for (const sub of s.oneOf) {
      const r = check(sub, v, path, ctx, hops, depth);
      if (ctx.aborted) return ctx.aborted;
      if (r) reasons.push(r);
      else passed++;
    }
    if (passed === 0) return noneOf(s.oneOf, v, path, reasons);
    if (passed > 1) return `${path}: matches more than one of the alternatives (oneOf)`;
  }
  return null;
}

/**
 * Why no alternative fitted. When every alternative names its type (pydantic's `X | None`): the
 * value is of none of them — say which were wanted — or of exactly one, whose own reason is the
 * one that helps. Otherwise the first two reasons, each relative to `path`.
 */
function noneOf(branches, v, path, reasons) {
  const typesOf = (b) => (Array.isArray(b.type) ? b.type : [b.type]);
  if (branches.every((b) => b && typeof b === 'object' && !Array.isArray(b) && b.type !== undefined)) {
    const fitting = branches.map((b, i) => (typesOf(b).some((t) => isType(t, v)) ? i : -1)).filter((i) => i >= 0);
    if (!fitting.length) return `${path}: expected ${branches.flatMap(typesOf).join(' or ')}, got ${typeOf(v)}`;
    if (fitting.length === 1) return reasons[fitting[0]];
  }
  const relative = reasons.slice(0, 2).map((r) => (r.startsWith(`${path}: `) ? r.slice(path.length + 2) : r.startsWith(path) ? r.slice(path.length) : r));
  return `${path}: matches none of the alternatives (${relative.join('; ')})`;
}

function isType(t, v) {
  switch (t) {
    case 'null':
      return v === null;
    case 'boolean':
      return typeof v === 'boolean';
    case 'string':
      return typeof v === 'string';
    case 'number':
      return typeof v === 'number' && Number.isFinite(v);
    case 'integer':
      return typeof v === 'number' && Number.isInteger(v);
    case 'array':
      return Array.isArray(v);
    case 'object':
      return !!v && typeof v === 'object' && !Array.isArray(v);
    default:
      return true; // a type name this file does not know refuses nothing
  }
}

/** The JSON type of `v`, as a reason says it: a whole number is `integer`. */
function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function same(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || !a || !b || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((x, i) => same(x, b[i]));
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => Object.hasOwn(b, k) && same(a[k], b[k]));
}

function compiled(ctx, pattern) {
  if (!ctx.patterns.has(pattern)) {
    let re = null;
    try {
      re = new RegExp(pattern, 'u');
    } catch {}
    ctx.patterns.set(pattern, re);
  }
  return ctx.patterns.get(pattern);
}

/**
 * The schema a local `$ref` points at, or undefined: `#` is the document, `#/a/b` a JSON pointer
 * into it (`~1` is `/`, `~0` is `~`), own keys only — `#/__proto__` points at nothing.
 */
export function resolveRef(root, ref) {
  if (typeof ref !== 'string' || !ref.startsWith('#')) return undefined;
  if (ref === '#' || ref === '#/') return root;
  if (!ref.startsWith('#/')) return undefined;
  let node = root;
  for (const raw of ref.slice(2).split('/')) {
    let key;
    try {
      key = decodeURIComponent(raw).replace(/~1/g, '/').replace(/~0/g, '~');
    } catch {
      return undefined;
    }
    if (!node || typeof node !== 'object' || !Object.hasOwn(node, key)) return undefined;
    node = node[key];
  }
  return node;
}

function childPath(path, key) {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? `${path}.${key}` : `${path}[${quoteName(key)}]`;
}

/** A property or tool name, quoted — or, when it does not look like a name at all, not repeated. */
function quoteName(name) {
  return /^[\w.$:-]{1,64}$/.test(name) ? `"${name}"` : '(a name that is not an identifier)';
}

/**
 * A reason in at most REASON_MAX characters. A long path (data nested forty levels deep) gives
 * up its middle first, so what went wrong is still said at the end.
 */
function clip(s) {
  s = String(s).replace(/\s+/g, ' ');
  if (s.length <= REASON_MAX) return s;
  const at = s.indexOf(': ');
  if (at > 0) {
    const path = s.slice(0, at);
    const what = s.slice(at);
    const room = REASON_MAX - Math.min(what.length, 120) - 1;
    if (path.length > room && room > 20) s = `${path.slice(0, 12)}…${path.slice(path.length - (room - 12))}${what}`;
  }
  return s.length > REASON_MAX ? s.slice(0, REASON_MAX - 1) + '…' : s;
}
