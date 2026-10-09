'use strict';

// Runs the JavaScript that the build puts into Code nodes, outside n8n, with a minimal stand-in
// for the n8n globals. This proves each node is self-contained (no require, no module scope)
// and that the glue code wires the src/ functions to the right inputs.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { buildAll } = require('../scripts/build');
const { loadFixture, rawFixture, hmacHex, sha256Hex } = require('./helpers/fixtures');

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const workflows = Object.fromEntries(
  buildAll(path.join(__dirname, '..', '.env.example')).map(({ file, text }) => [
    file.replace('.json', ''),
    JSON.parse(text),
  ]),
);

function runCodeNode(workflowName, nodeName, { json = {}, items = [], nodes = {} } = {}) {
  const node = workflows[workflowName].nodes.find((n) => n.name === nodeName);
  const context = {
    $json: json,
    $input: { all: () => items.map((item) => ({ json: item })) },
    $: (name) => {
      if (!(name in nodes)) throw new Error(`Test did not provide node "${name}"`);
      return { item: { json: nodes[name] } };
    },
  };
  const run = new AsyncFunction(...Object.keys(context), node.parameters.jsCode);
  return run(...Object.values(context));
}

test('Check Meta Signature accepts the HMAC of the raw body and rejects others', async () => {
  const body = rawFixture('whatsapp-text.json');
  const computed = hmacHex('app-secret', body);
  const json = {
    headers: { 'x-hub-signature-256': `sha256=${computed}` },
    computed_signature: computed,
    body: JSON.parse(body),
  };

  const accepted = await runCodeNode('inbound-message-router', 'Check Meta Signature', { json });
  assert.equal(accepted.json.valid, true);
  assert.equal(accepted.json.body.object, 'whatsapp_business_account');

  const rejected = await runCodeNode('inbound-message-router', 'Check Meta Signature', {
    json: { ...json, headers: { 'x-hub-signature-256': `sha256=${hmacHex('other', body)}` } },
  });
  assert.deepEqual([rejected.json.valid, rejected.json.reason], [false, 'signature_mismatch']);
});

test('the default verify token hash fails closed', async () => {
  const result = await runCodeNode('inbound-message-router', 'Check Verify Token', {
    json: {
      query: { 'hub.mode': 'subscribe', 'hub.challenge': '42', 'hub.verify_token': '' },
      verify_token_sha256: sha256Hex(''),
    },
  });
  assert.equal(result.json.valid, false);
});

test('Meta extraction splits direct messages from comments', async () => {
  const items = [
    { body: loadFixture('whatsapp-text.json') },
    { body: loadFixture('instagram-comments.json') },
  ];
  const messages = await runCodeNode('inbound-message-router', 'Extract Meta Messages', { items });
  const comments = await runCodeNode('inbound-message-router', 'Extract Instagram Comments', {
    items,
  });
  assert.deepEqual(
    messages.map((m) => m.json.channel),
    ['whatsapp'],
  );
  assert.deepEqual(
    comments.map((c) => c.json.comment_id),
    ['18100000000000001', '18100000000000002'],
  );
});

test('Prepare Message and Plan Actions chain into a send request and a log row', async () => {
  const [message] = await runCodeNode('inbound-message-router', 'Extract Telegram Message', {
    items: [{ body: loadFixture('telegram-message.json') }],
  });
  const prepared = await runCodeNode('inbound-message-router', 'Prepare Message', {
    json: message.json,
  });
  assert.equal(prepared.json.ai_request.external_message_id, '700000001:42');
  assert.equal(prepared.json.claim.received_at, '2026-10-09 10:06:40.000');

  const plan = await runCodeNode('inbound-message-router', 'Plan Actions', {
    json: {
      conversation_id: 'c-1',
      action: 'reply',
      reply_text: 'Masih tersedia, kak.',
      reasons: ['answered_from_knowledge_base'],
      intent: 'availability_question',
      confidence: 0.8,
      citations: [],
    },
    nodes: {
      'Prepare Message': prepared.json,
      'Claim Message': { data: { affectedRows: 1, insertId: 31 } },
    },
  });
  assert.deepEqual(plan.json.send, {
    channel: 'telegram',
    chat_id: '700000001',
    text: 'Masih tersedia, kak.',
  });
  assert.equal(plan.json.log.id, 31);
});

test('Plan Deliveries uses the template names from the settings', async () => {
  const event = loadFixture('outbox-page.json').data[0];
  const plan = await runCodeNode('payslip-notifications', 'Plan Deliveries', {
    json: { event_id: 41, attempts: 0, status: 'pending' },
    nodes: { 'Collect Events': event },
  });
  assert.equal(plan.json.action, 'send');
  assert.equal(plan.json.send_request.template.name, 'payslip_ready');
  assert.equal(plan.json.send_request.template.language.code, 'id');
});

test('Format Alert renders the error trigger payload', async () => {
  const result = await runCodeNode('error-handler', 'Format Alert', {
    json: loadFixture('error-trigger.json'),
  });
  assert.match(result.json.text, /^n8n workflow failed\nWorkflow: inbound-message-router/);
});
