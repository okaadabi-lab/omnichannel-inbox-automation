'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeWhatsApp } = require('../src/normalize-whatsapp');
const { normalizeInstagram } = require('../src/normalize-instagram');
const { normalizeTelegram } = require('../src/normalize-telegram');
const { normalizeMetaPayload } = require('../src/normalize-meta');
const { assertCanonicalMessage } = require('../src/canonical');
const { loadFixture } = require('./helpers/fixtures');

const reasons = (result) => result.ignored.map((entry) => entry.reason);

test('WhatsApp text message becomes one canonical message', () => {
  const result = normalizeWhatsApp(loadFixture('whatsapp-text.json'));

  assert.deepEqual(result.messages, [
    {
      channel: 'whatsapp',
      external_message_id: 'wamid.HBgNNjI4MTIwMDAwMDAwMRUCABIYFjNFQjBDMUQyRTNGNDA1MTYyNzM4NDkA',
      customer_id: '6281200000001',
      customer_name: 'Rina Wulandari',
      text: 'kak brp harga paket anggrek?',
      received_at: '2026-10-09T10:00:00.000Z',
      reply_target: { phone_number_id: '200000000000001', to: '6281200000001' },
    },
  ]);
  assert.deepEqual(result.ignored, []);
  result.messages.forEach(assertCanonicalMessage);
});

test('WhatsApp delivery and read statuses are not messages', () => {
  const result = normalizeWhatsApp(loadFixture('whatsapp-status.json'));
  assert.deepEqual(result.messages, []);
  assert.deepEqual(reasons(result), ['delivery_status', 'delivery_status']);
});

test('WhatsApp keeps captions and button replies, drops reactions and media without text', () => {
  const result = normalizeWhatsApp(loadFixture('whatsapp-mixed.json'));

  assert.deepEqual(
    result.messages.map((m) => [m.external_message_id, m.text, m.customer_name]),
    [
      ['wamid.IMAGE0000000000000000000000000002', 'Dekorasi seperti ini bisa?', 'Agus Setiawan'],
      ['wamid.INTERACTIVE000000000000000000000001', 'Jadwalkan survei', 'Agus Setiawan'],
    ],
  );
  assert.deepEqual(reasons(result), ['reaction', 'no_text:image', 'unsupported_message']);
});

test('WhatsApp payload with missing metadata is ignored instead of crashing', () => {
  const payload = loadFixture('whatsapp-text.json');
  delete payload.entry[0].changes[0].value.metadata;
  const result = normalizeWhatsApp(payload);
  assert.deepEqual(result.messages, []);
  assert.deepEqual(reasons(result), ['incomplete_message']);
});

test('WhatsApp text longer than the AI service limit is truncated', () => {
  const payload = loadFixture('whatsapp-text.json');
  payload.entry[0].changes[0].value.messages[0].text.body = 'a'.repeat(5000);
  const [message] = normalizeWhatsApp(payload).messages;
  assert.equal(message.text.length, 4000);
});

test('Instagram DM keeps the full message id even when it is longer than 128 chars', () => {
  const result = normalizeInstagram(loadFixture('instagram-dm.json'));
  assert.equal(result.messages.length, 1);
  const [message] = result.messages;
  assert.equal(message.channel, 'instagram');
  assert.ok(message.external_message_id.length > 128);
  assert.equal(message.customer_id, '1100000000000001');
  assert.equal(message.customer_name, null);
  assert.equal(message.received_at, '2026-10-09T10:01:45.000Z');
  assert.deepEqual(message.reply_target, {
    account_id: '17841400000000001',
    recipient_id: '1100000000000001',
  });
  assertCanonicalMessage(message);
});

test('Instagram echoes, reactions, reads, edits and attachments are dropped', () => {
  const result = normalizeInstagram(loadFixture('instagram-noise.json'));
  assert.deepEqual(result.messages, []);
  assert.deepEqual(reasons(result), [
    'echo',
    'reaction',
    'read_receipt',
    'edit',
    'no_text:attachment',
  ]);
});

test('Instagram comments are extracted and our own replies are skipped', () => {
  const result = normalizeInstagram(loadFixture('instagram-comments.json'));

  assert.deepEqual(
    result.comments.map((c) => [c.comment_id, c.username, c.text]),
    [
      ['18100000000000001', 'dina.events', 'Kak harga paket ini brp ya?'],
      ['18100000000000002', 'promo.gacor.88', 'Slot gacor maxwin hari ini, cek bio!'],
    ],
  );
  assert.equal(result.comments[0].account_id, '17841400000000001');
  assert.equal(result.comments[0].received_at, '2026-10-09T10:05:00.000Z');
  assert.deepEqual(reasons(result), ['own_comment', 'unsupported_field:mentions']);
});

test('Telegram private message becomes a canonical message with a chat-scoped id', () => {
  const result = normalizeTelegram(loadFixture('telegram-message.json'));
  assert.deepEqual(result.messages, [
    {
      channel: 'telegram',
      external_message_id: '700000001:42',
      customer_id: '700000001',
      customer_name: 'Bayu Pratama',
      text: 'Selamat siang, tanggal 14 Desember masih tersedia?',
      received_at: '2026-10-09T10:06:40.000Z',
      reply_target: { chat_id: '700000001' },
    },
  ]);
});

test('Telegram edits, group chats and bot messages are dropped', () => {
  assert.deepEqual(reasons(normalizeTelegram(loadFixture('telegram-edited.json'))), ['edit']);
  assert.deepEqual(reasons(normalizeTelegram(loadFixture('telegram-group.json'))), [
    'non_private_chat',
  ]);

  const fromBot = loadFixture('telegram-message.json');
  fromBot.message.from.is_bot = true;
  assert.deepEqual(reasons(normalizeTelegram(fromBot)), ['from_bot']);

  const sticker = loadFixture('telegram-message.json');
  delete sticker.message.text;
  sticker.message.sticker = { file_id: 'fictional' };
  assert.deepEqual(reasons(normalizeTelegram(sticker)), ['no_text']);
});

test('Telegram photo caption is used as the message text', () => {
  const update = loadFixture('telegram-message.json');
  delete update.message.text;
  update.message.caption = 'Contoh dekorasi yang saya mau';
  assert.equal(normalizeTelegram(update).messages[0].text, 'Contoh dekorasi yang saya mau');
});

test('normalizeMetaPayload routes by object and rejects unknown products', () => {
  assert.equal(normalizeMetaPayload(loadFixture('whatsapp-text.json')).messages.length, 1);
  assert.equal(normalizeMetaPayload(loadFixture('instagram-comments.json')).comments.length, 2);
  assert.deepEqual(normalizeMetaPayload({ object: 'page', entry: [] }), {
    messages: [],
    comments: [],
    ignored: [{ reason: 'unsupported_object:page', ref: null }],
  });
  assert.deepEqual(normalizeMetaPayload(undefined).messages, []);
});
