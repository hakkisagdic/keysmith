import { rel } from './util.js';
import { configPath } from './config.js';
import { fmtUsd, windowCapLabel } from './usage.js';

/**
 * Determine UI language (`"tr"` or `"en"`) from `?lang=` query parameter or `Accept-Language` header.
 */
export function resolvePageLang(url = null, headers = {}) {
  const q = url?.searchParams?.get?.('lang')?.trim()?.toLowerCase();
  if (q === 'tr' || q === 'en') return q;
  const accept = String(headers?.['accept-language'] || '').trim().toLowerCase();
  if (/^tr\b/.test(accept)) return 'tr';
  return 'en';
}

const I18N = {
  en: {
    subtitlePrefix: 'OpenAI-compatible front for the agents already on this machine, up',
    configLabel: 'config',
    req24h: 'requests 24h (UTC hour)',
    failures: 'failures',
    tokensInOut: 'tokens in / out',
    modelsExposed: 'models exposed',
    adaptersTitle: 'Adapters',
    noAdapters: 'none configured: run <code>keysmith add &lt;profile&gt;</code>',
    failedTitle: 'Configured but did not load',
    aliasIssuesTitle: 'Alias legs that can never work',
    aliasIssuesHint: 'Failover hides these at request time: a dead first leg just looks like a slow provider, so this page is where the typo becomes visible.',
    modelsTitle: 'Models',
    noModels: 'no models listed: check <code>keysmith doctor</code>',
    keysTitle: 'Keys',
    spendCapsTitle: 'Spend caps',
    last24hTitle: 'Last 24h by model (rounded to the UTC hour)',
    cacheTitle: 'Response cache & cost savings',
    cacheStatus: 'status',
    cacheHitRate: 'hit rate',
    cacheHitsMisses: 'hits / misses',
    cacheSaved: 'saved spend',
    guardrailsTitle: 'KVKK & guardrail shield',
    guardrailMode: 'policy mode',
    guardrailMasked: 'PII masked',
    guardrailBlocked: 'PII blocked',
    guardrailInjections: 'injections blocked',
    billingTitle: 'Tenant wallets & plans',
    invoicesTitle: 'Recent invoices (20% VAT ledger)',
    promptsTitle: 'Prompt registry',
    noTenants: 'No tenants registered yet: create one via POST /v1/keysmith/billing/tenants',
    noInvoices: 'No invoices issued yet',
    noPrompts: 'No versioned prompt templates registered yet: add one via POST /v1/keysmith/prompts',
    loginSub: 'status page: the gateway key opens it',
    loginBtn: 'open',
    loginFailed: 'that key did not match',
  },
  tr: {
    subtitlePrefix: 'Bu makinedeki ajanlar ve sağlayıcılar için birleşik LLM ağ geçidi, çalışma süresi',
    configLabel: 'yapılandırma',
    req24h: 'son 24s istek (UTC saati)',
    failures: 'hatalar',
    tokensInOut: 'girdi / çıktı token',
    modelsExposed: 'açık modeller',
    adaptersTitle: 'Adaptörler ve Rotalar',
    noAdapters: 'yapılandırılmış adaptör yok: <code>keysmith add &lt;profil&gt;</code> çalıştırın',
    failedTitle: 'Yapılandırıldı ancak yüklenemedi',
    aliasIssuesTitle: 'Çalışamayacak takma ad (alias) bacakları',
    aliasIssuesHint: 'Yedekli geçiş (failover) istek anında bu hataları gizler; ilk bacaktaki yazım hatası burada görünür olur.',
    modelsTitle: 'Modeller',
    noModels: 'model listelenmedi: <code>keysmith doctor</code> ile kontrol edin',
    keysTitle: 'API Anahtarları',
    spendCapsTitle: 'Harcama tavanları',
    last24hTitle: 'Modele göre son 24 saat (UTC saatine yuvarlanmış)',
    cacheTitle: 'Yanıt önbelleği ve maliyet tasarrufu',
    cacheStatus: 'durum',
    cacheHitRate: 'isabet oranı',
    cacheHitsMisses: 'isabet / ıska',
    cacheSaved: 'kurtarılan maliyet',
    guardrailsTitle: 'KVKK ve güvenlik duvarı (Guardrails)',
    guardrailMode: 'politika modu',
    guardrailMasked: 'maskelenen PII',
    guardrailBlocked: 'engellenen PII',
    guardrailInjections: 'engellenen prompt injection',
    billingTitle: 'Kiracı cüzdanları ve paketler',
    invoicesTitle: 'Son faturalar (%20 KDV defteri)',
    promptsTitle: 'Merkezi prompt şablonları',
    noTenants: 'Henüz kayıtlı kiracı yok: POST /v1/keysmith/billing/tenants ile oluşturun',
    noInvoices: 'Henüz kesilmiş fatura kaydı bulunmuyor',
    noPrompts: 'Henüz sürümlü prompt şablonu yok: POST /v1/keysmith/prompts ile ekleyin',
    loginSub: 'operasyon konsolu: ağ geçidi anahtarı ile açılır',
    loginBtn: 'Konsolu aç',
    loginFailed: 'girilen anahtar eşleşmedi',
  },
};

/**
 * Operational workbench & status page at `/` and `/status` (DESIGN.md — Forged Workshop Slate + Brass).
 */
export function statusPage({
  cfg,
  models,
  usage,
  usageFilter = null,
  spend = null,
  usageErrors = [],
  startedAt,
  loadErrors = {},
  aliasIssues = {},
  viewer = null,
  keys = null,
  keyIssues = [],
  failover = null,
  lang = 'en',
  cacheStats = null,
  guardrailStats = null,
  billingSummary = null,
  prompts = null,
}) {
  const l = lang === 'tr' ? 'tr' : 'en';
  const t = I18N[l];
  const adapters = Object.entries(cfg.adapters || {});
  const failed = Object.entries(loadErrors);
  const aliasList = Object.entries(aliasIssues);
  const logErrors = usageErrors?.length ? usageErrors : (usage?.readErrors?.() || []);
  const summary = usage?.summarize?.(undefined, usageFilter) || {
    requests: 0,
    failures: 0,
    tokensIn: 0,
    tokensOut: 0,
    models: [],
    keys: [],
  };
  const spendCaps = spend ?? (usage?.spendSummary?.(cfg?.limits?.spend, { adapters: cfg?.adapters, filter: usageFilter }) || []);
  const spendRows = spendCaps
    .map((s) => {
      const spentCell =
        s.error || s.spent == null ? `unreadable / ${esc(fmtUsd(s.cap))}` : `${esc(fmtUsd(s.spent))} / ${esc(fmtUsd(s.cap))}`;
      const statusCell = s.window
        ? esc(windowCapLabel(s))
        : s.error
          ? `unreadable (${esc(s.error)})`
          : s.exceeded
            ? 'capped'
            : 'ok';
      const resetsCell = s.window
        ? s.window.invalid
          ? 'never'
          : `total ${esc(s.window.since)} … ${esc(s.window.until)}`
        : esc(s.resetAt);
      return `<tr><td>${esc(s.target)}</td><td class="muted">${esc(s.kind)}</td><td class="n ${s.exceeded ? 'bad' : ''}">${spentCell}</td><td class="${s.exceeded ? 'bad' : 'ok'}">${statusCell}</td><td class="muted nowrap">${resetsCell}</td></tr>`;
    })
    .join('');

  const perKey = new Map((summary.keys || []).map((k) => [k.key, k]));
  const keyRows = (keys || [])
    .map((k) => {
      const n = perKey.get(`fp:${k.fp}`) || { requests: 0, denied: 0 };
      const warned = (k.warnings || []).map((w) => `<br><span class="bad">! ${esc(w)}</span>`).join('');
      return `<tr><td>fp:${esc(k.fp)}</td><td>${esc(k.label || '-')}</td><td${/^INVALID/.test(k.scope) ? ' class="bad"' : ''}>${esc(k.scope)}${warned}</td><td class="n">${todayCell(k)}</td><td class="n">${n.requests}</td><td class="n ${n.denied ? 'bad' : ''}">${n.denied}</td></tr>`;
    })
    .join('');

  const rows = (summary.models || [])
    .slice(0, 12)
    .map(
      (m) =>
        `<tr><td>${esc(m.model)}</td><td class="n">${m.requests}</td><td class="n ${m.failures ? 'bad' : ''}">${m.failures}</td><td class="n">${fmt(m.input, l)}</td><td class="n">${fmt(m.output, l)}</td><td class="n nowrap">${m.p50Ms ?? 0} / ${m.p95Ms ?? 0} ms</td><td class="n nowrap">${m.requests ? Math.round(m.msTotal / m.requests) : 0} ms</td></tr>`,
    )
    .join('');

  const cStats = cacheStats || {
    enabled: Boolean(cfg?.cache?.enabled),
    hits: 0,
    misses: 0,
    hitRate: 0,
    savedUsd: 0,
    entries: 0,
  };
  const gStats = guardrailStats || {
    enabled: Boolean(cfg?.guardrails?.enabled),
    mode: cfg?.guardrails?.mode || 'mask',
    maskedCount: 0,
    blockedPiiCount: 0,
    blockedInjectionCount: 0,
  };
  const bTenants = billingSummary?.tenants || [];
  const bInvoices = billingSummary?.invoices || [];
  const promptList = Array.isArray(prompts) ? prompts : [];

  return `${headHtml(l)}
<body>
<main class="shell">
<header class="masthead">
  <div class="brand-row">
    <h1>key<span>smith</span></h1>
    <nav class="lang-switch" aria-label="Language">
      <a href="?lang=tr" class="lang-link${l === 'tr' ? ' active' : ''}">Türkçe</a>
      <a href="?lang=en" class="lang-link${l === 'en' ? ' active' : ''}">English</a>
    </nav>
  </div>
  <div class="sub">${t.subtitlePrefix} ${humanUptime(Date.now() - startedAt, l)} · ${t.configLabel} <code>${esc(rel(configPath()))}</code></div>
</header>
${viewer && viewer.scope && !/^unscoped/.test(viewer.scope) ? `<div class="sub">viewing as key fp:${esc(viewer.fp)}${viewer.label ? ` (${esc(viewer.label)})` : ''} — its scope: ${esc(viewer.scope)}. This page shows what that key can reach.</div>` : ''}
${viewer && viewer.perDay != null ? `<div class="sub">this key today: <b class="${(viewer.today?.requests || 0) >= viewer.perDay ? 'bad' : 'ok'}">${viewer.today?.requests || 0} of ${viewer.perDay}</b> requests${viewer.today?.refused ? `, ${viewer.today.refused} refused over the cap` : ''} — the count starts again at local midnight.</div>` : ''}
${logErrors.length ? `<p class="bad">${logErrors.map((e) => `usage log unreadable: ${esc(e)}`).join('<br>')}</p>` : ''}
<div class="grid kpi-strip">
  <div class="card"><small>${esc(t.req24h)}</small><b>${fmtInt(summary.requests, l)}</b></div>
  <div class="card"><small>${esc(t.failures)}</small><b class="${summary.failures ? 'bad' : 'ok'}">${fmtInt(summary.failures, l)}</b></div>
  <div class="card"><small>${esc(t.tokensInOut)}</small><b>${fmt(summary.tokensIn, l)} / ${fmt(summary.tokensOut, l)}</b></div>
  <div class="card"><small>${esc(t.modelsExposed)}</small><b>${fmtInt(models.length, l)}</b></div>
</div>

<h2>${esc(t.adaptersTitle)}</h2>
${
  adapters.length
    ? `<div class="grid">${adapters
        .map(
          ([id, a]) =>
            `<div class="card"><b>${esc(id)}</b><small>${a.kind === 'cli' ? `cli (${esc(a.bin || id)} / ${esc(a.parser || 'raw')})` : `http · ${esc(a.wire || 'openai')}`}<br><span class="pill">${a.disabled ? 'disabled' : a.priority ?? 100}</span>${a.toolMode && a.toolMode !== 'off' ? ` <span class="pill">tools: ${esc(a.toolMode)}</span>` : ''}${Object.hasOwn(loadErrors, id) ? ' <span class="bad">did not load</span>' : ''}</small></div>`,
        )
        .join('')}</div>`
    : `<div class="muted">${t.noAdapters}</div>`
}
${
  failed.length
    ? `<h2>${esc(t.failedTitle)}</h2><div class="table-wrap"><table><thead><tr><th>adapter</th><th>why</th></tr></thead><tbody>${failed
        .map(([id, msg]) => `<tr><td class="bad">${esc(id)}</td><td>${esc(msg)}</td></tr>`)
        .join('')}</tbody></table></div>`
    : ''
}
${
  aliasList.length
    ? `<h2>${esc(t.aliasIssuesTitle)}</h2><div class="table-wrap"><table><thead><tr><th>alias</th><th>why</th></tr></thead><tbody>${aliasList
        .map(([alias, problems]) => `<tr><td><b>${esc(alias)}</b></td><td>${problems.map((p) => esc(`alias "${alias}" ${p}`)).join('<br>')}</td></tr>`)
        .join('')}</tbody></table></div><p class="muted">${esc(t.aliasIssuesHint)}</p>`
    : ''
}

<h2>${esc(t.modelsTitle)}</h2>
<div class="table-wrap"><table><thead><tr><th>id</th><th>adapter</th><th>upstream</th><th class="n">context</th></tr></thead><tbody>
${
  models
    .map(
      (m) =>
        `<tr><td${m.keysmith?.kind === 'alias' && aliasIssues[m.id] ? ' class="bad"' : ''}>${esc(m.id)}</td><td class="muted">${esc(m.keysmith?.adapter || '')}</td><td class="muted">${esc(m.keysmith?.upstream || (Array.isArray(m.keysmith?.routes) ? m.keysmith.routes.join(' → ') : ''))}</td><td class="n">${m.keysmith?.contextWindow || ''}</td></tr>`,
    )
    .join('') || `<tr><td colspan="4" class="muted">${t.noModels}</td></tr>`
}
</tbody></table></div>

<div class="split-sections">
  <section class="panel-block">
    <h2>${esc(t.cacheTitle)}</h2>
    <div class="grid">
      <div class="card"><small>${esc(t.cacheStatus)}</small><b class="${cStats.enabled ? 'ok' : 'muted'}">${cStats.enabled ? (l === 'tr' ? 'etkin' : 'active') : (l === 'tr' ? 'kapalı' : 'off')}</b></div>
      <div class="card"><small>${esc(t.cacheHitRate)}</small><b>${fmtPct(cStats.hitRate || 0, l)}</b></div>
      <div class="card"><small>${esc(t.cacheHitsMisses)}</small><b>${fmtInt(cStats.hits || 0, l)} / ${fmtInt(cStats.misses || 0, l)}</b></div>
      <div class="card"><small>${esc(t.cacheSaved)}</small><b class="ok">${fmtCurrencyUsd(cStats.savedUsd || 0, l)}</b></div>
    </div>
  </section>
  <section class="panel-block">
    <h2>${esc(t.guardrailsTitle)}</h2>
    <div class="grid">
      <div class="card"><small>${esc(t.guardrailMode)}</small><b class="${gStats.enabled ? 'ok' : 'muted'}">${esc(gStats.enabled ? gStats.mode : (l === 'tr' ? 'kapalı' : 'off'))}</b></div>
      <div class="card"><small>${esc(t.guardrailMasked)}</small><b>${fmtInt(gStats.maskedCount || 0, l)}</b></div>
      <div class="card"><small>${esc(t.guardrailBlocked)}</small><b class="${gStats.blockedPiiCount ? 'bad' : ''}">${fmtInt(gStats.blockedPiiCount || 0, l)}</b></div>
      <div class="card"><small>${esc(t.guardrailInjections)}</small><b class="${gStats.blockedInjectionCount ? 'bad' : ''}">${fmtInt(gStats.blockedInjectionCount || 0, l)}</b></div>
    </div>
  </section>
</div>

${
  billingSummary
    ? `<h2>${esc(t.billingTitle)}</h2>
<div class="table-wrap"><table><thead><tr><th>${l === 'tr' ? 'kiracı' : 'tenant'}</th><th>${l === 'tr' ? 'paket' : 'plan'}</th><th>${l === 'tr' ? 'mod' : 'mode'}</th><th class="n">${l === 'tr' ? 'bakiye (USD / TRY)' : 'balance (USD / TRY)'}</th><th class="n">${l === 'tr' ? 'aylık kota' : 'monthly quota'}</th></tr></thead><tbody>
${
  bTenants.length
    ? bTenants
        .map(
          (ten) =>
            `<tr><td><b>${esc(ten.id)}</b> <span class="muted">${esc(ten.name !== ten.id ? ten.name : '')}</span></td><td><span class="pill">${esc(ten.plan)}</span></td><td class="muted">${esc(ten.billingMode)}</td><td class="n nowrap">${fmtCurrencyUsd(ten.balanceUsd, l)} · ${fmtCurrencyTry(ten.balanceTry, l)}</td><td class="n nowrap">${fmtInt(ten.monthlyRequestsUsed || 0, l)} / ${fmtInt(ten.monthlyRequestsLimit || 0, l)}</td></tr>`,
        )
        .join('')
    : `<tr><td colspan="5" class="muted">${esc(t.noTenants)}</td></tr>`
}
</tbody></table></div>
${
  bInvoices.length
    ? `<h2>${esc(t.invoicesTitle)}</h2><div class="table-wrap"><table><thead><tr><th>${l === 'tr' ? 'fatura no' : 'invoice'}</th><th>${l === 'tr' ? 'kiracı' : 'tenant'}</th><th class="n">${l === 'tr' ? 'ara toplam' : 'subtotal'}</th><th class="n">${l === 'tr' ? 'KDV (%20)' : 'VAT (20%)'}</th><th class="n">${l === 'tr' ? 'toplam' : 'total'}</th><th class="n">${l === 'tr' ? 'tarih' : 'issued'}</th></tr></thead><tbody>${bInvoices
        .slice(-8)
        .reverse()
        .map(
          (inv) =>
            `<tr><td>${esc(inv.id)}</td><td>${esc(inv.tenantId)}</td><td class="n nowrap">${fmtInvoiceMoney(inv.subtotal, inv.currency, l)}</td><td class="n nowrap">${fmtInvoiceMoney(inv.vatAmount, inv.currency, l)}</td><td class="n nowrap"><b>${fmtInvoiceMoney(inv.total, inv.currency, l)}</b></td><td class="n muted nowrap">${fmtDate(inv.issuedAt, l)}</td></tr>`,
        )
        .join('')}</tbody></table></div>`
    : ''
}`
    : ''
}

${
  prompts !== null
    ? `<h2>${esc(t.promptsTitle)}</h2>
<div class="table-wrap"><table><thead><tr><th>id</th><th class="n">${l === 'tr' ? 'sürüm' : 'version'}</th><th>${l === 'tr' ? 'model' : 'model'}</th><th>${l === 'tr' ? 'değişkenler' : 'variables'}</th><th class="n">${l === 'tr' ? 'güncelleme' : 'updated'}</th></tr></thead><tbody>
${
  promptList.length
    ? promptList
        .map(
          (p) =>
            `<tr><td><b>${esc(p.id)}</b></td><td class="n">v${esc(p.version ?? 1)}</td><td class="muted">${esc(p.model || '-')}</td><td class="muted">${esc((p.variables || []).join(', ') || '-')}</td><td class="n muted nowrap">${fmtDate(p.updatedAt, l)}</td></tr>`,
        )
        .join('')
    : `<tr><td colspan="5" class="muted">${esc(t.noPrompts)}</td></tr>`
}
</tbody></table></div>`
    : ''
}

${
  keys
    ? `<h2>${l === 'tr' ? 'Keys' : 'Keys'}</h2><div class="table-wrap"><table><thead><tr><th>key</th><th>label</th><th>scope</th><th class="n">today / cap</th><th class="n">req 24h (UTC hour)</th><th class="n">denied</th></tr></thead><tbody>${keyRows}</tbody></table></div>${keyIssues.length ? `<p class="bad">${keyIssues.map(esc).join('<br>')}</p>` : ''}<p class="muted">A key is named by its fingerprint. <code>keysmith key scope fp:&lt;hex&gt; --deny &lt;adapter&gt;</code> narrows one, <code>--per-day N</code> caps its requests per local day; <code>keysmith key who-can &lt;adapter&gt;</code> lists the keys that reach an adapter.</p>`
    : ''
}
${failover ? failoverSection(failover) : ''}
${
  spendRows
    ? `<h2>${esc(t.spendCapsTitle)}${spendCaps.find((s) => s.month) ? ` (${esc(spendCaps.find((s) => s.month).month)})` : ''}</h2><div class="table-wrap"><table><thead><tr><th>target</th><th>kind</th><th class="n">spent / cap</th><th>status</th><th>resets</th></tr></thead><tbody>${spendRows}</tbody></table></div>`
    : ''
}
${
  rows
    ? `<h2>${esc(t.last24hTitle)}</h2><div class="table-wrap"><table><thead><tr><th>model</th><th class="n">req</th><th class="n">err</th><th class="n">in</th><th class="n">out</th><th class="n">p50 / p95</th><th class="n">avg</th></tr></thead><tbody>${rows}</tbody></table></div>`
    : ''
}
<p class="muted footer-note">Keys never leave this machine’s config. <code>Authorization: Bearer &lt;key&gt;</code> is required on /v1. This page takes the key once, through its form, and keeps a cookie that opens this page alone for an hour.</p>
</main>
</body></html>`;
}

/**
 * The status page's door. The key is posted, never put in the address.
 */
export function loginPage({ action = '/', failed = false, lang = 'en' } = {}) {
  const l = lang === 'tr' ? 'tr' : 'en';
  const t = I18N[l];
  return `${headHtml(l)}
<body>
<main class="shell">
<header class="masthead">
  <div class="brand-row">
    <h1>key<span>smith</span></h1>
    <nav class="lang-switch" aria-label="Language">
      <a href="?lang=tr" class="lang-link${l === 'tr' ? ' active' : ''}">Türkçe</a>
      <a href="?lang=en" class="lang-link${l === 'en' ? ' active' : ''}">English</a>
    </nav>
  </div>
  <div class="sub">${esc(t.loginSub)}</div>
</header>
<form method="post" action="${esc(action)}" class="login-row">
  <input type="password" name="api_key" autocomplete="current-password" placeholder="ks_…" required autofocus aria-label="API Key">
  <button type="submit">${esc(t.loginBtn)}</button>
</form>
${failed ? `<p class="bad">${esc(t.loginFailed)}</p>` : ''}
<p class="muted">The key goes in the request body, not the address. This browser gets a cookie for this page alone, good for an hour; the API still wants <code>Authorization: Bearer &lt;key&gt;</code>.</p>
</main>
</body></html>`;
}

function headHtml(lang = 'en') {
  return `<!doctype html>
<html lang="${lang === 'tr' ? 'tr' : 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="description" content="Keysmith operational LLM gateway routing, cache, KVKK guardrail, and tenant billing console.">
<title>keysmith</title>
<style>
  :root {
    color-scheme: dark;
    --bg-canvas: #0b0e13;
    --bg-surface: #121721;
    --bg-hover: #181f2c;
    --th-bg: rgba(255, 255, 255, 0.02);
    --selection-bg: rgba(212, 162, 76, 0.28);
    --border-hairline: #21293a;
    --border-strong: #2d384f;
    --text-primary: #e6ebf2;
    --text-muted: #94a0b8;
    --accent-brass: #d4a24c;
    --accent-brass-hover: #dfb05c;
    --accent-brass-active: #c3913b;
    --on-accent: #0b0e13;
    --status-ok: #4fd18b;
    --status-bad: #f07171;
    --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    --font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    --radius-md: 6px;
    --radius-sm: 4px;
  }
  *, *::before, *::after { box-sizing: border-box; }
  ::selection { background: var(--selection-bg); color: var(--text-primary); }
  html, body {
    overflow-x: clip;
  }
  body {
    margin: 0;
    padding: 24px 16px 40px;
    background: var(--bg-canvas);
    color: var(--text-primary);
    font: 400 14px/1.5 var(--font-sans);
    font-variant-numeric: tabular-nums;
    caret-color: var(--accent-brass);
  }
  @media (min-width: 768px) {
    body { padding: 32px 32px 48px; }
  }
  .shell {
    max-width: 1200px;
    margin: 0 auto;
    width: 100%;
  }
  .masthead {
    border-top: 2px solid var(--accent-brass);
    padding-top: 12px;
    margin-bottom: 20px;
  }
  .brand-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
    margin-bottom: 4px;
  }
  h1, h2 {
    text-wrap: balance;
  }
  h1 {
    font-size: 22px;
    font-weight: 600;
    line-height: 1.25;
    margin: 0;
    color: var(--accent-brass);
    letter-spacing: -0.01em;
  }
  .lang-switch {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    background: var(--bg-surface);
    color: var(--text-primary);
    border: 1px solid var(--border-hairline);
    border-radius: var(--radius-md);
    padding: 4px;
  }
  .lang-link {
    display: inline-flex;
    align-items: center;
    height: 32px;
    padding: 0 12px;
    font-size: 13px;
    font-weight: 500;
    color: var(--text-muted);
    text-decoration: none;
    border-radius: var(--radius-sm);
    transition: color 150ms cubic-bezier(0.22, 1, 0.36, 1), background-color 150ms cubic-bezier(0.22, 1, 0.36, 1);
  }
  .lang-link:hover { color: var(--text-primary); background: var(--bg-hover); }
  .lang-link:active { background: var(--bg-hover); color: var(--text-primary); }
  .lang-link.active {
    background: var(--accent-brass);
    color: var(--on-accent);
    font-weight: 600;
  }
  .sub {
    color: var(--text-muted);
    font-size: 13px;
    margin-bottom: 12px;
    max-width: 75ch;
    overflow-wrap: anywhere;
  }
  h2 {
    font-size: 16px;
    font-weight: 600;
    line-height: 1.35;
    color: var(--text-primary);
    margin: 24px 0 8px;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(min(100%, 200px), 1fr));
    gap: 12px;
  }
  .kpi-strip .card {
    border-top: 2px solid var(--accent-brass);
  }
  .card {
    background: var(--bg-surface);
    color: var(--text-primary);
    border: 1px solid var(--border-hairline);
    border-radius: var(--radius-md);
    padding: 12px 16px;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .card b {
    display: block;
    font-size: 16px;
    font-weight: 600;
    margin-top: 4px;
    font-variant-numeric: tabular-nums;
  }
  .card small {
    display: block;
    font-size: 12px;
    color: var(--text-muted);
  }
  .pill {
    display: inline-block;
    padding: 0 8px;
    border-radius: var(--radius-sm);
    font-size: 12px;
    line-height: 1.5;
    border: 1px solid var(--border-strong);
    color: var(--text-muted);
    margin-top: 4px;
  }
  .split-sections {
    display: grid;
    grid-template-columns: 1fr;
    gap: 16px;
  }
  @media (min-width: 960px) {
    .split-sections {
      grid-template-columns: 1fr 1fr;
    }
  }
  .table-wrap {
    width: 100%;
    max-width: 100%;
    overflow-x: auto;
    border: 1px solid var(--border-hairline);
    border-radius: var(--radius-md);
    background: var(--bg-surface);
    color: var(--text-primary);
  }
  table {
    border-collapse: collapse;
    width: 100%;
    font-size: 13px;
    font-variant-numeric: tabular-nums;
  }
  th, td {
    padding: 8px 12px;
    border-bottom: 1px solid var(--border-hairline);
    text-align: left;
    vertical-align: top;
  }
  th {
    font-weight: 500;
    color: var(--text-muted);
    background: var(--th-bg);
    white-space: nowrap;
  }
  tbody tr:last-child td { border-bottom: none; }
  tbody tr:hover { background: var(--bg-hover); }
  .n { text-align: right; font-variant-numeric: tabular-nums; }
  .nowrap { white-space: nowrap; }
  .bad { color: var(--status-bad); }
  .ok { color: var(--status-ok); }
  .muted { color: var(--text-muted); }
  code {
    font-family: var(--font-mono);
    font-size: 12px;
    background: var(--bg-surface);
    color: var(--text-primary);
    border: 1px solid var(--border-hairline);
    padding: 0 4px;
    border-radius: var(--radius-sm);
  }
  .login-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    margin: 16px 0;
  }
  input, button {
    font: inherit;
    height: 36px;
    border-radius: var(--radius-md);
    padding: 0 12px;
    transition: color 150ms cubic-bezier(0.22, 1, 0.36, 1), background-color 150ms cubic-bezier(0.22, 1, 0.36, 1), border-color 150ms cubic-bezier(0.22, 1, 0.36, 1);
  }
  input {
    color: var(--text-primary);
    background: var(--bg-surface);
    border: 1px solid var(--border-strong);
    width: min(26em, 100%);
  }
  button {
    cursor: pointer;
    font-weight: 600;
    background: var(--accent-brass);
    color: var(--on-accent);
    border: 1px solid var(--accent-brass);
  }
  button:hover { background: var(--accent-brass-hover); color: var(--on-accent); }
  button:active { background: var(--accent-brass-active); color: var(--on-accent); }
  button:disabled, input:disabled, [aria-disabled="true"] { opacity: 0.5; cursor: not-allowed; }
  a:focus-visible, button:focus-visible, input:focus-visible {
    outline: 2px solid var(--accent-brass);
    outline-offset: 2px;
  }
  .footer-note {
    margin-top: 24px;
    max-width: 75ch;
  }
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { transition: none !important; }
  }
</style></head>`;
}

/**
 * The Kiro credit guard and the legs requests were passed by (src/failover-report.js), for an
 * unscoped viewer: `{ guards: [{ mark, text }], skips: [{ mark, text }] }`.
 */
function failoverSection({ guards = [], skips = [] }) {
  const row = (l) => `<tr><td class="${l.mark === '✗' ? 'bad' : l.mark === '✓' ? 'ok' : 'muted'}">${esc(l.mark)}</td><td>${esc(l.text)}</td></tr>`;
  return `${guards.length ? `<h2>Kiro credit guard</h2><div class="table-wrap"><table><tbody>${guards.map(row).join('')}</tbody></table></div>` : ''}<h2>Legs passed by (24h)</h2><div class="table-wrap"><table><tbody>${skips.map(row).join('')}</tbody></table></div><p class="muted">A leg that cannot carry a request’s tools, or that the credit guard holds back, is passed by and named in the usage row (<code>skippedLegs</code>). <code>keysmith doctor</code> lists which legs of each alias carry tools.</p>`;
}

/** A key's requests today, with its daily cap and the refusals over it when it has one. */
function todayCell(k) {
  const n = k.today?.requests || 0;
  if (k.perDay == null) return String(n);
  const over = n >= k.perDay;
  return `<span class="${over ? 'bad' : ''}">${n} / ${k.perDay}</span>${k.today?.refused ? `<br><span class="bad">${k.today.refused} refused</span>` : ''}`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

function fmt(n, lang = 'en') {
  if (n == null) return '-';
  n = Number(n) || 0;
  const sep = lang === 'tr' ? ',' : '.';
  if (n > 1e6) return (n / 1e6).toFixed(1).replace('.', sep) + 'M';
  if (n > 1e3) return (n / 1e3).toFixed(1).replace('.', sep) + (lang === 'tr' ? 'B' : 'k');
  return String(n);
}

function fmtInt(n, lang = 'en') {
  const v = Number(n) || 0;
  return v.toLocaleString(lang === 'tr' ? 'tr-TR' : 'en-US');
}

function fmtPct(rate, lang = 'en') {
  const pct = ((Number(rate) || 0) * 100).toFixed(1);
  return lang === 'tr' ? `%${pct.replace('.', ',')}` : `${pct}%`;
}

function fmtCurrencyUsd(usd, lang = 'en') {
  const v = Number(usd) || 0;
  const digits = v > 0 && v < 0.01 ? 4 : 2;
  const formatted = v.toFixed(digits);
  return lang === 'tr' ? `$${formatted.replace('.', ',')}` : `$${formatted}`;
}

function fmtCurrencyTry(tryAmt, lang = 'en') {
  const v = Number(tryAmt) || 0;
  const formatted = v.toLocaleString(lang === 'tr' ? 'tr-TR' : 'en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return lang === 'tr' ? `${formatted} ₺` : `₺${formatted}`;
}

function fmtInvoiceMoney(amt, currency = 'TRY', lang = 'en') {
  return currency === 'USD' ? fmtCurrencyUsd(amt, lang) : fmtCurrencyTry(amt, lang);
}

function fmtDate(iso, lang = 'en') {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const pad = (x) => String(x).padStart(2, '0');
  const yyyy = d.getUTCFullYear();
  const mm = pad(d.getUTCMonth() + 1);
  const dd = pad(d.getUTCDate());
  const hh = pad(d.getUTCHours());
  const min = pad(d.getUTCMinutes());
  return lang === 'tr' ? `${dd}.${mm}.${yyyy} ${hh}:${min}` : `${yyyy}-${mm}-${dd} ${hh}:${min}`;
}

function humanUptime(ms, lang = 'en') {
  const m = Math.max(0, Math.floor(ms / 60000));
  if (m < 60) return lang === 'tr' ? `${m}dk` : `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return lang === 'tr' ? `${h}sa ${m % 60}dk` : `${h}h ${m % 60}m`;
  return lang === 'tr' ? `${Math.floor(h / 24)}g` : `${Math.floor(h / 24)}d`;
}
