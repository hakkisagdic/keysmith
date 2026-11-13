import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Gateway } from '../src/gateway.js';
import { LlmError } from '../src/util.js';

function fakeAdapter(id, { models = ['m1', 'm2'], delayMs = 0, fail = false, costBasis = 'metered' } = {}) {
  return {
    id,
    kind: 'http',
    wire: 'openai',
    costBasis,
    declaredModels: models,
    async models() {
      return models.map((m) => ({ id: m }));
    },
    async *complete({ model }) {
      if (fail) {
        throw new LlmError(`${id} upstream failure`, { status: 502, provider: id });
      }
      if (delayMs > 0) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
      yield { type: 'delta', text: `reply-from-${id}/${model}` };
      yield { type: 'usage', usage: { input: 10, output: 20 } };
      yield { type: 'done' };
    },
  };
}

describe('P1-1: Alias Routing Strategies (weighted, least-latency, least-cost)', () => {
  it('supports object-form aliases and weighted load balancing with failover', async () => {
    let callsA = 0;
    let callsB = 0;
    let failA = false;
    const adapterA = {
      ...fakeAdapter('provA', { models: ['fast'] }),
      async *complete({ model }) {
        callsA++;
        if (failA) throw new LlmError('provA down', { status: 503, provider: 'provA' });
        yield { type: 'delta', text: `A:${model}` };
        yield { type: 'done' };
      },
    };
    const adapterB = {
      ...fakeAdapter('provB', { models: ['fast'] }),
      async *complete({ model }) {
        callsB++;
        yield { type: 'delta', text: `B:${model}` };
        yield { type: 'done' };
      },
    };

    // Deterministic RNG sequence cycling 0.05 .. 0.95 (10 steps)
    let step = 0;
    const rng = () => {
      const val = ((step++ % 10) + 0.5) / 10;
      return val;
    };

    const cfg = {
      adapters: {},
      aliases: {
        'balanced-fast': {
          strategy: 'weighted',
          targets: [
            { target: 'provA/fast', weight: 70 },
            { target: 'provB/fast', weight: 30 },
          ],
        },
      },
    };

    const gw = new Gateway(cfg, {
      rng,
      adapters: { provA: adapterA, provB: adapterB },
    });

    // Across 10 resolutions with uniform deciles (0.05..0.95), 7 should pick provA first and 3 provB first
    let firstA = 0;
    let firstB = 0;
    for (let i = 0; i < 10; i++) {
      const chain = gw.resolve('balanced-fast');
      assert.equal(chain.strategy, 'weighted');
      assert.equal(chain.length, 2);
      if (chain[0].target === 'provA/fast') firstA++;
      else if (chain[0].target === 'provB/fast') firstB++;
    }
    assert.equal(firstA, 7);
    assert.equal(firstB, 3);

    // When RNG picks provA first (step=0 -> 0.05) and provA fails, it fails over to provB
    step = 0;
    failA = true;
    const res = await gw.collect({
      model: 'balanced-fast',
      messages: [{ role: 'user', content: 'hello' }],
    });
    assert.equal(res.text, 'B:fast');
    assert.equal(callsA, 1);
    assert.equal(callsB, 1);
  });

  it('orders legs by EWMA latency in least-latency strategy and explores unmeasured legs first', async () => {
    let clock = 1000;
    const now = () => clock;

    const adapterSlow = {
      ...fakeAdapter('slow', { models: ['m1'] }),
      async *complete({ model }) {
        clock += 600;
        yield { type: 'delta', text: `slow:${model}` };
        yield { type: 'done' };
      },
    };
    const adapterFast = {
      ...fakeAdapter('fast', { models: ['m1'] }),
      async *complete({ model }) {
        clock += 50;
        yield { type: 'delta', text: `fast:${model}` };
        yield { type: 'done' };
      },
    };

    const cfg = {
      adapters: {},
      aliases: {
        'low-lat': {
          strategy: 'least-latency',
          targets: ['slow/m1', 'fast/m1'],
        },
      },
    };

    const gw = new Gateway(cfg, {
      now,
      adapters: { slow: adapterSlow, fast: adapterFast },
    });

    // 1st request: neither leg measured -> declared order ('slow/m1' first)
    const r1 = await gw.collect({ model: 'low-lat', messages: [{ role: 'user', content: '1' }] });
    assert.equal(r1.text, 'slow:m1');
    assert.equal(gw.getLatency('slow/m1'), 600);
    assert.equal(gw.getLatency('fast/m1'), null);

    // 2nd request: 'slow/m1' is measured (600ms) while 'fast/m1' is unmeasured -> explores 'fast/m1' first!
    const r2 = await gw.collect({ model: 'low-lat', messages: [{ role: 'user', content: '2' }] });
    assert.equal(r2.text, 'fast:m1');
    assert.equal(gw.getLatency('fast/m1'), 50);

    // 3rd request: both measured (fast/m1 = 50ms < slow/m1 = 600ms) -> picks 'fast/m1' first!
    const chain3 = gw.resolve('low-lat');
    assert.equal(chain3[0].target, 'fast/m1');
    assert.equal(chain3[1].target, 'slow/m1');
  });

  it('orders legs by unit cost in least-cost strategy using pricing table', async () => {
    const adapterExpensive = fakeAdapter('exp', { models: ['claude-opus-5-5'] });
    const adapterMedium = fakeAdapter('med', { models: ['claude-sonnet-5-5'] });
    const adapterCheap = fakeAdapter('chp', { models: ['claude-haiku-5-5'] });

    const cfg = {
      adapters: {},
      pricing: {
        'exp/claude-opus-5-5': { input: 5, output: 25 },
        'med/claude-sonnet-5-5': { input: 2, output: 10 },
        'chp/claude-haiku-5-5': { input: 0.1, output: 0.5 },
      },
      aliases: {
        'budget-route': {
          strategy: 'least-cost',
          targets: ['exp/claude-opus-5-5', 'med/claude-sonnet-5-5', 'chp/claude-haiku-5-5'],
        },
      },
    };

    const gw = new Gateway(cfg, {
      adapters: { exp: adapterExpensive, med: adapterMedium, chp: adapterCheap },
    });

    const chain = gw.resolve('budget-route');
    assert.equal(chain.strategy, 'least-cost');
    assert.deepEqual(
      chain.map((c) => c.target),
      ['chp/claude-haiku-5-5', 'med/claude-sonnet-5-5', 'exp/claude-opus-5-5'],
    );

    const models = await gw.listModels();
    const aliasEntry = models.models.find((m) => m.id === 'budget-route');
    assert.ok(aliasEntry);
    assert.equal(aliasEntry.keysmith.strategy, 'least-cost');
    assert.deepEqual(aliasEntry.keysmith.routes, [
      'exp/claude-opus-5-5',
      'med/claude-sonnet-5-5',
      'chp/claude-haiku-5-5',
    ]);
  });
});
