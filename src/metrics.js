/**
 * Prometheus text exposition format (0.0.4) metrics collector & renderer for Keysmith.
 */

const DEFAULT_BUCKETS = [50, 100, 250, 500, 1000, 2500, 5000, 10000];

function escLabel(val) {
  return String(val ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/"/g, '\\"');
}

export class MetricsCollector {
  constructor({ buckets = DEFAULT_BUCKETS } = {}) {
    this.buckets = [...buckets].sort((a, b) => a - b);
    this.requestsByLabel = new Map(); // key -> { adapter, model, face, status, count }
    this.tokensInput = 0;
    this.tokensOutput = 0;
    this.costUsdTotal = 0;
    this.spendCapBlockedByTarget = new Map(); // target -> count
    this.durationCounts = new Array(this.buckets.length).fill(0);
    this.durationCountTotal = 0;
    this.durationSumMs = 0;
  }

  recordRequest({
    adapter = 'unknown',
    model = 'unknown',
    face = 'chat',
    status = 'ok',
    ms = 0,
    inputTokens = 0,
    outputTokens = 0,
    costUsd = 0,
  } = {}) {
    const a = String(adapter || 'unknown');
    const m = String(model || 'unknown');
    const f = String(face || 'chat');
    const s = String(status || 'ok');
    const key = `${a}\x00${m}\x00${f}\x00${s}`;
    const prev = this.requestsByLabel.get(key) || { adapter: a, model: m, face: f, status: s, count: 0 };
    prev.count += 1;
    this.requestsByLabel.set(key, prev);

    if (Number.isFinite(inputTokens) && inputTokens > 0) this.tokensInput += inputTokens;
    if (Number.isFinite(outputTokens) && outputTokens > 0) this.tokensOutput += outputTokens;
    if (Number.isFinite(costUsd) && costUsd > 0) this.costUsdTotal = Math.round((this.costUsdTotal + costUsd) * 1e8) / 1e8;

    const dur = Math.max(0, Number(ms) || 0);
    this.durationCountTotal += 1;
    this.durationSumMs += dur;
    for (let i = 0; i < this.buckets.length; i++) {
      if (dur <= this.buckets[i]) {
        this.durationCounts[i] += 1;
      }
    }
  }

  recordSpendCapBlocked(target = 'unknown') {
    const t = String(target || 'unknown');
    this.spendCapBlockedByTarget.set(t, (this.spendCapBlockedByTarget.get(t) || 0) + 1);
  }

  render({ cache = null, guardrails = null, gateway = null } = {}) {
    const lines = [];

    // 1. keysmith_requests_total
    lines.push('# HELP keysmith_requests_total Total number of LLM gateway requests processed.');
    lines.push('# TYPE keysmith_requests_total counter');
    if (this.requestsByLabel.size === 0) {
      lines.push('keysmith_requests_total{adapter="none",model="none",face="none",status="ok"} 0');
    } else {
      for (const rec of this.requestsByLabel.values()) {
        lines.push(
          `keysmith_requests_total{adapter="${escLabel(rec.adapter)}",model="${escLabel(rec.model)}",face="${escLabel(rec.face)}",status="${escLabel(rec.status)}"} ${rec.count}`,
        );
      }
    }

    // 2. keysmith_tokens_total
    lines.push('# HELP keysmith_tokens_total Total input and output tokens processed.');
    lines.push('# TYPE keysmith_tokens_total counter');
    lines.push(`keysmith_tokens_total{direction="input"} ${this.tokensInput}`);
    lines.push(`keysmith_tokens_total{direction="output"} ${this.tokensOutput}`);

    // 3. keysmith_cost_usd_total
    lines.push('# HELP keysmith_cost_usd_total Total estimated upstream spend in USD.');
    lines.push('# TYPE keysmith_cost_usd_total counter');
    lines.push(`keysmith_cost_usd_total ${this.costUsdTotal}`);

    // 4. keysmith_cache_hits_total & keysmith_cache_misses_total & keysmith_cache_saved_usd_total
    const cacheStats = cache?.stats?.() || { hits: 0, misses: 0, savedUsd: 0 };
    lines.push('# HELP keysmith_cache_hits_total Total deterministic response cache hits.');
    lines.push('# TYPE keysmith_cache_hits_total counter');
    lines.push(`keysmith_cache_hits_total ${cacheStats.hits || 0}`);
    lines.push('# HELP keysmith_cache_misses_total Total deterministic response cache misses.');
    lines.push('# TYPE keysmith_cache_misses_total counter');
    lines.push(`keysmith_cache_misses_total ${cacheStats.misses || 0}`);
    lines.push('# HELP keysmith_cache_saved_usd_total Total USD saved by response cache hits.');
    lines.push('# TYPE keysmith_cache_saved_usd_total counter');
    lines.push(`keysmith_cache_saved_usd_total ${cacheStats.savedUsd || 0}`);

    // 5. keysmith_guardrail_hits_total
    const grStats = guardrails?.stats?.() || {};
    lines.push('# HELP keysmith_guardrail_hits_total Total KVKK/GDPR guardrail and prompt injection interventions.');
    lines.push('# TYPE keysmith_guardrail_hits_total counter');
    lines.push(`keysmith_guardrail_hits_total{action="masked"} ${grStats.maskedCount ?? grStats.masked ?? 0}`);
    lines.push(`keysmith_guardrail_hits_total{action="blocked"} ${grStats.blockedPiiCount ?? grStats.blocked ?? 0}`);
    lines.push(`keysmith_guardrail_hits_total{action="injection_blocked"} ${grStats.blockedInjectionCount ?? grStats.promptInjections ?? 0}`);

    // 6. keysmith_spend_cap_blocked_total
    lines.push('# HELP keysmith_spend_cap_blocked_total Total requests blocked by spend caps or budget limits.');
    lines.push('# TYPE keysmith_spend_cap_blocked_total counter');
    if (this.spendCapBlockedByTarget.size === 0) {
      lines.push('keysmith_spend_cap_blocked_total{target="none"} 0');
    } else {
      for (const [target, count] of this.spendCapBlockedByTarget.entries()) {
        lines.push(`keysmith_spend_cap_blocked_total{target="${escLabel(target)}"} ${count}`);
      }
    }

    // 7. keysmith_request_duration_ms_bucket
    lines.push('# HELP keysmith_request_duration_ms Request latency histogram in milliseconds.');
    lines.push('# TYPE keysmith_request_duration_ms histogram');
    for (let i = 0; i < this.buckets.length; i++) {
      lines.push(`keysmith_request_duration_ms_bucket{le="${this.buckets[i]}"} ${this.durationCounts[i]}`);
    }
    lines.push(`keysmith_request_duration_ms_bucket{le="+Inf"} ${this.durationCountTotal}`);
    lines.push(`keysmith_request_duration_ms_sum ${this.durationSumMs}`);
    lines.push(`keysmith_request_duration_ms_count ${this.durationCountTotal}`);

    // 8. keysmith_in_flight_requests
    const inFlight = Number(gateway?.inFlight) || 0;
    lines.push('# HELP keysmith_in_flight_requests Number of currently active in-flight LLM requests.');
    lines.push('# TYPE keysmith_in_flight_requests gauge');
    lines.push(`keysmith_in_flight_requests ${inFlight}`);

    return lines.join('\n') + '\n';
  }
}
