import crypto from 'node:crypto';
import { resolveSecret } from './config.js';
import { redactSecrets, registerSecrets } from './redact.js';

export const WEBHOOK_EVENTS = [
  'spend_cap.exceeded',
  'spend_cap.warning',
  'budget.low_balance',
  'adapter.error',
];

/**
 * Compute HMAC-SHA256 signature header value (`sha256=<hex>`) for a webhook payload.
 */
export function computeWebhookSignature(secret, rawBody) {
  const key = String(secret || '');
  const body = typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody ?? {});
  const hex = crypto.createHmac('sha256', key).update(body, 'utf8').digest('hex');
  return `sha256=${hex}`;
}

/**
 * Constant-time verification of `X-Keysmith-Signature-256` header (`sha256=<hex>`).
 */
export function verifyWebhookSignature(secret, rawBody, signatureHeader) {
  if (!secret || typeof signatureHeader !== 'string') return false;
  const expected = computeWebhookSignature(secret, rawBody);
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signatureHeader.trim(), 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export class WebhookDispatcher {
  constructor(webhooksCfg = [], { fetchImpl = globalThis.fetch, now = () => Date.now(), log = () => {} } = {}) {
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.log = (m) => log(redactSecrets(m));
    this.endpoints = [];
    this.deliveries = [];
    this._inFlight = new Set();
    this._dedupe = new Map();

    const list = Array.isArray(webhooksCfg)
      ? webhooksCfg
      : Array.isArray(webhooksCfg?.endpoints)
        ? webhooksCfg.endpoints
        : [];

    for (const raw of list) {
      if (!raw || typeof raw !== 'object' || typeof raw.url !== 'string' || !raw.url.trim()) continue;
      if (raw.enabled === false) continue;
      let resolvedSecret = null;
      if (raw.secret) {
        try {
          resolvedSecret = resolveSecret(raw.secret) || String(raw.secret);
        } catch {
          resolvedSecret = String(raw.secret);
        }
        if (resolvedSecret) registerSecrets([resolvedSecret]);
      }
      const events = Array.isArray(raw.events) && raw.events.length > 0 ? raw.events.map(String) : ['*'];
      const maxRetries = Number.isFinite(Number(raw.retries)) && Number(raw.retries) >= 0 ? Number(raw.retries) : 2;
      const retryDelayMs =
        Number.isFinite(Number(raw.retryDelayMs)) && Number(raw.retryDelayMs) >= 0 ? Number(raw.retryDelayMs) : 50;
      this.endpoints.push({
        url: raw.url.trim(),
        secret: resolvedSecret,
        events,
        maxRetries,
        retryDelayMs,
      });
    }
  }

  hasSubscribers(type) {
    return this.endpoints.some((ep) => ep.events.includes('*') || ep.events.includes(type));
  }

  /**
   * Emit an event asynchronously to all matching webhook endpoints with retry support.
   */
  emit(type, data = {}, { dedupeKey = null, dedupeWindowMs = 60_000 } = {}) {
    if (!type || !this.hasSubscribers(type)) return null;
    const nowMs = this.now();
    if (dedupeKey) {
      const k = `${type}:${dedupeKey}`;
      const prevAt = this._dedupe.get(k);
      if (prevAt != null && nowMs - prevAt < dedupeWindowMs) {
        return null;
      }
      this._dedupe.set(k, nowMs);
    }

    const event = {
      eventId: 'evt_' + crypto.randomBytes(10).toString('hex'),
      type,
      createdAt: new Date(nowMs).toISOString(),
      data,
    };
    const rawBody = JSON.stringify(event);

    for (const ep of this.endpoints) {
      if (!ep.events.includes('*') && !ep.events.includes(type)) continue;
      const p = this._deliverWithRetry(ep, event, rawBody).finally(() => {
        this._inFlight.delete(p);
      });
      this._inFlight.add(p);
    }
    return event;
  }

  async _deliverWithRetry(ep, event, rawBody) {
    const sig = ep.secret ? computeWebhookSignature(ep.secret, rawBody) : null;
    const headers = {
      'content-type': 'application/json; charset=utf-8',
      'user-agent': 'keysmith-webhook/1.0',
      'x-keysmith-event': event.type,
      'x-keysmith-event-id': event.eventId,
      ...(sig ? { 'x-keysmith-signature-256': sig } : {}),
    };

    let attempt = 0;
    let lastStatus = null;
    let lastError = null;
    const maxAttempts = 1 + (ep.maxRetries ?? 2);

    while (attempt < maxAttempts) {
      attempt++;
      try {
        const res = await this.fetchImpl(ep.url, {
          method: 'POST',
          headers,
          body: rawBody,
        });
        lastStatus = res?.status ?? 200;
        if (lastStatus >= 200 && lastStatus < 300) {
          this._recordDelivery({
            eventId: event.eventId,
            type: event.type,
            url: ep.url,
            status: lastStatus,
            attempts: attempt,
            ok: true,
            ts: new Date(this.now()).toISOString(),
          });
          return true;
        }
        lastError = `HTTP ${lastStatus}`;
      } catch (err) {
        lastError = redactSecrets(err?.message || String(err));
      }

      if (attempt < maxAttempts && ep.retryDelayMs > 0) {
        await new Promise((r) => setTimeout(r, ep.retryDelayMs));
      }
    }

    this._recordDelivery({
      eventId: event.eventId,
      type: event.type,
      url: ep.url,
      status: lastStatus,
      attempts: attempt,
      ok: false,
      error: lastError,
      ts: new Date(this.now()).toISOString(),
    });
    this.log(`webhook delivery failed for ${event.type} -> ${ep.url} after ${attempt} attempt(s): ${lastError}`);
    return false;
  }

  _recordDelivery(entry) {
    this.deliveries.push(entry);
    if (this.deliveries.length > 100) {
      this.deliveries.splice(0, this.deliveries.length - 100);
    }
  }

  async flush() {
    while (this._inFlight.size > 0) {
      await Promise.allSettled([...this._inFlight]);
    }
  }
}
