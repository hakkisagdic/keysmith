/**
 * contextWindow on the status page comes from an upstream /models answer. Only a finite
 * positive number is printed as an integer; everything else is escaped.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statusPage } from '../src/status-page.js';

function page(models) {
  return statusPage({
    cfg: { adapters: {} },
    models,
    startedAt: Date.now(),
    usage: null,
    spend: [],
  });
}

/** The context cell of the single model row these tests render. */
function contextOf(html) {
  const row = html.match(/<tr><td>m<\/td><td class="muted"><\/td><td class="muted"><\/td><td class="n">([^<]*)<\/td><\/tr>/);
  assert.ok(row, 'models row with a context cell');
  return row[1];
}

test('K1: markup in contextWindow is escaped and not live HTML', () => {
  const markup = '<' + 'img src=x onerror=alert(1)>';
  const html = page([{ id: 'm', keysmith: { contextWindow: markup } }]);
  const cell = contextOf(html);
  assert.equal(html.includes('<img'), false);
  assert.ok(html.includes('&lt;img'));
  // esc() first, then 24 characters: `&lt;img src=x onerror=al`
  assert.equal(cell, '&lt;img src=x onerror=al');
  assert.equal(cell.length, 24);
});

test('K2: a finite positive contextWindow renders as an integer', () => {
  const html = page([{ id: 'm', keysmith: { contextWindow: 4096 } }]);
  assert.equal(contextOf(html), '4096');
  assert.ok(html.includes('<td class="n">4096</td>'));
  const fractional = page([{ id: 'm', keysmith: { contextWindow: 4096.8 } }]);
  assert.equal(contextOf(fractional), '4096');
  assert.equal(fractional.includes('4096.8'), false);
});

test('K3: undefined and null contextWindow render an empty cell', () => {
  for (const contextWindow of [undefined, null]) {
    const html = page([{ id: 'm', keysmith: { contextWindow } }]);
    assert.equal(contextOf(html), '');
    assert.match(html, /<td class="n"><\/td>/);
  }
});

test('K4: an object contextWindow contributes no raw markup', () => {
  const html = page([{ id: 'm', keysmith: { contextWindow: { a: 1 } } }]);
  const cell = contextOf(html);
  assert.equal(cell.includes('<'), false);
  assert.equal(cell, '[object Object]');
});
