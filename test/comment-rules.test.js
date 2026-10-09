'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyComment, planComment } = require('../src/comment-rules');
const { normalizeInstagram } = require('../src/normalize-instagram');
const { loadFixture } = require('./helpers/fixtures');

const [priceComment, spamComment] = normalizeInstagram(
  loadFixture('instagram-comments.json'),
).comments;
const options = {
  priceListUrl: 'https://example.com/paket',
  hourlyCap: 20,
  now: new Date('2026-10-09T10:47:12.000Z'),
};

test('price questions are recognised in Indonesian and English', () => {
  for (const text of [
    'Kak harga paket ini brp ya?',
    'hargaaa berapa kak',
    'Info pricelist dong',
    'How much is this setup?',
    'brp kak',
  ]) {
    assert.equal(classifyComment(text).category, 'price_inquiry', text);
  }
});

test('spam wins over a price keyword, insults are detected, others are left alone', () => {
  assert.equal(classifyComment('Harga murah! slot gacor cek bio').category, 'spam');
  assert.equal(classifyComment('Promo di www.contoh-promo.xyz').category, 'spam');
  assert.equal(classifyComment('Dekorasinya jelek, tolollll').category, 'insult');
  assert.equal(classifyComment('Cantik banget dekorasinya!').category, 'other');
  assert.equal(classifyComment('Berapa lama pengerjaannya?').category, 'other');
});

test('a price inquiry gets a public reply and a private reply by comment id', () => {
  const plan = planComment(priceComment, options);

  assert.equal(plan.category, 'price_inquiry');
  assert.deepEqual(plan.public_reply, {
    comment_id: '18100000000000001',
    body: {
      message: 'Halo @dina.events, info harga sudah kami kirim lewat DM ya. Silakan cek inbox.',
    },
  });
  assert.equal(plan.private_reply.account_id, '17841400000000001');
  assert.deepEqual(plan.private_reply.body.recipient, { comment_id: '18100000000000001' });
  assert.match(plan.private_reply.body.message.text, /https:\/\/example\.com\/paket/);
});

test('the hourly counter is keyed by account and UTC hour', () => {
  assert.deepEqual(planComment(priceComment, options).rate_limit, {
    scope_key: 'instagram:17841400000000001',
    window_start: '2026-10-09 10:00:00',
    cap: 20,
  });
});

test('spam gets no replies but is still logged through the claim row', () => {
  const plan = planComment(spamComment, options);
  assert.equal(plan.category, 'spam');
  assert.deepEqual(plan.reasons, ['rule_spam']);
  assert.equal(plan.public_reply, null);
  assert.equal(plan.private_reply, null);
  assert.deepEqual(plan.claim, {
    channel: 'instagram_comment',
    external_message_id: '18100000000000002',
    customer_id: '5500000000000002',
    customer_name: 'promo.gacor.88',
    text_preview: 'Slot gacor maxwin hari ini, cek bio!',
    received_at: '2026-10-09 10:05:00.000',
  });
});

test('an invalid cap is a configuration error', () => {
  assert.throws(() => planComment(priceComment, { ...options, hourlyCap: 0 }), /hourlyCap/);
});
