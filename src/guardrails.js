import { LlmError } from './util.js';

const DEFAULT_PII_TYPES = ['tckn', 'iban', 'card', 'email', 'phone'];

const PROMPT_INJECTION_PATTERNS = [
  { id: 'ignore_previous', re: /\b(?:ignore|disregard|forget)\s+(?:all\s+)?(?:previous|prior|above|system)\s+(?:instructions|prompts|rules|directions)\b/i },
  { id: ' ignore_tr', re: /\b(?:önceki|yukarıdaki|tüm)\s+(?:sistem\s+)?(?:talimatları|kuralları|komutları)\s+(?:unut|yoksay|görmezden\s+gel)\b/i },
  { id: 'system_override', re: /(?:<\|im_start\|>\s*system|\[SYSTEM\s*OVERRIDE\]|###\s*SYSTEM\s*PROMPT\s*OVERRIDE)/i },
  { id: 'reveal_system_prompt', re: /\b(?:reveal|print|output|repeat)\s+(?:your|the)\s+(?:exact\s+|full\s+)?(?:system\s+prompt|hidden\s+instructions|developer\s+message)\b/i },
  { id: 'dan_jailbreak', re: /\b(?:you\s+are\s+now\s+DAN|do\s+anything\s+now\s+mode|bypass\s+all\s+safety\s+filters)\b/i },
];

/**
 * Validate a 11-digit Turkish National ID (TCKN) using the official checksum algorithm.
 */
export function isValidTckn(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length !== 11 || digits[0] === '0') return false;
  // Reject trivial all-same-digit sequences if any ever pass modulo.
  if (/^(\d)\1{8}/.test(digits)) return false;
  const d = digits.split('').map(Number);
  const oddSum = d[0] + d[2] + d[4] + d[6] + d[8];
  const evenSum = d[1] + d[3] + d[5] + d[7];
  const d10 = (((oddSum * 7 - evenSum) % 10) + 10) % 10;
  if (d[9] !== d10) return false;
  const sum10 = oddSum + evenSum + d[9];
  return d[10] === sum10 % 10;
}

/**
 * Validate a 13–19 digit payment card number using the Luhn checksum algorithm.
 */
export function isValidLuhn(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  if (/^(\d)\1+$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (double) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * Validate a Turkish or international IBAN (mod-97 check).
 */
export function isValidIban(raw) {
  const cleaned = String(raw || '').replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(cleaned)) return false;
  if (cleaned.startsWith('TR') && cleaned.length !== 26) return false;
  const rearranged = cleaned.slice(4) + cleaned.slice(0, 4);
  let remainder = 0;
  for (let i = 0; i < rearranged.length; i++) {
    const ch = rearranged.charCodeAt(i);
    const val = ch >= 65 && ch <= 90 ? String(ch - 55) : rearranged[i];
    for (let j = 0; j < val.length; j++) {
      remainder = (remainder * 10 + (val.charCodeAt(j) - 48)) % 97;
    }
  }
  return remainder === 1;
}

/**
 * KVKK / GDPR PII & Prompt-Injection Guardrail Engine.
 */
export class GuardrailEngine {
  constructor(cfg = {}) {
    this.configure(cfg);
    this.statsData = {
      scannedRequests: 0,
      maskedCount: 0,
      blockedPiiCount: 0,
      blockedInjectionCount: 0,
      byType: { tckn: 0, iban: 0, card: 0, email: 0, phone: 0, custom: 0, prompt_injection: 0 },
    };
  }

  configure(cfg = {}) {
    const raw = cfg?.guardrails;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      this.enabled = raw === true;
      this.mode = 'mask';
      this.piiTypes = new Set(DEFAULT_PII_TYPES);
      this.blockPromptInjection = this.enabled;
      this.scanOutput = false;
      this.allowHeaderOverride = false;
      this.customPatterns = [];
      return;
    }
    this.enabled = raw.enabled === true;
    this.mode = ['mask', 'block', 'audit'].includes(raw.mode) ? raw.mode : 'mask';
    this.piiTypes = new Set(Array.isArray(raw.piiTypes) && raw.piiTypes.length ? raw.piiTypes : DEFAULT_PII_TYPES);
    this.blockPromptInjection = raw.blockPromptInjection !== false;
    this.scanOutput = raw.scanOutput === true;
    this.allowHeaderOverride = raw.allowHeaderOverride === true;
    this.customPatterns = Array.isArray(raw.customPatterns)
      ? raw.customPatterns
          .filter((p) => p && typeof p.pattern === 'string' && p.pattern)
          .map((p) => ({
            name: String(p.name || 'CUSTOM').toUpperCase(),
            re: new RegExp(p.pattern, p.flags || 'g'),
          }))
      : [];
  }

  effectivePolicy(req) {
    const hdr = String(req?.headers?.['x-keysmith-guardrails'] || '').trim().toLowerCase();
    if (this.allowHeaderOverride && hdr) {
      if (hdr === 'off' || hdr === 'false') return { active: false, mode: 'mask' };
      if (hdr === 'mask' || hdr === 'block' || hdr === 'audit') return { active: true, mode: hdr };
    }
    if (!this.enabled && (hdr === 'mask' || hdr === 'block' || hdr === 'audit')) {
      return { active: true, mode: hdr };
    }
    return { active: this.enabled, mode: this.mode };
  }

  /**
   * Inspect and optionally mask/block an incoming request body (`messages`, `system`, `input`, `instructions`).
   * Mutates a cloned copy or in-place strings on `body` when `mode === "mask"`.
   * Throws 400 `LlmError` when `mode === "block"` or when prompt injection is detected.
   */
  inspectRequest(req, body) {
    const pol = this.effectivePolicy(req);
    if (!pol.active || !body || typeof body !== 'object') {
      return { active: false, hits: 0, types: [] };
    }
    this.statsData.scannedRequests++;
    const hitsByType = {};
    let injectionMatch = null;

    const processString = (text) => {
      if (typeof text !== 'string' || !text) return text;
      if (this.blockPromptInjection && !injectionMatch) {
        for (const p of PROMPT_INJECTION_PATTERNS) {
          if (p.re.test(text)) {
            injectionMatch = p.id;
            break;
          }
        }
      }
      return this._scanAndMaskString(text, pol.mode, hitsByType);
    };

    if (typeof body.system === 'string') {
      body.system = processString(body.system);
    } else if (Array.isArray(body.system)) {
      for (const part of body.system) {
        if (part && typeof part === 'object' && typeof part.text === 'string') {
          part.text = processString(part.text);
        }
      }
    }

    if (typeof body.instructions === 'string') {
      body.instructions = processString(body.instructions);
    }

    if (typeof body.input === 'string') {
      body.input = processString(body.input);
    } else if (Array.isArray(body.input)) {
      this._walkItems(body.input, processString);
    }

    if (Array.isArray(body.messages)) {
      this._walkItems(body.messages, processString);
    }

    if (injectionMatch) {
      this.statsData.blockedInjectionCount++;
      this.statsData.byType.prompt_injection++;
      const err = new LlmError(
        `guardrail blocked request: prompt injection pattern detected (${injectionMatch})`,
        { status: 400, type: 'invalid_request_error' },
      );
      err.code = 'prompt_injection_detected';
      throw err;
    }

    const types = Object.keys(hitsByType);
    const totalHits = Object.values(hitsByType).reduce((a, b) => a + b, 0);
    for (const [t, c] of Object.entries(hitsByType)) {
      this.statsData.byType[t] = (this.statsData.byType[t] || 0) + c;
    }

    if (totalHits > 0) {
      if (pol.mode === 'block') {
        this.statsData.blockedPiiCount++;
        const err = new LlmError(
          `guardrail blocked request: sensitive PII detected (${types.join(', ')})`,
          { status: 400, type: 'invalid_request_error' },
        );
        err.code = 'guardrail_blocked';
        throw err;
      }
      if (pol.mode === 'mask') {
        this.statsData.maskedCount += totalHits;
      }
    }

    return { active: true, mode: pol.mode, hits: totalHits, types, hitsByType };
  }

  /**
   * Scan and mask output text when `scanOutput: true`.
   */
  sanitizeOutput(text) {
    if (!this.enabled || !this.scanOutput || typeof text !== 'string' || !text) return text;
    const hitsByType = {};
    const out = this._scanAndMaskString(text, 'mask', hitsByType);
    const totalHits = Object.values(hitsByType).reduce((a, b) => a + b, 0);
    if (totalHits > 0) {
      this.statsData.maskedCount += totalHits;
      for (const [t, c] of Object.entries(hitsByType)) {
        this.statsData.byType[t] = (this.statsData.byType[t] || 0) + c;
      }
    }
    return out;
  }

  stats() {
    return {
      enabled: this.enabled,
      mode: this.mode,
      piiTypes: [...this.piiTypes],
      blockPromptInjection: this.blockPromptInjection,
      scanOutput: this.scanOutput,
      ...this.statsData,
      byType: { ...this.statsData.byType },
    };
  }

  _walkItems(items, processString) {
    for (let i = 0; i < items.length; i++) {
      const m = items[i];
      if (typeof m === 'string') {
        items[i] = processString(m);
        continue;
      }
      if (!m || typeof m !== 'object') continue;
      if (typeof m.content === 'string') {
        m.content = processString(m.content);
      } else if (Array.isArray(m.content)) {
        for (const part of m.content) {
          if (part && typeof part === 'object' && typeof part.text === 'string') {
            part.text = processString(part.text);
          }
        }
      }
      if (typeof m.text === 'string') {
        m.text = processString(m.text);
      }
    }
  }

  _scanAndMaskString(text, mode, hitsByType) {
    let out = text;

    // 1. IBAN (TR + 24 digits, with optional spaces, or international IBAN)
    if (this.piiTypes.has('iban')) {
      out = out.replace(/\bTR\d{2}(?:\s?\d{4}){5}\s?\d{2}\b/gi, (m) => {
        if (!isValidIban(m)) return m;
        hitsByType.iban = (hitsByType.iban || 0) + 1;
        return mode === 'mask' ? '[REDACTED_IBAN]' : m;
      });
    }

    // 2. Payment Cards (13-19 digits with spaces or hyphens, Luhn validated)
    if (this.piiTypes.has('card')) {
      out = out.replace(/\b(?:\d[ -]*?){13,19}\b/g, (m) => {
        if (!isValidLuhn(m)) return m;
        hitsByType.card = (hitsByType.card || 0) + 1;
        return mode === 'mask' ? '[REDACTED_CARD]' : m;
      });
    }

    // 3. Turkish National ID — TCKN (11 digits, algorithm validated)
    if (this.piiTypes.has('tckn')) {
      out = out.replace(/\b[1-9]\d{10}\b/g, (m) => {
        if (!isValidTckn(m)) return m;
        hitsByType.tckn = (hitsByType.tckn || 0) + 1;
        return mode === 'mask' ? '[REDACTED_TCKN]' : m;
      });
    }

    // 4. Email addresses
    if (this.piiTypes.has('email')) {
      out = out.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, (m) => {
        hitsByType.email = (hitsByType.email || 0) + 1;
        return mode === 'mask' ? '[REDACTED_EMAIL]' : m;
      });
    }

    // 5. Phone numbers (Turkish mobile/landline +90 / 05xx and international E.164)
    if (this.piiTypes.has('phone')) {
      out = out.replace(/(?:\+90|0)\s*\(?5\d{2}\)?[\s.-]*\d{3}[\s.-]*\d{2}[\s.-]*\d{2}\b/g, (m) => {
        hitsByType.phone = (hitsByType.phone || 0) + 1;
        return mode === 'mask' ? '[REDACTED_PHONE]' : m;
      });
    }

    // 6. Custom patterns
    for (const cp of this.customPatterns) {
      out = out.replace(cp.re, (m) => {
        hitsByType.custom = (hitsByType.custom || 0) + 1;
        return mode === 'mask' ? `[REDACTED_${cp.name}]` : m;
      });
    }

    return out;
  }
}
