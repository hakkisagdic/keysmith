import { rel } from './util.js';
import { configPath } from './config.js';

/**
 * A one-screen status page at `/`. Not a product — a place to see, in a browser,
 * which adapters loaded and what the last requests cost, without opening a terminal.
 */
export function statusPage({ cfg, models, usage, startedAt, loadErrors = {}, aliasIssues = {} }) {
  const adapters = Object.entries(cfg.adapters || {});
  const failed = Object.entries(loadErrors);
  const aliasList = Object.entries(aliasIssues);
  const summary = usage?.summarize?.() || { requests: 0, failures: 0, tokensIn: 0, tokensOut: 0, models: [] };
  const rows = (summary.models || [])
    .slice(0, 12)
    .map((m) => `<tr><td>${esc(m.model)}</td><td class="n">${m.requests}</td><td class="n ${m.failures ? 'bad' : ''}">${m.failures}</td><td class="n">${fmt(m.input)}</td><td class="n">${fmt(m.output)}</td><td class="n">${Math.round(m.msTotal / m.requests)} ms</td></tr>`)
    .join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>keysmith</title>
<style>
 :root{color-scheme:dark} body{margin:0;padding:40px;background:#0d1017;color:#e6e9f0;font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}
 h1{font-size:20px;margin:0 0 4px} h1 span{color:#7c8cff} .sub{color:#8891a6;margin-bottom:28px}
 h2{font-size:13px;text-transform:uppercase;letter-spacing:.08em;color:#8891a6;margin:28px 0 10px}
 .grid{display:flex;flex-wrap:wrap;gap:10px}
 .card{background:#151a26;border:1px solid #232a3b;border-radius:8px;padding:10px 12px;min-width:180px}
 .card b{display:block} .card small{color:#8891a6}
 .pill{display:inline-block;padding:1px 7px;border-radius:99px;font-size:11px;border:1px solid #2e3a52;color:#9fb0d8}
 table{border-collapse:collapse;width:100%;font-size:13px} th,td{padding:6px 8px;border-bottom:1px solid #1e2433;text-align:left}
 .n{text-align:right} .bad{color:#ff7b7b} .ok{color:#6ee7a0} .muted{color:#8891a6}
 code{background:#151a26;padding:1px 5px;border-radius:4px}
</style></head>
<body>
<h1>key<span>smith</span></h1>
<div class="sub">OpenAI-compatible front for the agents already on this machine · up ${humanUptime(Date.now() - startedAt)} · config <code>${esc(rel(configPath()))}</code></div>
<div class="grid">
  <div class="card"><small>requests 24h</small><b>${summary.requests}</b></div>
  <div class="card"><small>failures</small><b class="${summary.failures ? 'bad' : 'ok'}">${summary.failures}</b></div>
  <div class="card"><small>tokens in / out</small><b>${fmt(summary.tokensIn)} / ${fmt(summary.tokensOut)}</b></div>
  <div class="card"><small>models exposed</small><b>${models.length}</b></div>
</div>
<h2>Adapters</h2>
${adapters.length ? `<div class="grid">${adapters
    .map(([id, a]) => `<div class="card"><b>${esc(id)}</b><small>${a.kind === 'cli' ? `cli · ${esc(a.bin || id)} · ${esc(a.parser || 'raw')}` : `http · ${esc(a.wire || 'openai')}`}<br><span class="pill">${a.disabled ? 'disabled' : a.priority ?? 100}</span>${loadErrors[id] ? ' <span class="bad">did not load</span>' : ''}</small></div>`)
    .join('')}</div>` : '<div class="muted">none configured — run <code>keysmith add cmd</code></div>'}
${failed.length ? `<h2>Configured but did not load</h2><table><thead><tr><th>adapter</th><th>why</th></tr></thead><tbody>${failed
    .map(([id, msg]) => `<tr><td class="bad">${esc(id)}</td><td>${esc(msg)}</td></tr>`)
    .join('')}</tbody></table>` : ''}
${aliasList.length ? `<h2>Alias legs that can never work</h2><table><thead><tr><th>alias</th><th>why</th></tr></thead><tbody>${aliasList
    .map(([alias, problems]) => `<tr><td><b>${esc(alias)}</b></td><td>${problems.map((p) => esc(`alias "${alias}" ${p}`)).join('<br>')}</td></tr>`)
    .join('')}</tbody></table><p class="muted">Failover hides these at request time — a dead first leg just looks like a slow provider, so this page is where the typo becomes visible.</p>` : ''}
<h2>Models</h2>
<table><thead><tr><th>id</th><th>adapter</th><th>upstream</th><th>context</th></tr></thead><tbody>
${models.map((m) => `<tr><td${m.keysmith?.kind === 'alias' && aliasIssues[m.id] ? ' class="bad"' : ''}>${esc(m.id)}</td><td class="muted">${esc(m.keysmith?.adapter || '')}</td><td class="muted">${esc(m.keysmith?.upstream || '')}</td><td class="n">${m.keysmith?.contextWindow || ''}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">no models listed — check <code>keysmith doctor</code></td></tr>'}
</tbody></table>
${rows ? `<h2>Last 24h by model</h2><table><thead><tr><th>model</th><th class="n">req</th><th class="n">err</th><th class="n">in</th><th class="n">out</th><th class="n">avg</th></tr></thead><tbody>${rows}</tbody></table>` : ''}
<p class="muted">Keys never leave this machine's config. <code>Authorization: Bearer &lt;key&gt;</code> is required on /v1 — and here, as <code>?api_key=…</code>.</p>
</body></html>`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}
function fmt(n) {
  n = n || 0;
  return n > 1e6 ? (n / 1e6).toFixed(1) + 'M' : n > 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n);
}
function humanUptime(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d`;
}
