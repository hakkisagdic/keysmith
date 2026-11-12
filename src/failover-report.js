import { FACE_ROUTES, toolSkipReason } from './tools/router.js';
import { checkCreditGuard, describeReading, evaluateCredits, pct } from './credit-guard.js';
import { parseSpendCaps } from './usage.js';

/**
 * Why a route did not go where its owner expected, for `keysmith doctor`, `keysmith status` and
 * /v1/keysmith/routes: which legs of each alias can carry a tool request on each face (a leg that
 * cannot is passed by, and a route with none fails a tool request with a 400), what the Kiro
 * credit guard last read and whether it holds an adapter back, and the legs requests actually
 * passed by lately (the usage rows' `skippedLegs`). Names, codes and numbers only: never a key,
 * a prompt or an answer.
 */

const PROBE_SPEC = { tools: [{ name: 'probe' }], choice: { mode: 'auto' }, parallel: true, unsupported: [] };

/**
 * Per alias and face (`anthropic`: /v1/messages, Claude Code's; `openai`: /v1/chat/completions):
 * `{ alias, face, route, legs: [{ target, adapter, carries, reason?, detail?, guarded?, heldBack? }],
 * carried, total }`, or `{ alias, error }` for an alias that does not resolve. A leg the Kiro
 * credit guard holds back now (its last reading, gateway.creditGuard) carries nothing until the
 * plan resets: it counts as not carrying, reason `credit_guard`.
 */
export function toolCarriage(gateway, { faces = ['anthropic', 'openai'], aliases = Object.keys(gateway?.cfg?.aliases || {}) } = {}) {
  const out = [];
  const held = heldBackNow(gateway);
  for (const alias of aliases) {
    let chain;
    try {
      chain = gateway.resolve(alias);
    } catch (e) {
      out.push({ alias, error: e.message });
      continue;
    }
    for (const face of faces) {
      const legs = chain.map((leg) => {
        // A face hands an HTTP leg on its own wire the body verbatim (its relay): the chat face an
        // openai-wire leg, the Messages face an anthropic-wire one.
        const why = toolSkipReason(leg.adapter, PROBE_SPEC, face, { relay: face === 'openai' || face === 'anthropic' });
        const h = !why && held.get(leg.adapter.id);
        const guarded = leg.adapter.creditGuard ? { guarded: true } : {};
        if (h) return { target: leg.target, adapter: leg.adapter.id, carries: false, reason: 'credit_guard', detail: `held back by the Kiro credit guard — ${h}`, heldBack: true, ...guarded };
        return { target: leg.target, adapter: leg.adapter.id, carries: !why, ...(why || {}), ...guarded };
      });
      out.push({ alias, face, route: FACE_ROUTES[face], legs, carried: legs.filter((l) => l.carries).length, total: legs.length });
    }
  }
  return out;
}

/** The adapters the credit guard holds back now, by its last readings: id -> what it read. */
function heldBackNow(gateway) {
  const held = new Map();
  let snap = [];
  try {
    snap = gateway?.creditGuard?.snapshot?.() || [];
  } catch {}
  for (const r of creditGuardRows(snap, { adapters: gateway?.adapters })) {
    for (const a of r.adapters) {
      if (a.state === 'held back') held.set(a.id, `${describeReading(r.reading)}, at or over ${pct(a.threshold)}${r.stale ? ' (the newest reading failed)' : ''}`);
    }
  }
  return held;
}

/**
 * Routes where a leg under the Kiro credit guard comes before a metered HTTP leg no spend cap
 * covers: once the plan reaches the threshold the guarded leg is passed by, its traffic goes to
 * that paid leg, and nothing caps what it spends there. One `!` line per such alias.
 */
export function guardShiftLines(gateway, { aliases = Object.keys(gateway?.cfg?.aliases || {}) } = {}) {
  const caps = parseSpendCaps(gateway?.cfg?.limits?.spend, gateway?.cfg?.adapters);
  const capped = (a) => caps.some((c) => c.target === a.id || (typeof a.account === 'string' && c.target === a.account));
  const lines = [];
  for (const alias of aliases) {
    let chain;
    try {
      chain = gateway.resolve(alias);
    } catch {
      continue;
    }
    const i = chain.findIndex((l) => l.adapter.creditGuard && !l.adapter.disabled);
    if (i < 0) continue;
    const paid = chain.slice(i + 1).filter((l) => l.adapter.kind === 'http' && (l.adapter.costBasis || 'metered') === 'metered' && !capped(l.adapter));
    if (!paid.length) continue;
    const g = chain[i];
    lines.push({
      mark: '!',
      text: `${alias}: ${g.target} is held back at ${pct(g.adapter.creditGuard.threshold)} of its Kiro plan, and from then on its requests go to ${paid.map((l) => l.target).join(', ')} — metered, and no spend cap covers ${paid.length > 1 ? 'them' : 'it'} (limits.spend.${paid[0].adapter.id})`,
    });
  }
  return lines;
}

/** The credit guard per login, with each adapter's threshold and state: `cfg` gives the thresholds of a process that holds no adapters (status). */
export function creditGuardRows(snapshot, { adapters = null, cfg = null } = {}) {
  const thresholdOf = (id) => {
    const a = adapters?.get?.(id);
    if (a?.creditGuard) return a.creditGuard.threshold;
    const raw = cfg?.adapters?.[id];
    try {
      return raw ? checkCreditGuard(id, raw, raw.bin || id)?.threshold ?? null : null;
    } catch {
      return null;
    }
  };
  return snapshot.map((s) => ({
    ...s,
    adapters: s.adapters.map((id) => {
      const threshold = thresholdOf(id);
      // check()'s rule (credit-guard.js guardState): a reading of this period holds an adapter at
      // or over its threshold back however many readings after it failed; none, or one from
      // before the plan reset, is unknown.
      const state = !s.reading || s.currentPeriod === false ? 'unknown' : threshold != null && evaluateCredits(s.reading, threshold).blocked ? 'held back' : 'ok';
      return { id, threshold, state, ...(s.stale && s.reading ? { stale: true } : {}) };
    }),
  }));
}

/**
 * The legs requests passed by within `hours`, from usage rows (newest first, as UsageLog.tail
 * gives them): `[{ target, reason, count, last, detail }]`, the latest first.
 */
export function recentSkips(rows, { now = Date.now(), hours = 24 } = {}) {
  const since = now - hours * 3_600_000;
  const by = new Map();
  for (const row of rows || []) {
    const t = Date.parse(row?.ts || '');
    if (!Number.isFinite(t) || t < since || !Array.isArray(row.skippedLegs)) continue;
    for (const s of row.skippedLegs) {
      if (!s?.target || !s?.reason) continue;
      const k = `${s.target}\u0000${s.reason}`;
      const e = by.get(k) || { target: s.target, reason: s.reason, count: 0, last: null, detail: s.detail || null };
      e.count++;
      if (!e.last || t > Date.parse(e.last)) {
        e.last = new Date(t).toISOString();
        if (s.detail) e.detail = s.detail;
      }
      by.set(k, e);
    }
  }
  return [...by.values()].sort((a, b) => Date.parse(b.last) - Date.parse(a.last));
}

function ago(ms) {
  if (ms == null) return 'never';
  if (ms < 90_000) return `${Math.round(ms / 1000)} s ago`;
  if (ms < 90 * 60_000) return `${Math.round(ms / 60_000)} min ago`;
  if (ms < 48 * 3_600_000) return `${Math.round(ms / 3_600_000)} h ago`;
  return `${Math.round(ms / 86_400_000)} d ago`;
}

/** Text lines for doctor and status: `{ mark, text }`, mark ✓ ! ✗ or ·. */
export function creditGuardLines(rows) {
  const lines = [];
  for (const r of rows) {
    const who = r.adapters.map((a) => `${a.id}${a.threshold != null ? ` (held back at ${pct(a.threshold)})` : ''}`).join(', ');
    if (!r.reading) {
      lines.push({ mark: '!', text: `${who}: no reading of the Kiro plan yet${r.error ? ` — the last one failed: ${r.error}` : ''}; not held back` });
      continue;
    }
    const held = r.adapters.filter((a) => a.state === 'held back').map((a) => a.id);
    const previous = r.currentPeriod === false;
    const state = held.length ? `HELD BACK: ${held.join(', ')}` : previous ? 'not held back (the reading is from before the plan reset)' : 'ok';
    // A failed newest reading: the one before it is gone by (the meter only climbs until the plan resets).
    const stale = r.stale ? ` · the newest reading failed, so this one is gone by until one succeeds: ${r.error}` : '';
    lines.push({
      mark: held.length ? '✗' : previous || r.stale ? '!' : '✓',
      text: `${who}: ${describeReading(r.reading)} · ${state} · read ${ago(r.ageMs)}${r.reading.resetsOn ? ` · plan resets ${r.reading.resetsOn}` : ''}${stale}`,
    });
  }
  return lines;
}

export function carriageLines(carriage) {
  const lines = [];
  const reasons = new Map(); // adapter -> detail, per face
  const byAlias = new Map();
  for (const c of carriage) {
    if (c.error) {
      lines.push({ mark: '!', text: `${c.alias}: ${c.error}` });
      continue;
    }
    (byAlias.get(c.alias) || byAlias.set(c.alias, []).get(c.alias)).push(c);
    for (const l of c.legs) if (!l.carries) reasons.set(`${l.adapter}\u0000${c.route}`, { adapter: l.adapter, route: c.route, detail: l.detail });
  }
  for (const [alias, faces] of byAlias) {
    const msgs = faces.find((f) => f.face === 'anthropic');
    const none = msgs && msgs.total > 0 && msgs.carried === 0;
    const parts = faces.map((f) => `${f.route} ${f.carried}/${f.total}${f.carried && f.carried < f.total ? ` (${f.legs.filter((l) => l.carries).map((l) => l.target).join(', ')})` : ''}`);
    lines.push({ mark: none ? '✗' : msgs && msgs.carried < msgs.total ? '!' : '✓', text: `${alias}: legs that carry tools — ${parts.join(' · ')}${none ? ' — a tool request on /v1/messages (Claude Code) to it is a 400' : ''}` });
  }
  const seen = new Set();
  for (const r of reasons.values()) {
    const k = `${r.adapter}\u0000${r.detail}`;
    if (seen.has(k)) continue;
    seen.add(k);
    lines.push({ mark: '·', text: `${r.adapter} on ${r.route}: ${r.detail}` });
  }
  return lines;
}

export function skipLines(skips, { limit = 8 } = {}) {
  if (!skips.length) return [{ mark: '✓', text: 'no leg was passed by in the last 24 h' }];
  const lines = skips.slice(0, limit).map((s) => ({ mark: s.reason === 'credit_guard' ? '!' : '·', text: `${s.target} ${s.reason} ×${s.count} (last ${s.last.slice(0, 16).replace('T', ' ')}Z)${s.detail ? ` — ${s.detail}` : ''}` }));
  if (skips.length > limit) lines.push({ mark: '·', text: `… and ${skips.length - limit} more (keysmith usage --format json --tail N has every row)` });
  return lines;
}
