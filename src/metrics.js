/**
 * Prometheus exposition format 0.0.4 for one `usage.query` report.
 * Every series is a gauge: the numbers are a rolling window, not a counter.
 * Pure: no I/O, and no key or fingerprint — model ids only.
 */

export const PROMETHEUS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

const GAUGE = 'A gauge over the rolling window, not a counter.';

/**
 * A finite number the way the text format prints one: no `NaN`, no scientific notation.
 * Null, missing and non-finite values are omitted by the caller.
 */
function formatValue(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  if (n === 0) return '0';
  const sign = n < 0 ? '-' : '';
  const text = String(Math.abs(n));
  if (/^\d+(\.\d+)?$/.test(text)) return sign + text;
  const expanded = expandScientific(text);
  if (!expanded || !/^\d+(\.\d+)?$/.test(expanded)) return null;
  return sign + expanded;
}

function expandScientific(text) {
  const m = /^(\d+)(?:\.(\d+))?e([+-]?\d+)$/i.exec(text);
  if (!m) return null;
  const digits = m[1] + (m[2] || '');
  const exp = Number(m[3]);
  if (!Number.isFinite(exp)) return null;
  const point = m[1].length + exp;
  let out;
  if (point <= 0) out = `0.${'0'.repeat(-point)}${digits}`;
  else if (point >= digits.length) out = digits + '0'.repeat(point - digits.length);
  else out = `${digits.slice(0, point)}.${digits.slice(point)}`;
  return out;
}

// Prometheus escapes `\`, a newline and `"` as `\\`, `\n` and `\"`. Backslash first,
// so a backslash we just wrote for a newline is not doubled again.
function escapeLabel(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

function sample(name, labels, value) {
  const rendered = formatValue(value);
  if (rendered === null) return null;
  const entries = Object.entries(labels);
  if (!entries.length) return `${name} ${rendered}`;
  const body = entries.map(([k, v]) => `${k}="${escapeLabel(v)}"`).join(',');
  return `${name}{${body}} ${rendered}`;
}

function family(name, help, samples) {
  const lines = [`# HELP ${name} ${help}`, `# TYPE ${name} gauge`];
  for (const line of samples) if (line) lines.push(line);
  return lines;
}

function modelOf(group) {
  if (!group || typeof group !== 'object') return null;
  return typeof group.model === 'string' && group.model ? group.model : null;
}

/**
 * @param {{ groups?: Array<{ model?: string, requests?: number|null, failures?: number|null, refused?: number|null, tokensIn?: number|null, tokensOut?: number|null, meteredUsd?: number|null, listUsd?: number|null, p95Ms?: number|null }> }} report
 * @param {{ windowHours?: number }} opts
 * @returns {string} exposition text, one HELP/TYPE pair per family
 */
export function formatPrometheus(report, { windowHours } = {}) {
  const groups = (Array.isArray(report?.groups) ? report.groups : [])
    .map((g) => ({ group: g, model: modelOf(g) }))
    .filter((g) => g.model);

  const byModel = (name, pick) => groups.map(({ group, model }) => sample(name, { model }, pick(group)));

  const cost = [];
  for (const { group, model } of groups) {
    const metered = sample('keysmith_cost_usd', { model, kind: 'metered' }, group.meteredUsd);
    const list = sample('keysmith_cost_usd', { model, kind: 'list' }, group.listUsd);
    if (metered) cost.push(metered);
    if (list) cost.push(list);
  }

  const windowLine = sample('keysmith_window_hours', {}, windowHours);
  const lines = [
    ...family('keysmith_requests', `Requests by model. ${GAUGE}`, byModel('keysmith_requests', (g) => g.requests)),
    ...family('keysmith_failures', `Failed requests by model. ${GAUGE}`, byModel('keysmith_failures', (g) => g.failures)),
    ...family('keysmith_refused', `Refused requests by model. ${GAUGE}`, byModel('keysmith_refused', (g) => g.refused)),
    ...family('keysmith_tokens_in', `Input tokens by model. ${GAUGE}`, byModel('keysmith_tokens_in', (g) => g.tokensIn)),
    ...family('keysmith_tokens_out', `Output tokens by model. ${GAUGE}`, byModel('keysmith_tokens_out', (g) => g.tokensOut)),
    ...family('keysmith_cost_usd', `Cost in USD by model and kind (metered or list). ${GAUGE}`, cost),
    ...family('keysmith_latency_p95_ms', `p95 latency in milliseconds by model. ${GAUGE}`, byModel('keysmith_latency_p95_ms', (g) => g.p95Ms)),
    ...family('keysmith_window_hours', `Length of the rolling window in hours. ${GAUGE}`, windowLine ? [windowLine] : []),
  ];
  return `${lines.join('\n')}\n`;
}
