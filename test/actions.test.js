'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { planActions, assertDecision } = require('../src/actions');
const { buildAiRequest, buildClaimRow } = require('../src/canonical');
const { normalizeWhatsApp } = require('../src/normalize-whatsapp');
const { normalizeInstagram } = require('../src/normalize-instagram');
const { normalizeTelegram } = require('../src/normalize-telegram');
const { loadFixture } = require('./helpers/fixtures');

const NOW = new Date('2026-10-09T10:00:05.000Z');
const whatsapp = normalizeWhatsApp(loadFixture('whatsapp-text.json')).messages[0];
const instagram = normalizeInstagram(loadFixture('instagram-dm.json')).messages[0];
const telegram = normalizeTelegram(loadFixture('telegram-message.json')).messages[0];

const replyDecision = {
  conversation_id: 'f3b46189-6cf0-4913-9a2e-157743fc340c',
  action: 'reply',
  reply_text: 'Paket Anggrek Rp 12.500.000 kak, untuk sampai 150 tamu.',
  reasons: ['answered_from_knowledge_base'],
  intent: 'pricing_question',
  confidence: 0.85,
  citations: [{ article_id: 'paket-dan-harga', title: 'Paket dekorasi dan harga' }],
};
const escalateDecision = {
  ...replyDecision,
  action: 'escalate',
  reply_text: 'Terima kasih, kak. Tim kami akan menghubungi kakak secepatnya.',
  reasons: ['intent_refund_request'],
  intent: 'refund_request',
  confidence: 0.62,
  citations: [],
};
const noneDecision = {
  ...replyDecision,
  action: 'none',
  reply_text: null,
  reasons: ['human_handoff_active'],
  intent: null,
  confidence: null,
};

test('buildAiRequest matches the ai-support-service request contract', () => {
  assert.deepEqual(buildAiRequest(whatsapp), {
    channel: 'whatsapp',
    external_message_id: whatsapp.external_message_id,
    customer_id: '6281200000001',
    customer_name: 'Rina Wulandari',
    text: 'kak brp harga paket anggrek?',
    received_at: '2026-10-09T10:00:00.000Z',
  });
  assert.equal('customer_name' in buildAiRequest(instagram), false);
});

test('buildAiRequest refuses a message that breaks the canonical contract', () => {
  assert.throws(() => buildAiRequest({ ...whatsapp, channel: 'sms' }), /Unknown channel/);
  assert.throws(() => buildAiRequest({ ...whatsapp, text: '' }), /"text"/);
  assert.throws(() => buildAiRequest({ ...whatsapp, received_at: 'yesterday' }), /received_at/);
});

test('buildClaimRow produces message_log columns with a UTC DATETIME', () => {
  assert.deepEqual(buildClaimRow(telegram), {
    channel: 'telegram',
    external_message_id: '700000001:42',
    customer_id: '700000001',
    customer_name: 'Bayu Pratama',
    text_preview: 'Selamat siang, tanggal 14 Desember masih tersedia?',
    received_at: '2026-10-09 10:06:40.000',
  });
});

test('reply on WhatsApp sends a text message to the sender through the receiving number', () => {
  const plan = planActions(whatsapp, replyDecision, { logId: 7, now: NOW });

  assert.equal(plan.action, 'reply');
  assert.deepEqual(plan.send, {
    channel: 'whatsapp',
    path_id: '200000000000001',
    body: {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '6281200000001',
      type: 'text',
      text: { preview_url: false, body: replyDecision.reply_text },
    },
  });
  assert.equal(plan.admin_alert_text, null);
  assert.deepEqual(plan.log, {
    id: 7,
    status: 'replied',
    action: 'reply',
    intent: 'pricing_question',
    confidence: 0.85,
    reasons: '["answered_from_knowledge_base"]',
    conversation_id: replyDecision.conversation_id,
    reply_text: replyDecision.reply_text,
    processed_at: '2026-10-09 10:00:05.000',
  });
});

test('reply on Instagram and Telegram uses each channel payload', () => {
  assert.deepEqual(planActions(instagram, replyDecision, { logId: 1, now: NOW }).send, {
    channel: 'instagram',
    path_id: '17841400000000001',
    body: { recipient: { id: '1100000000000001' }, message: { text: replyDecision.reply_text } },
  });
  assert.deepEqual(planActions(telegram, replyDecision, { logId: 1, now: NOW }).send, {
    channel: 'telegram',
    chat_id: '700000001',
    text: replyDecision.reply_text,
  });
});

test('escalate sends the holding message and renders an admin alert', () => {
  const plan = planActions(whatsapp, escalateDecision, { logId: 8, now: NOW });

  assert.equal(plan.send.body.text.body, escalateDecision.reply_text);
  assert.equal(plan.log.status, 'escalated');
  assert.equal(
    plan.admin_alert_text,
    [
      'Customer needs a human',
      'Channel: WhatsApp',
      'Customer: Rina Wulandari (6281200000001)',
      'Intent: refund_request (confidence 0.62)',
      'Reasons: intent_refund_request',
      'Conversation: f3b46189-6cf0-4913-9a2e-157743fc340c',
      'Received: 2026-10-09T10:00:00.000Z',
      '',
      'Last message:',
      'kak brp harga paket anggrek?',
      '',
      `Holding reply sent: ${escalateDecision.reply_text}`,
    ].join('\n'),
  );
});

test('Telegram texts are escaped for HTML parse mode, the log keeps the raw reply', () => {
  const decision = { ...escalateDecision, reply_text: 'Baik <kak> & terima kasih' };
  const message = { ...whatsapp, text: 'refund_DP <segera> & cepat' };
  const plan = planActions(message, decision, { logId: 10, now: NOW });
  assert.match(plan.admin_alert_text, /refund_DP &lt;segera&gt; &amp; cepat/);
  assert.match(plan.admin_alert_text, /Holding reply sent: Baik &lt;kak&gt; &amp; terima kasih/);
  assert.equal(plan.log.reply_text, 'Baik <kak> & terima kasih');

  const onTelegram = planActions(telegram, decision, { logId: 11, now: NOW });
  assert.equal(onTelegram.send.text, 'Baik &lt;kak&gt; &amp; terima kasih');
});

test('none sends nothing and logs no_action', () => {
  const plan = planActions(telegram, noneDecision, { logId: 9, now: NOW });
  assert.equal(plan.send, null);
  assert.equal(plan.admin_alert_text, null);
  assert.equal(plan.log.status, 'no_action');
  assert.equal(plan.log.reply_text, null);
  assert.equal(plan.log.confidence, null);
});

test('Instagram replies are cut to 1000 UTF-8 bytes', () => {
  const longReply = { ...replyDecision, reply_text: 'Harga ✨ '.repeat(200) };
  const text = planActions(instagram, longReply, { logId: 1, now: NOW }).send.body.message.text;
  assert.ok(new TextEncoder().encode(text).length <= 1000);
});

test('malformed AI decisions are rejected before anything is sent', () => {
  assert.throws(() => assertDecision(null), /missing/);
  assert.throws(() => assertDecision({ ...replyDecision, action: 'maybe' }), /unknown action/);
  assert.throws(() => assertDecision({ ...replyDecision, reply_text: ' ' }), /no reply_text/);
  assert.throws(() => assertDecision({ ...replyDecision, reasons: 'x' }), /reasons/);
  assert.throws(() => assertDecision({ ...replyDecision, confidence: 1.5 }), /confidence/);
  assert.throws(() => assertDecision({ ...replyDecision, conversation_id: '' }), /conversation_id/);
});
