import { LlmError } from './util.js';

/**
 * Reasoning effort on a CLI leg.
 *
 * A client chooses it in a spelling its API has — `reasoning_effort` or `reasoning: {effort}` on
 * /v1/chat/completions and /v1/responses (the spellings the HTTP adapters already read),
 * `output_config: {effort}` on /v1/messages — or, when it cannot send one (OpenBot), in the model
 * id: `codex/gpt-6-astra-xhigh` is gpt-6-astra at xhigh, the way agy's own catalogue spells
 * gemini-4-argon-high. A CLI takes it where its argv template says, as `{effort}`: codex's
 * `-c model_reasoning_effort="{effort}"`, Claude Code's `--effort {effort}`. A group holding
 * `{effort}` is left out when there is none, so a request without an effort runs the argv it
 * always did.
 *
 * A level is checked against the CLI's own catalogue — Codex's `supported_reasoning_levels` per
 * model (`codex debug models`), Claude Code's `supportedEffortLevels` (its `initialize` listing) —
 * and against nothing else: a level the model does not list is a 400 naming the ones it does, and
 * a model whose catalogue entry lists none takes no effort. Never guessed.
 *
 * A CLI whose argv has no `{effort}` (agy, opencode, an entry attached before it had one) is
 * handed no effort, as before; the usage row says the client's was not applied (`effortIgnored`).
 */

/** The placeholder an argv template carries an effort in. */
export const EFFORT_PLACEHOLDER = '{effort}';

/** Does this argv template (a list of strings and groups) take an effort? */
export function takesEffort(tpl) {
  return Array.isArray(tpl) && tpl.flat(Infinity).some((t) => typeof t === 'string' && t.includes(EFFORT_PLACEHOLDER));
}

/**
 * The effort a request chose, in its face's spellings, or null. Two spellings that disagree, or one
 * that is not a level's name, is a 400 — never one picked over the other.
 */
export function requestEffort(body, face) {
  if (!body || typeof body !== 'object') return null;
  const found = [];
  const take = (where, v) => {
    if (v === undefined || v === null) return;
    if (typeof v !== 'string' || !/^[a-z0-9_-]{1,32}$/i.test(v)) throw invalid(`${where} must be the name of an effort level, like "high"`);
    found.push([where, v]);
  };
  if (face === 'anthropic') {
    const oc = body.output_config;
    if (oc != null && (typeof oc !== 'object' || Array.isArray(oc))) throw invalid('output_config must be an object');
    take('output_config.effort', oc?.effort);
  } else {
    take('reasoning_effort', body.reasoning_effort);
    const r = body.reasoning;
    if (r != null && typeof r === 'object' && !Array.isArray(r)) take('reasoning.effort', r.effort);
  }
  if (found.length > 1 && found.some(([, v]) => v !== found[0][1])) {
    throw invalid(`${found.map(([w, v]) => `${w} "${v}"`).join(' and ')} disagree: send one effort`);
  }
  return found.length ? found[0][1] : null;
}

/** The catalogue entry of `model`: by its id, or by the model an alias of the CLI's resolves to (Claude Code's `sonnet` → claude-sonnet-5-5). */
export function catalogueEntry(list, model) {
  if (!Array.isArray(list) || !model) return null;
  return list.find((m) => m?.id === model) || list.find((m) => m?.resolved === model) || null;
}

/**
 * `model` read as `<catalogue model>-<level>`: `{ base, level }` when the catalogue lists the base
 * with that level and does not list `model` itself; null otherwise.
 */
export function effortSuffix(list, model) {
  if (!model || catalogueEntry(list, model)) return null;
  for (const m of Array.isArray(list) ? list : []) {
    for (const level of m?.efforts || []) {
      for (const id of [m.id, m.resolved].filter(Boolean)) if (model === `${id}-${level}`) return { base: id, level };
    }
  }
  return null;
}

/** The effort-suffixed ids a catalogue entry adds to a listing, one per level, none that the catalogue lists already. */
export function suffixedIds(list, m) {
  return (m?.efforts || []).map((level) => ({ id: `${m.id}-${level}`, level })).filter((x) => !catalogueEntry(list, x.id));
}

/**
 * What one CLI leg runs for (`model`, the request's `effort`): `{ model, effort, ignored? }` — the
 * catalogue's model and the level it takes, the suffix of an effort-suffixed id read off. Throws a
 * 400 for a level the model does not take (naming the ones it does), for a suffix and a field that
 * disagree, and for an effort on a model the catalogue has no levels for; a 503 when the catalogue
 * cannot be read for a request that names an effort.
 */
export async function resolveEffort(adapter, model, effort) {
  if (!adapter.takesEffort) {
    return { model, effort: null, ...(effort ? { ignored: `${adapter.id}'s argv takes no effort` } : {}) };
  }
  let list;
  try {
    list = await adapter.effortCatalogue();
  } catch (e) {
    // Without the catalogue no suffix is read and no level checked: a request that names no effort
    // runs as before, one that names one cannot be checked, so it does not run.
    if (!effort) return { model, effort: null };
    throw new LlmError(`adapter "${adapter.id}": its catalogue could not be read to check effort "${effort}": ${e.message}`, { status: 503, provider: adapter.id });
  }
  const suffix = effortSuffix(list, model);
  if (suffix && effort && effort !== suffix.level) {
    throw invalid(`the model "${model}" is ${suffix.base} at effort ${suffix.level}, and the request also asks for effort "${effort}": send one`, adapter.id);
  }
  const base = suffix ? suffix.base : model;
  const level = effort || suffix?.level || null;
  if (!level) return { model: base, effort: null };
  const entry = catalogueEntry(list, base);
  if (!entry) throw invalid(`effort "${level}": "${base || '(the adapter\'s default model)'}" is not in ${adapter.id}'s catalogue, so the efforts it takes are not known — name a model the catalogue lists (GET /v1/models)`, adapter.id);
  if (!entry.efforts?.length) throw invalid(`effort "${level}": ${adapter.id}'s catalogue lists no effort levels for ${base}, so it takes none`, adapter.id);
  if (!entry.efforts.includes(level)) throw invalid(`effort "${level}" is not one ${base} takes on ${adapter.id}: ${entry.efforts.join(', ')} (its catalogue)`, adapter.id);
  return { model: base, effort: level };
}

function invalid(message, provider = null) {
  return new LlmError(message, { status: 400, type: 'invalid_request_error', provider });
}
