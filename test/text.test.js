'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  truncate,
  truncateUtf8,
  unixToIso,
  toMysqlDateTime,
  escapeTelegramHtml,
} = require('../src/text');

test('truncate keeps short text and marks cut text with an ellipsis', () => {
  assert.equal(truncate('halo', 10), 'halo');
  assert.equal(truncate('halo dunia', 5), 'halo…');
  assert.equal(truncate('halo dunia', 5).length, 5);
});

test('truncate never splits a surrogate pair', () => {
  const text = 'ab🌸cd';
  const result = truncate(text, 4);
  assert.equal(result, 'ab…');
  assert.ok(result.length <= 4);
});

test('truncateUtf8 limits UTF-8 bytes, not characters', () => {
  const text = 'é'.repeat(600);
  const result = truncateUtf8(text, 1000);
  assert.ok(new TextEncoder().encode(result).length <= 1000);
  assert.ok(result.endsWith('…'));
  assert.equal(truncateUtf8('short', 1000), 'short');
});

test('unixToIso accepts seconds, milliseconds and numeric strings', () => {
  assert.equal(unixToIso('1791540000'), '2026-10-09T10:00:00.000Z');
  assert.equal(unixToIso(1791540000), '2026-10-09T10:00:00.000Z');
  assert.equal(unixToIso(1791540000123), '2026-10-09T10:00:00.123Z');
  assert.equal(unixToIso('soon'), null);
  assert.equal(unixToIso(undefined), null);
});

test('toMysqlDateTime renders UTC with milliseconds and rejects invalid dates', () => {
  assert.equal(toMysqlDateTime('2026-10-09T10:00:00.120+07:00'), '2026-10-09 03:00:00.120');
  assert.throws(() => toMysqlDateTime('not a date'), /Invalid date/);
});

test('escapeTelegramHtml escapes exactly what Telegram HTML parse mode needs', () => {
  assert.equal(
    escapeTelegramHtml('a < b && c > d, intent_refund_request *bold*'),
    'a &lt; b &amp;&amp; c &gt; d, intent_refund_request *bold*',
  );
  assert.equal(escapeTelegramHtml('&lt;'), '&amp;lt;');
});
