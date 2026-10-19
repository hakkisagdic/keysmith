import { fingerprint } from './redact.js';

/**
 * Gateway keys, and what each one may reach.
 *
 * `auth.keys` holds a bare key — the form every keysmith before scopes wrote, and still the
 * form of a key nobody scoped: it reaches every adapter and every alias — or an object:
 *
 *   { "key": "ks_…", "label": "ada", "allow": ["agy", "alias:argon"], "deny": ["claude-api"] }
 *
 * A pattern is one of:
 *
 *   claude-api               an adapter id: every model of that adapter
 *   agy/*  google/gemini-3.8-*   a glob over `adapter/model`; `*` is any run of characters, `/` included
 *   alias:argon  alias:*     an alias, by name (a glob too)
 *
 * No `allow` means everything that is not denied; an `allow` list means only what it names.
 * `deny` wins over `allow`. An alias is two checks: the key may name the alias, and then each
 * leg is checked on its own — a leg outside the scope is skipped, never run, and the request
 * is refused (403) only when no leg is left. So an alias that later gains a `claude-api` leg
 * still cannot take a key that is denied `claude-api` there.
 *
 * Fails closed: an entry with a field keysmith does not know (`"alow"` would otherwise read as
 * "no allow list"), a list that is not a list of patterns, or the same key twice with two
 * different scopes, leaves that key reaching nothing until the config is fixed — and says so
 * in `doctor`, on the status page and in `keysmith key list`. Nothing here ever puts a key in
 * a message: a key is named by its fingerprint.
 */

const ENTRY_FIELDS = new Set(['key', 'label', 'allow', 'deny']);

/** A key string out of an `auth.keys` entry, or null. */
export function keyOf(entry) {
  if (typeof entry === 'string') return entry || null;
  if (entry && typeof entry === 'object' && !Array.isArray(entry) && typeof entry.key === 'string' && entry.key) return entry.key;
  return null;
}

/** Every key string in an `auth.keys` list, entries of either form. */
export function keyStrings(list) {
  return (Array.isArray(list) ? list : []).map(keyOf).filter(Boolean);
}

/**
 * Whether a config's auth is on: enabled, and something is listed. A list whose entries are
 * all malformed is still "on" — it opens nothing; it never turns into a keyless gateway.
 */
export function authEnabled(cfg) {
  const keys = cfg?.auth?.keys;
  return !!cfg?.auth?.enabled && (Array.isArray(keys) ? keys.length > 0 : !!keys);
}

export function parsePattern(raw) {
  if (typeof raw !== 'string' || !raw || /\s/.test(raw)) throw new Error(`not a scope pattern: ${JSON.stringify(raw)} — an adapter id, an adapter/model glob or alias:<name>`);
  if (raw.startsWith('alias:')) {
    const glob = raw.slice('alias:'.length);
    if (!glob) throw new Error('"alias:" names an alias, e.g. alias:argon');
    return { text: raw, kind: 'alias', glob, re: globRe(glob) };
  }
  if (raw.includes('/') || raw.includes('*')) return { text: raw, kind: 'glob', glob: raw, re: globRe(raw) };
  return { text: raw, kind: 'adapter', id: raw };
}

function globRe(glob) {
  return new RegExp(`^${glob.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[\\s\\S]*')}$`);
}

/** Some string that starts with `prefix` matches `glob`. */
export function globCanStartWith(glob, prefix) {
  for (let i = 0; i < glob.length; i++) {
    if (glob[i] === '*') return true;
    if (i >= prefix.length) return true;
    if (glob[i] !== prefix[i]) return false;
  }
  return glob.length >= prefix.length;
}

/** Every string that starts with `prefix` matches `glob`. */
function globCoversAll(p, prefix) {
  return p.glob.endsWith('*') && p.re.test(prefix);
}

function patternList(value, field) {
  if (!Array.isArray(value)) throw new Error(`"${field}" must be a list of patterns, e.g. ["agy", "alias:argon"]`);
  return value.map((v) => parsePattern(v));
}

/**
 * The scope an `auth.keys` entry carries: null when it carries none (a bare key, or an object
 * with neither list), otherwise `{ allow: Pattern[] | null, deny: Pattern[], invalid: null }`.
 * Throws on what cannot be read; parseKeys turns that into a scope that reaches nothing.
 */
export function compileScope(entry) {
  if (typeof entry === 'string') return null;
  for (const field of Object.keys(entry)) {
    if (!ENTRY_FIELDS.has(field)) throw new Error(`unknown field "${field}" (a key entry has key, label, allow, deny)`);
  }
  if (entry.label != null && typeof entry.label !== 'string') throw new Error('"label" must be a string');
  const allow = entry.allow === undefined ? null : patternList(entry.allow, 'allow');
  const deny = entry.deny === undefined ? [] : patternList(entry.deny, 'deny');
  if (!allow && !deny.length) return null;
  return { allow, deny, invalid: null };
}

const NOTHING = (why) => ({ allow: [], deny: [], invalid: why });

/**
 * `auth.keys` as the gateway uses it: `{ entries: [{ key, label, fp, scope }], issues }`.
 * An entry with no usable key is left out (and named in `issues`); one whose scope cannot be
 * read stays in — it authenticates, so its client hears a 403 that says why, not a 401 — with
 * a scope that reaches nothing.
 */
export function parseKeys(list) {
  const entries = [];
  const issues = [];
  if (list != null && !Array.isArray(list)) {
    issues.push('auth.keys is not a list — no key opens this gateway');
    return { entries, issues };
  }
  for (const [i, item] of (list || []).entries()) {
    const key = keyOf(item);
    if (!key) {
      issues.push(`auth.keys[${i}] holds no key — ignored`);
      continue;
    }
    const fp = fingerprint(key);
    const label = item && typeof item === 'object' && typeof item.label === 'string' ? item.label : null;
    let scope;
    try {
      scope = compileScope(item);
    } catch (e) {
      scope = NOTHING(e.message);
      issues.push(`key fp:${fp}${label ? ` (${label})` : ''}: ${e.message} — it reaches nothing until that is fixed`);
    }
    entries.push({ key, label, fp, scope });
  }
  // The same key twice: the gateway would match the first entry, and a hand edit that adds an
  // unscoped copy above a scoped one would quietly widen it. Two different scopes is an error.
  const byKey = new Map();
  for (const e of entries) byKey.set(e.key, [...(byKey.get(e.key) || []), e]);
  for (const [, same] of byKey) {
    if (same.length < 2) continue;
    const shapes = new Set(same.map((e) => JSON.stringify(scopeText(e.scope))));
    if (shapes.size < 2) continue;
    for (const e of same) e.scope = NOTHING(`listed ${same.length} times with different scopes`);
    issues.push(`key fp:${same[0].fp} is listed ${same.length} times with different scopes — it reaches nothing until one entry is left`);
  }
  return { entries, issues };
}

const OK = Object.freeze({ ok: true });
const no = (reason) => ({ ok: false, reason });

function invalidReason(scope) {
  return `the scope of this key is invalid in the config (${scope.invalid}), so it reaches nothing until that is fixed`;
}

/**
 * May a key with `scope` reach adapter `adapterId` for `models` — the model as requested and,
 * when the adapter's `modelMap` rewrites it, as sent upstream? An adapter-id pattern takes
 * every model of the adapter; a glob has to hold for every form (and any form it matches is
 * enough for a deny), so a mapped name never carries a request past a model it names.
 *
 * `spellings` are other names the upstream answers to for the same model (`models/gemini-4-argon`
 * for Google's `gemini-4-argon`, see modelSpellings): a deny that matches any of them holds. They
 * are not held to the allow-list — a name the key was not given is refused, not widened.
 *
 * A request that names no model (and whose adapter has no `defaultModel`) leaves the choice to
 * the upstream. A key that may reach only part of the adapter cannot vouch for that choice, so
 * it is refused: it names the model.
 */
export function targetDecision(scope, adapterId, models = [''], { spellings = [] } = {}) {
  if (!scope) return OK;
  if (scope.invalid) return no(invalidReason(scope));
  const forms = [...new Set(models.map((m) => `${adapterId}/${m ?? ''}`))];
  const denyForms = [...new Set([...forms, ...spellings.map((m) => `${adapterId}/${m}`)])];
  const hits = (p, form) => (p.kind === 'adapter' ? p.id === adapterId : p.kind === 'glob' ? p.re.test(form) : false);
  for (const p of scope.deny) {
    if (denyForms.some((f) => hits(p, f))) return no(`this key may not reach adapter "${adapterId}": its scope denies ${p.text}`);
  }
  if (scope.allow && !forms.every((f) => scope.allow.some((p) => hits(p, f)))) {
    return no(`this key may not reach adapter "${adapterId}": ${forms[0]} is not in its allow-list`);
  }
  if (models.some((m) => !m) && adapterReach(scope, adapterId) === 'some') {
    return no(`this key may reach only some models of adapter "${adapterId}", so its request names one (${adapterId}/<model>) — with none, the upstream would pick`);
  }
  return OK;
}

/**
 * targetDecision for one request: `model` as asked for (`''` for the adapter's own) of the
 * adapter `adapterId` — `adapter` a loaded adapter or its config entry, null when there is none —
 * checked in every form and spelling modelForms and modelSpellings know of. What the gateway,
 * the model listing and `key who-can` decide a target by.
 */
export function requestDecision(scope, adapterId, adapter, model) {
  if (!scope) return OK;
  const models = modelForms(adapter, model);
  return targetDecision(scope, adapterId, models, { spellings: modelSpellings(adapter, models) });
}

/** May a key with `scope` name alias `name`? (Its legs are checked one by one after this.) */
export function aliasDecision(scope, name) {
  if (!scope) return OK;
  if (scope.invalid) return no(invalidReason(scope));
  for (const p of scope.deny) {
    if (p.kind === 'alias' && p.re.test(name)) return no(`this key may not use alias "${name}": its scope denies ${p.text}`);
  }
  if (scope.allow && !scope.allow.some((p) => p.kind === 'alias' && p.re.test(name))) {
    return no(`this key may not use alias "${name}": alias:${name} is not in its allow-list`);
  }
  return OK;
}

/**
 * How much of adapter `id` a key with `scope` can reach: 'all', 'some' (a model glob lets part
 * of it through, or keeps part of it out) or 'none'. What `who-can`, the model listing and the
 * routes endpoint go by; a request is decided by targetDecision, model by model.
 */
export function adapterReach(scope, id) {
  if (!scope) return 'all';
  if (scope.invalid) return 'none';
  const prefix = `${id}/`;
  const touches = (p) => (p.kind === 'adapter' ? p.id === id : p.kind === 'glob' && globCanStartWith(p.glob, prefix));
  const covers = (p) => (p.kind === 'adapter' ? p.id === id : p.kind === 'glob' && globCoversAll(p, prefix));
  const denies = scope.deny.filter(touches);
  if (denies.some(covers)) return 'none';
  const allowAll = !scope.allow || scope.allow.some(covers);
  if (!allowAll && !scope.allow.some(touches)) return 'none';
  return allowAll && !denies.length ? 'all' : 'some';
}

/** The lists as written, for a listing: `{ allow, deny }`, `null` for an unscoped key. */
export function scopeText(scope) {
  if (!scope) return null;
  if (scope.invalid) return { invalid: scope.invalid };
  return { ...(scope.allow ? { allow: scope.allow.map((p) => p.text) } : {}), ...(scope.deny.length ? { deny: scope.deny.map((p) => p.text) } : {}) };
}

/** One line: `unscoped — every adapter and alias`, `allow: agy, alias:argon · deny: claude-api`. */
export function describeScope(scope) {
  if (!scope) return 'unscoped — every adapter and alias';
  if (scope.invalid) return `INVALID (${scope.invalid}) — reaches nothing`;
  const parts = [];
  if (scope.allow) parts.push(scope.allow.length ? `allow: ${scope.allow.map((p) => p.text).join(', ')}` : 'allow: (nothing)');
  if (scope.deny.length) parts.push(`deny: ${scope.deny.map((p) => p.text).join(', ')}`);
  return parts.join(' · ');
}

/**
 * The model forms a scope is checked against for one request: the model as requested — or the
 * adapter's `defaultModel` when the request named none — and what `modelMap` sends upstream
 * instead. `adapter` is a loaded adapter or its config entry (both spell these fields alike).
 */
export function modelForms(adapter, model) {
  const asked = model || adapter?.defaultModel || '';
  const map = adapter?.modelMap;
  const mapped = map && typeof map === 'object' && Object.hasOwn(map, asked) ? map[asked] : null;
  return typeof mapped === 'string' && mapped !== asked ? [asked, mapped] : [asked];
}

/**
 * The other names an upstream answers to for `models`, as far as keysmith knows them: with a
 * `stripModelPrefix` (Google's `models/`), the id without the prefix and with it. A request for
 * `google/models/gemini-4-argon` is a request for `gemini-4-argon`, and a deny of
 * `google/gemini-4-*` keeps it out. Anything else an upstream treats as the same model — a dated
 * snapshot and its undated alias, say — keysmith cannot know: a glob is matched against the id
 * as written, so a credit is kept out by denying the adapter, or by an allow-list.
 */
export function modelSpellings(adapter, models) {
  const prefix = typeof adapter?.stripModelPrefix === 'string' && adapter.stripModelPrefix ? adapter.stripModelPrefix : null;
  if (!prefix) return [];
  const out = new Set();
  for (const m of models) {
    if (typeof m !== 'string' || !m) continue;
    let bare = m;
    while (bare.startsWith(prefix)) bare = bare.slice(prefix.length);
    out.add(bare);
    out.add(prefix + bare);
  }
  for (const m of models) out.delete(m);
  return [...out];
}

/* ------------------------------------------------- patterns that name nothing configured */

const loose = (s) => String(s).toLowerCase().replace(/_/g, '-');

/** A configured name that `name` misses only by case or `_`/`-`, or null. */
function nearName(name, names) {
  if (!name || name.includes('*')) return null;
  return names.find((n) => n !== name && loose(n) === loose(name)) ?? null;
}

const hint = (wrote, near) => (near ? ` — did you mean ${near}? (a pattern is matched as written: ${wrote} ≠ ${near})` : '');

/**
 * Of `patterns` (as written in a key entry), the ones that name nothing this config has, one
 * line each: an adapter id no adapter has, a glob no configured adapter's models can match, an
 * alias pattern no alias matches. A name that differs from a configured one only by case or
 * `_`/`-` gets a hint (`Claude-API ≠ claude-api`). A deny pattern that names nothing keeps
 * nothing out — the mistake a scope exists to prevent. Not a failure: a pattern may name an
 * adapter that is added later. A pattern that does not parse is not here; compileScope refuses it.
 */
export function unnamedPatterns(cfg, patterns) {
  const adapters = Object.keys(cfg?.adapters || {});
  const aliases = Object.keys(cfg?.aliases || {});
  const problems = [];
  for (const raw of patterns || []) {
    let p;
    try {
      p = parsePattern(raw);
    } catch {
      continue;
    }
    if (p.kind === 'adapter') {
      if (Object.hasOwn(cfg?.adapters || {}, p.id)) continue;
      if (Object.hasOwn(cfg?.aliases || {}, p.id)) problems.push(`"${p.id}" is an alias, not an adapter — alias:${p.id} names it`);
      else problems.push(`"${p.id}" names no configured adapter${hint(p.id, nearName(p.id, adapters))}`);
    } else if (p.kind === 'glob') {
      if (adapters.some((id) => globCanStartWith(p.glob, `${id}/`))) continue;
      const slash = p.glob.indexOf('/');
      const head = slash > 0 ? p.glob.slice(0, slash) : p.glob;
      const near = nearName(head, adapters);
      problems.push(`"${p.text}" matches no configured adapter${near ? hint(head, near) : ''}`);
    } else if (!aliases.some((a) => p.re.test(a))) {
      const near = nearName(p.glob, aliases);
      problems.push(`"${p.text}" matches no configured alias${near ? hint(p.text, `alias:${near}`) : ''}`);
    }
  }
  return problems;
}

/**
 * For parsed `entries` (parseKeys), every pattern a readable scope holds that names nothing
 * configured: `[{ fp, label, field, problem, message }]`. What `serve`, `doctor`, `key list`
 * and the status page warn about — a hand-edited entry never went through the check `key add`
 * and `key scope` make, and `deny: ["Claude-API"]` would otherwise keep nothing out unsaid.
 */
export function scopeWarnings(cfg, entries) {
  const out = [];
  for (const e of entries || []) {
    if (!e.scope || e.scope.invalid) continue;
    for (const [field, list] of [['allow', e.scope.allow || []], ['deny', e.scope.deny]]) {
      for (const problem of unnamedPatterns(cfg, list.map((p) => p.text))) {
        const effect = field === 'deny' ? 'a deny pattern that names nothing keeps nothing out' : 'an allow pattern that names nothing lets nothing in';
        out.push({ fp: e.fp, label: e.label, field, problem, message: `key fp:${e.fp}${e.label ? ` (${e.label})` : ''}: ${field} ${problem} — ${effect}` });
      }
    }
  }
  return out;
}
