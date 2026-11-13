import fs from 'node:fs';
import path from 'node:path';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { LlmError } from './util.js';
import { roundUsd } from './usage.js';

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

/**
 * Official Keysmith commercial plans (aligned with docs/GELIR_MODELI.md).
 */
export const DEFAULT_PLANS = Object.freeze({
  starter: Object.freeze({
    id: 'starter',
    nameTr: 'Starter (Ücretsiz)',
    nameEn: 'Starter (Free)',
    monthlyTry: 0,
    annualTry: 0,
    monthlyUsd: 0,
    annualUsd: 0,
    monthlyRequests: 15_000,
    overagePer100kTry: 0,
    overagePer100kUsd: 0,
    maxKeys: 3,
    maxTenants: 1,
    trialDays: 0,
    features: Object.freeze({
      cache: false,
      rateLimitRpmTpm: false,
      guardrails: 'off',
      promptRegistry: false,
      routingStrategies: false,
      metricsAndWebhooks: false,
      resellerMarkup: false,
    }),
  }),
  pro: Object.freeze({
    id: 'pro',
    nameTr: 'Pro (Bireysel Profesyonel)',
    nameEn: 'Pro (Individual)',
    monthlyTry: 990,
    annualTry: 9_900,
    monthlyUsd: 29,
    annualUsd: 290,
    monthlyRequests: 150_000,
    overagePer100kTry: 290,
    overagePer100kUsd: 8,
    maxKeys: 25,
    maxTenants: 5,
    trialDays: 14,
    features: Object.freeze({
      cache: true,
      rateLimitRpmTpm: true,
      guardrails: 'audit',
      promptRegistry: true,
      routingStrategies: false,
      metricsAndWebhooks: 'metrics_only',
      resellerMarkup: false,
    }),
  }),
  team: Object.freeze({
    id: 'team',
    nameTr: 'Team (Ekip & Ajans)',
    nameEn: 'Team (Agency & Startup)',
    monthlyTry: 3_990,
    annualTry: 39_900,
    monthlyUsd: 119,
    annualUsd: 1_190,
    monthlyRequests: 750_000,
    overagePer100kTry: 220,
    overagePer100kUsd: 6,
    maxKeys: 250,
    maxTenants: 50,
    trialDays: 14,
    features: Object.freeze({
      cache: true,
      rateLimitRpmTpm: true,
      guardrails: 'full',
      promptRegistry: true,
      routingStrategies: true,
      metricsAndWebhooks: 'full',
      resellerMarkup: true,
    }),
  }),
  enterprise: Object.freeze({
    id: 'enterprise',
    nameTr: 'Enterprise (Kurumsal)',
    nameEn: 'Enterprise',
    monthlyTry: 19_900,
    annualTry: 199_000,
    monthlyUsd: 590,
    annualUsd: 5_900,
    monthlyRequests: 5_000_000,
    overagePer100kTry: 150,
    overagePer100kUsd: 4,
    maxKeys: 10_000,
    maxTenants: 1_000,
    trialDays: 14,
    features: Object.freeze({
      cache: true,
      rateLimitRpmTpm: true,
      guardrails: 'full',
      promptRegistry: true,
      routingStrategies: true,
      metricsAndWebhooks: 'full',
      resellerMarkup: true,
    }),
  }),
});

/**
 * Compute iyzico IYZWSv2 authorization header (`IYZWSv2 <base64(apiKey:...&randomKey:...&signature:...)>`).
 * Secrets are passed from runtime env/resolver only and never persisted or logged.
 */
export function buildIyzicoAuthHeader({ apiKey, secretKey, uriPath = '/payment/iyzipos/checkoutform/initialize/auth/ecom', body = {}, randomKey = null }) {
  if (!apiKey || !secretKey) {
    throw new LlmError('iyzico credentials are not configured in environment (IYZICO_API_KEY / IYZICO_SECRET_KEY)', {
      status: 503,
      type: 'billing_configuration_error',
    });
  }
  const rnd = randomKey || randomBytes(12).toString('hex');
  const payloadStr = typeof body === 'string' ? body : JSON.stringify(body);
  const signature = createHmac('sha256', String(secretKey))
    .update(`${rnd}${uriPath}${payloadStr}`, 'utf8')
    .digest('hex');
  const rawToken = `apiKey:${apiKey}&randomKey:${rnd}&signature:${signature}`;
  return {
    authorization: `IYZWSv2 ${Buffer.from(rawToken, 'utf8').toString('base64')}`,
    randomKey: rnd,
    signature,
  };
}

/**
 * Compute or verify iyzico Webhook v3 HMAC-SHA256 signature (`x-iyz-signature-v3`).
 * According to iyzico webhook specification: HMAC-SHA256 over `secretKey + iyziEventType + paymentId + paymentConversationId + status`
 * (or raw body fallback when custom webhook payload is signed directly).
 */
export function computeIyzicoWebhookSignature(secretKey, payload = {}) {
  const obj = typeof payload === 'string' ? JSON.parse(payload) : payload || {};
  const msg = `${secretKey}${obj.iyziEventType || ''}${obj.paymentId || obj.iyziPaymentId || ''}${obj.paymentConversationId || obj.conversationId || ''}${obj.status || ''}`;
  return createHmac('sha256', String(secretKey)).update(msg, 'utf8').digest('hex');
}

export function verifyIyzicoWebhook({ secretKey, signatureHeader, rawBody, parsedBody }) {
  if (!secretKey || typeof signatureHeader !== 'string' || !signatureHeader.trim()) return false;
  const sig = signatureHeader.trim().toLowerCase();
  const expectedStructured = computeIyzicoWebhookSignature(secretKey, parsedBody || {});
  const expectedRaw = createHmac('sha256', String(secretKey))
    .update(typeof rawBody === 'string' ? rawBody : JSON.stringify(parsedBody || {}), 'utf8')
    .digest('hex');
  return safeHexEqual(sig, expectedStructured) || safeHexEqual(sig, expectedRaw);
}

function safeHexEqual(a, b) {
  const ba = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * Billing, Tenant Wallet, Plan Quota & Invoice Ledger Manager.
 */
export class BillingManager {
  constructor(cfg = {}, { stateFile = null, invoicesFile = null, now = () => Date.now() } = {}) {
    this.now = now;
    const raw = cfg?.billing && typeof cfg.billing === 'object' && !Array.isArray(cfg.billing) ? cfg.billing : {};
    this.enabled = raw.enabled === true;
    this.provider = ['iyzico', 'stripe', 'manual'].includes(raw.provider) ? raw.provider : 'iyzico';
    this.defaultVatRate = Number.isFinite(Number(raw.vatRate)) && Number(raw.vatRate) >= 0 ? Number(raw.vatRate) : 0.2;
    this.fxTryPerUsd = Number.isFinite(Number(raw.fxTryPerUsd)) && Number(raw.fxTryPerUsd) > 0 ? Number(raw.fxTryPerUsd) : 34.5;
    this.defaultMarkupPct = Number.isFinite(Number(raw.defaultMarkupPct)) && Number(raw.defaultMarkupPct) >= 0 ? Number(raw.defaultMarkupPct) : 5;
    this.stateFile = stateFile || raw.stateFile || null;
    this.invoicesFile = invoicesFile || raw.invoicesFile || null;

    this.plans = { ...DEFAULT_PLANS };
    if (raw.plans && typeof raw.plans === 'object') {
      for (const [id, custom] of Object.entries(raw.plans)) {
        if (custom && typeof custom === 'object') {
          this.plans[id] = { ...(this.plans[id] || DEFAULT_PLANS.starter), ...custom, id };
        }
      }
    }

    this.tenants = new Map(); // tenantId -> tenant object
    this.pendingCheckouts = new Map(); // conversationId -> checkout session
    this.invoices = [];

    if (raw.tenants && typeof raw.tenants === 'object') {
      for (const [id, t] of Object.entries(raw.tenants)) {
        if (t && typeof t === 'object') this._putTenant(id, t, { persist: false });
      }
    }
    this._loadFromDisk();
  }

  _putTenant(id, raw = {}, { persist = true } = {}) {
    const tenantId = String(id || raw.id || '').trim();
    if (!tenantId) throw new LlmError('tenant id is required', { status: 400, type: 'invalid_request_error' });
    const planId = this.plans[raw.plan] ? raw.plan : 'starter';
    const plan = this.plans[planId];
    const existing = this.tenants.get(tenantId);
    const tenant = {
      id: tenantId,
      name: String(raw.name ?? existing?.name ?? tenantId).trim(),
      plan: planId,
      billingMode: ['prepaid', 'postpaid'].includes(raw.billingMode ?? existing?.billingMode)
        ? (raw.billingMode ?? existing.billingMode)
        : 'prepaid',
      currency: ['TRY', 'USD'].includes(raw.currency ?? existing?.currency) ? (raw.currency ?? existing.currency) : 'USD',
      balanceUsd: roundUsd(Number(raw.balanceUsd ?? existing?.balanceUsd ?? 0) || 0),
      balanceTry: roundMoney(Number(raw.balanceTry ?? existing?.balanceTry ?? 0) || 0),
      markupPct: Number.isFinite(Number(raw.markupPct ?? existing?.markupPct))
        ? Number(raw.markupPct ?? existing.markupPct)
        : this.defaultMarkupPct,
      vatExempt: Boolean(raw.vatExempt ?? existing?.vatExempt ?? false),
      taxId: raw.taxId ?? existing?.taxId ?? null,
      taxOffice: raw.taxOffice ?? existing?.taxOffice ?? null,
      email: raw.email ?? existing?.email ?? null,
      keys: Array.isArray(raw.keys)
        ? [...new Set(raw.keys.map((k) => String(k).replace(/^fp:/, '').trim()).filter(Boolean))]
        : existing?.keys || [],
      monthlyRequestsUsed: Number(raw.monthlyRequestsUsed ?? existing?.monthlyRequestsUsed ?? 0) || 0,
      monthlyRequestsLimit:
        raw.monthlyRequestsLimit !== undefined
          ? Number(raw.monthlyRequestsLimit)
          : existing?.monthlyRequestsLimit ?? plan.monthlyRequests,
      periodMonth: raw.periodMonth ?? existing?.periodMonth ?? currentMonth(this.now()),
      totalBilledUsd: roundUsd(Number(raw.totalBilledUsd ?? existing?.totalBilledUsd ?? 0) || 0),
      updatedAt: new Date(this.now()).toISOString(),
    };
    this.tenants.set(tenantId, tenant);
    if (persist) this._saveStateToDisk();
    return tenant;
  }

  /**
   * Find the tenant associated with a caller key (`who.tenantId` or a tenant listing `who.fp` in `tenant.keys`).
   */
  tenantForCaller(who) {
    if (!who) return null;
    if (who.tenantId && this.tenants.has(who.tenantId)) {
      return this.tenants.get(who.tenantId);
    }
    if (who.fp) {
      for (const t of this.tenants.values()) {
        if (t.keys.includes(who.fp)) return t;
      }
    }
    return null;
  }

  /**
   * Pre-flight admission check before running a metered LLM request.
   * Throws 402 Payment Required when a prepaid tenant's balance is <= 0 or plan monthly quota is exhausted.
   */
  admitRequest(who) {
    const tenant = this.tenantForCaller(who);
    if (!tenant) return null;
    const m = currentMonth(this.now());
    if (tenant.periodMonth !== m) {
      tenant.periodMonth = m;
      tenant.monthlyRequestsUsed = 0;
    }
    if (
      Number.isFinite(tenant.monthlyRequestsLimit) &&
      tenant.monthlyRequestsLimit >= 0 &&
      tenant.monthlyRequestsUsed >= tenant.monthlyRequestsLimit
    ) {
      const err = new LlmError(
        `tenant "${tenant.id}" (plan: ${tenant.plan}) has reached its monthly limit of ${tenant.monthlyRequestsLimit} requests`,
        { status: 402, type: 'payment_required_error' },
      );
      err.code = 'plan_quota_exceeded';
      throw err;
    }
    if (tenant.billingMode === 'prepaid') {
      const hasUsd = tenant.balanceUsd > 0;
      const hasTry = tenant.balanceTry > 0;
      if (!hasUsd && !hasTry) {
        const err = new LlmError(
          `tenant "${tenant.id}" has insufficient prepaid balance (balanceUsd=${tenant.balanceUsd}, balanceTry=${tenant.balanceTry})`,
          { status: 402, type: 'payment_required_error' },
        );
        err.code = 'insufficient_balance';
        throw err;
      }
    }
    tenant.monthlyRequestsUsed++;
    return tenant;
  }

  /**
   * Debit a tenant wallet after a request completes and return `{ tenantId, plan, markupPct, billedUsd, billedTry, balanceUsd, balanceTry }`.
   */
   settleUsage(who, entry) {
    const tenant = this.tenantForCaller(who);
    if (!tenant || entry?.status !== 'ok' || entry?.cacheHit) return null;
    const rawUsd = Number(entry?.cost?.usd ?? entry?.cost?.listUsd ?? 0) || 0;
    const multiplier = 1 + (Number(tenant.markupPct) || 0) / 100;
    const billedUsd = roundUsd(rawUsd * multiplier);
    const billedTry = roundMoney(billedUsd * this.fxTryPerUsd);

    if (billedUsd > 0) {
      if (tenant.currency === 'TRY' && tenant.balanceTry > 0) {
        tenant.balanceTry = roundMoney(Math.max(0, tenant.balanceTry - billedTry));
        tenant.balanceUsd = roundUsd(tenant.balanceTry / this.fxTryPerUsd);
      } else {
        tenant.balanceUsd = roundUsd(Math.max(0, tenant.balanceUsd - billedUsd));
        if (tenant.balanceTry > 0) {
          tenant.balanceTry = roundMoney(Math.max(0, tenant.balanceTry - billedTry));
        }
      }
      tenant.totalBilledUsd = roundUsd(tenant.totalBilledUsd + billedUsd);
      tenant.updatedAt = new Date(this.now()).toISOString();
      this._saveStateToDisk();
    }

    return {
      tenantId: tenant.id,
      plan: tenant.plan,
      billingMode: tenant.billingMode,
      lowBalanceThresholdUsd: tenant.lowBalanceThresholdUsd,
      markupPct: tenant.markupPct,
      billedUsd,
      billedTry,
      balanceUsd: tenant.balanceUsd,
      balanceTry: tenant.balanceTry,
    };
  }

  /**
   * Top up a tenant's wallet and optionally upgrade their plan, writing an immutable invoice record.
   */
  topup({
    tenantId,
    amount,
    currency = 'TRY',
    plan = null,
    kind = 'topup',
    provider = null,
    providerPaymentId = null,
    description = null,
  } = {}) {
    const t = this.tenants.get(tenantId);
    if (!t) throw new LlmError(`unknown tenant "${tenantId}"`, { status: 404, type: 'not_found_error' });
    const numAmount = Number(amount);
    if (!Number.isFinite(numAmount) || numAmount < 0) {
      throw new LlmError('amount must be a non-negative number', { status: 400, type: 'invalid_request_error' });
    }
    const curr = String(currency || t.currency || 'TRY').toUpperCase();
    if (curr !== 'TRY' && curr !== 'USD') {
      throw new LlmError('currency must be TRY or USD', { status: 400, type: 'invalid_request_error' });
    }
    if (plan && this.plans[plan]) {
      t.plan = plan;
      t.monthlyRequestsLimit = this.plans[plan].monthlyRequests;
    }

    if (kind === 'topup' && numAmount > 0) {
      if (curr === 'TRY') {
        t.balanceTry = roundMoney(t.balanceTry + numAmount);
        t.balanceUsd = roundUsd(t.balanceUsd + numAmount / this.fxTryPerUsd);
      } else {
        t.balanceUsd = roundUsd(t.balanceUsd + numAmount);
        t.balanceTry = roundMoney(t.balanceTry + numAmount * this.fxTryPerUsd);
      }
    }
    t.updatedAt = new Date(this.now()).toISOString();
    this._saveStateToDisk();

    const vatRate = t.vatExempt ? 0 : this.defaultVatRate;
    const subtotal = roundMoney(numAmount);
    const vatAmount = roundMoney(subtotal * vatRate);
    const total = roundMoney(subtotal + vatAmount);
    const invoice = {
      invoiceId: `inv_${ formatDateCompact(this.now()) }_${randomBytes(4).toString('hex')}`,
      createdAt: new Date(this.now()).toISOString(),
      tenantId: t.id,
      tenantName: t.name,
      taxId: t.taxId,
      taxOffice: t.taxOffice,
      kind,
      plan: t.plan,
      currency: curr,
      subtotal,
      vatRate,
      vatAmount,
      total,
      provider: provider || this.provider,
      providerPaymentId: providerPaymentId || null,
      status: 'paid',
      lineItems: [
        {
          description: description || (kind === 'subscription' ? `Keysmith ${t.plan.toUpperCase()} Plan` : `Keysmith Prepaid Wallet Top-up (${curr})`),
          amount: subtotal,
        },
      ],
    };
    this._appendInvoice(invoice);
    return { tenant: t, invoice };
  }

  /**
   * Create an iyzico (or stripe/manual) checkout session for a subscription or prepaid wallet top-up.
   */
  createCheckout({
    tenantId,
    kind = 'topup',
    planId = null,
    billingCycle = 'monthly',
    amount = null,
    currency = 'TRY',
    callbackUrl = 'https://localhost/v1/keysmith/billing/webhooks/iyzico',
    locale = 'tr',
  } = {}) {
    const t = this.tenants.get(tenantId);
    if (!t) throw new LlmError(`unknown tenant "${tenantId}"`, { status: 404, type: 'not_found_error' });
    const curr = String(currency || t.currency || 'TRY').toUpperCase();
    let subtotal = Number(amount);
    let targetPlan = planId || t.plan;

    if (kind === 'subscription') {
      const p = this.plans[targetPlan];
      if (!p) throw new LlmError(`unknown plan "${targetPlan}"`, { status: 400, type: 'invalid_request_error' });
      subtotal =
        curr === 'TRY'
          ? billingCycle === 'annual'
            ? p.annualTry
            : p.monthlyTry
          : billingCycle === 'annual'
            ? p.annualUsd
            : p.monthlyUsd;
    }
    if (!Number.isFinite(subtotal) || subtotal <= 0) {
      throw new LlmError('checkout amount must be greater than 0', { status: 400, type: 'invalid_request_error' });
    }

    const vatRate = t.vatExempt ? 0 : this.defaultVatRate;
    const vatAmount = roundMoney(subtotal * vatRate);
    const paidPrice = roundMoney(subtotal + vatAmount);
    const conversationId = `ks_chk_${randomBytes(8).toString('hex')}`;

    const iyzicoPayload = {
      locale: locale === 'en' ? 'en' : 'tr',
      conversationId,
      price: String(subtotal.toFixed(2)),
      paidPrice: String(paidPrice.toFixed(2)),
      currency: curr,
      basketId: `bsk_${tenantId}_${Date.now()}`,
      paymentGroup: kind === 'subscription' ? 'SUBSCRIPTION' : 'PRODUCT',
      callbackUrl,
      buyer: {
        id: t.id,
        name: t.name,
        email: t.email || 'billing@example.com',
        identityNumber: t.taxId || '11111111111',
      },
      basketItems: [
        {
          id: kind === 'subscription' ? `plan_${targetPlan}_${billingCycle}` : `topup_${curr}`,
          name: kind === 'subscription' ? `Keysmith ${targetPlan} (${billingCycle})` : `Keysmith API Credit (${curr})`,
          category1: 'Software',
          itemType: 'VIRTUAL',
          price: String(subtotal.toFixed(2)),
        },
      ],
    };

    const apiKey = process.env.IYZICO_API_KEY || '';
    const secretKey = process.env.IYZICO_SECRET_KEY || '';
    let authPreview = null;
    if (apiKey && secretKey) {
      const signed = buildIyzicoAuthHeader({ apiKey, secretKey, body: iyzicoPayload });
      authPreview = { scheme: 'IYZWSv2', randomKey: signed.randomKey };
    }

    const session = {
      conversationId,
      provider: this.provider,
      tenantId: t.id,
      kind,
      planId: targetPlan,
      billingCycle,
      currency: curr,
      subtotal,
      vatRate,
      vatAmount,
      paidPrice,
      status: 'pending',
      createdAt: new Date(this.now()).toISOString(),
      iyzicoRequest: iyzicoPayload,
      ...(authPreview ? { iyzicoAuth: authPreview } : {}),
    };
    this.pendingCheckouts.set(conversationId, session);
    return session;
  }

  /**
   * Process a verified iyzico webhook event (`POST /v1/keysmith/billing/webhooks/iyzico`).
   */
  handleIyzicoWebhook({ headers = {}, rawBody = '', body = {} } = {}) {
    const secretKey = process.env.IYZICO_SECRET_KEY || process.env.KEYSMITH_IYZICO_WEBHOOK_SECRET || '';
    const sigHeader = headers['x-iyz-signature-v3'] || headers['x-iyz-signature'];
    if (!secretKey || !verifyIyzicoWebhook({ secretKey, signatureHeader: sigHeader, rawBody, parsedBody: body })) {
      throw new LlmError('invalid or missing iyzico webhook signature', { status: 401, type: 'authentication_error' });
    }
    const convId = body.paymentConversationId || body.conversationId;
    const paymentId = String(body.paymentId || body.iyziPaymentId || '');
    const status = String(body.status || '').toUpperCase();
    const pending = convId ? this.pendingCheckouts.get(convId) : null;

    if (status !== 'SUCCESS') {
      if (pending) pending.status = 'failed';
      return { ok: true, status: 'ignored', reason: `payment status is ${status}` };
    }

    const tenantId = pending?.tenantId || body.tenantId;
    if (!tenantId || !this.tenants.has(tenantId)) {
      throw new LlmError('webhook references unknown tenant', { status: 404, type: 'not_found_error' });
    }
    const amount = pending ? pending.subtotal : Number(body.price || body.paidPrice || 0);
    const currency = pending ? pending.currency : (body.currency || 'TRY');
    const kind = pending ? pending.kind : (body.kind || 'topup');
    const plan = pending ? pending.planId : (body.planId || null);

    const result = this.topup({
      tenantId,
      amount,
      currency,
      plan,
      kind,
      provider: 'iyzico',
      providerPaymentId: paymentId || convId,
    });
    if (pending) pending.status = 'completed';
    return { ok: true, status: 'processed', ...result };
  }

  summary() {
    const tenants = [...this.tenants.values()];
    return {
      enabled: this.enabled,
      provider: this.provider,
      fxTryPerUsd: this.fxTryPerUsd,
      defaultVatRate: this.defaultVatRate,
      tenantCount: tenants.length,
      invoiceCount: this.invoices.length,
      totalBalanceUsd: roundUsd(tenants.reduce((s, t) => s + (t.balanceUsd || 0), 0)),
      totalBalanceTry: roundMoney(tenants.reduce((s, t) => s + (t.balanceTry || 0), 0)),
      totalBilledUsd: roundUsd(tenants.reduce((s, t) => s + (t.totalBilledUsd || 0), 0)),
      plans: Object.values(this.plans),
      tenants,
    };
  }

  _loadFromDisk() {
    if (this.stateFile) {
      try {
        if (fs.existsSync(this.stateFile)) {
          const parsed = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
          for (const [id, t] of Object.entries(parsed?.tenants || {})) {
            this._putTenant(id, t, { persist: false });
          }
        }
      } catch {}
    }
    if (this.invoicesFile) {
      try {
        if (fs.existsSync(this.invoicesFile)) {
          const lines = fs.readFileSync(this.invoicesFile, 'utf8').split('\n').filter(Boolean);
          this.invoices = lines.map((l) => JSON.parse(l));
        }
      } catch {}
    }
  }

  _saveStateToDisk() {
    if (!this.stateFile) return;
    try {
      const dir = path.dirname(this.stateFile);
      fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
      const tmp = `${this.stateFile}.${process.pid}.tmp`;
      const payload = JSON.stringify({ tenants: Object.fromEntries(this.tenants) }, null, 2);
      fs.writeFileSync(tmp, payload, { mode: FILE_MODE });
      fs.renameSync(tmp, this.stateFile);
    } catch {}
  }

  _appendInvoice(invoice) {
    this.invoices.push(invoice);
    if (!this.invoicesFile) return;
    try {
      const dir = path.dirname(this.invoicesFile);
      fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
      fs.appendFileSync(this.invoicesFile, JSON.stringify(invoice) + '\n', { mode: FILE_MODE });
    } catch {}
  }
}

function roundMoney(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function currentMonth(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function formatDateCompact(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
}
