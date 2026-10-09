'use strict';

// End-to-end check against a real n8n instance. Optional and not part of CI: it needs an n8n
// installation (Node.js 24) and a scratch MySQL/MariaDB database that it will reset.
//
//   N8N_BIN=/path/to/node_modules/.bin/n8n \
//   E2E_MYSQL_URL=mysql://user:pass@127.0.0.1:3306/inbox_automation_e2e \
//   npm run e2e
//
// It builds the workflows against local mock services, imports them into a throwaway n8n
// (SQLite, temporary user folder), fires signed webhooks and runs the payroll workflow once.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const mysql = require('mysql2/promise');
const { buildAll } = require('./build');
const credentialManifest = require('./lib/credentials');
const mocks = require('./lib/e2e-mocks');

const ROOT = path.resolve(__dirname, '..');
const SECRETS = {
  appSecret: 'e2e-meta-app-secret',
  verifyToken: 'e2e-verify-token',
  telegramSecret: 'e2e-telegram-secret',
  whatsappToken: 'e2e-whatsapp-token',
  instagramToken: 'e2e-instagram-token',
  aiKey: 'e2e-ai-key',
  payrollKey: 'e2e-payroll-key',
  botToken: '123456:e2e-bot-token',
};
const ADMIN_CHAT = '-1009000000001';
const OPS_CHAT = '-1009000000002';
const FAILING_PHONE = '6281200000099';
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required (see the comment at the top of scripts/e2e.js)`);
  return value;
}

function freePort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitFor(check, label, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await check();
    if (result) return result;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for: ${label}`);
    await sleep(250);
  }
}

function step(label) {
  console.log(`ok - ${label}`);
}

function runN8n(n8nBin, args, env, logFile) {
  return new Promise((resolve, reject) => {
    const child = spawn(n8nBin, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const log = fs.createWriteStream(logFile, { flags: 'a' });
    child.stdout.pipe(log);
    child.stderr.pipe(log);
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`n8n ${args[0]} exited with ${code}; see ${logFile}`)),
    );
  });
}

function payrollEvents() {
  const payload = (id, name, phone) => ({
    employee_id: id,
    employee_name: name,
    phone,
    period: '2026-09',
    net_pay: 8250000,
    payslip_url: `http://localhost:8082/api/v1/payslips/${id}`,
  });
  return [
    {
      id: 1,
      type: 'payslip.published',
      occurred_at: '2026-10-01T03:00:00Z',
      payload: payload(11, 'Budi Santoso', '+62812000011'),
    },
    {
      id: 2,
      type: 'payroll.paid',
      occurred_at: '2026-10-01T03:00:01Z',
      payload: payload(12, 'Dewi Anggraini', `+${FAILING_PHONE}`),
    },
    {
      id: 3,
      type: 'payslip.published',
      occurred_at: '2026-10-01T03:00:02Z',
      payload: payload(13, 'Citra Lestari', null),
    },
    {
      id: 4,
      type: 'payroll.paid',
      occurred_at: '2026-10-01T03:00:03Z',
      payload: payload(14, 'Eko Prasetyo', `+${FAILING_PHONE}`),
    },
  ];
}

function credentialData(type, services, db) {
  switch (type) {
    case 'crypto':
      return { hmacSecret: SECRETS.appSecret };
    case 'telegramApi':
      return { accessToken: SECRETS.botToken, baseUrl: services.telegram.url };
    case 'httpHeaderAuth':
      return { name: 'X-Api-Key', value: SECRETS.payrollKey };
    case 'mySql':
      return {
        host: db.host,
        port: db.port,
        database: db.database,
        user: db.user,
        password: db.password,
      };
    default:
      return null;
  }
}

const BEARER_TOKENS = {
  'WhatsApp Cloud API': SECRETS.whatsappToken,
  'Instagram API': SECRETS.instagramToken,
  'AI Support Service': SECRETS.aiKey,
};

async function main() {
  const n8nBin = requireEnv('N8N_BIN');
  const dbUrl = new URL(requireEnv('E2E_MYSQL_URL'));
  const db = {
    host: dbUrl.hostname,
    port: Number(dbUrl.port || 3306),
    user: decodeURIComponent(dbUrl.username),
    password: decodeURIComponent(dbUrl.password),
    database: dbUrl.pathname.slice(1),
  };
  if (!db.database.endsWith('_e2e'))
    throw new Error('E2E_MYSQL_URL must point at a *_e2e database');

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oia-e2e-'));
  const logFile = path.join(workDir, 'n8n.log');
  console.log(`# work dir ${workDir}`);

  const events = payrollEvents();
  const services = {
    ai: await mocks.startAiSupport({ apiKey: SECRETS.aiKey, slowMs: 4000 }),
    meta: await mocks.startMetaGraph({
      whatsappToken: SECRETS.whatsappToken,
      instagramToken: SECRETS.instagramToken,
      failingPhone: FAILING_PHONE,
    }),
    telegram: await mocks.startTelegram({ botToken: SECRETS.botToken }),
    payroll: await mocks.startPayroll({ apiKey: SECRETS.payrollKey, events }),
  };

  const connection = await mysql.createConnection({ ...db, multipleStatements: true });
  let n8nServer;
  let passed = false;
  try {
    await connection.query(
      'DROP TABLE IF EXISTS message_log, comment_reply_counter, outbox_delivery_attempts',
    );
    await connection.query(fs.readFileSync(path.join(ROOT, 'sql', 'schema.sql'), 'utf8'));
    // Event 4 has already failed four times in earlier runs.
    await connection.query(
      "INSERT INTO outbox_delivery_attempts (event_id, event_type, employee_id, attempts, status) VALUES (4, 'payroll.paid', 14, 4, 'failed')",
    );

    const envFile = path.join(workDir, 'e2e.env');
    fs.writeFileSync(
      envFile,
      [
        `AI_SUPPORT_BASE_URL=${services.ai.url}`,
        `HR_PAYROLL_BASE_URL=${services.payroll.url}`,
        `META_GRAPH_BASE_URL=${services.meta.url}/fb`,
        `INSTAGRAM_GRAPH_BASE_URL=${services.meta.url}/ig`,
        'META_GRAPH_VERSION=v25.0',
        'WHATSAPP_PHONE_NUMBER_ID=200000000000001',
        'WHATSAPP_TEMPLATE_LANGUAGE=id',
        'PAYSLIP_TEMPLATE_NAME=payslip_ready',
        'PAYROLL_PAID_TEMPLATE_NAME=salary_paid',
        'OUTBOX_MAX_ATTEMPTS=5',
        `TELEGRAM_ADMIN_CHAT_ID=${ADMIN_CHAT}`,
        `TELEGRAM_OPS_CHAT_ID=${OPS_CHAT}`,
        `META_VERIFY_TOKEN_SHA256=${sha256(SECRETS.verifyToken)}`,
        `TELEGRAM_WEBHOOK_SECRET_SHA256=${sha256(SECRETS.telegramSecret)}`,
        'COMMENT_REPLY_CAP_PER_HOUR=2',
        'PRICE_LIST_URL=https://example.com/paket-dan-harga',
      ].join('\n'),
    );
    const workflowDir = path.join(workDir, 'workflows');
    fs.mkdirSync(workflowDir);
    for (const { file, text } of buildAll(envFile))
      fs.writeFileSync(path.join(workflowDir, file), text);

    const credentialsFile = path.join(workDir, 'credentials.json');
    fs.writeFileSync(
      credentialsFile,
      JSON.stringify(
        Object.entries(credentialManifest).map(([name, { type }], index) => ({
          id: `oiaE2eCred${String(index).padStart(4, '0')}`,
          name,
          type,
          data: credentialData(type, services, db) ?? { token: BEARER_TOKENS[name] },
        })),
      ),
    );

    const port = await freePort();
    const env = {
      ...process.env,
      N8N_USER_FOLDER: path.join(workDir, 'n8n'),
      N8N_PORT: String(port),
      N8N_LISTEN_ADDRESS: '127.0.0.1',
      N8N_RUNNERS_BROKER_PORT: String(await freePort()),
      N8N_ENCRYPTION_KEY: 'e2e-encryption-key-not-for-production',
      N8N_DIAGNOSTICS_ENABLED: 'false',
      N8N_VERSION_NOTIFICATIONS_ENABLED: 'false',
      N8N_SECURE_COOKIE: 'false',
      N8N_LOG_LEVEL: 'info',
      WEBHOOK_URL: `http://127.0.0.1:${port}/`,
      GENERIC_TIMEZONE: 'UTC',
    };

    await runN8n(n8nBin, ['import:credentials', `--input=${credentialsFile}`], env, logFile);
    await runN8n(n8nBin, ['import:workflow', '--separate', `--input=${workflowDir}`], env, logFile);
    for (const id of ['oiaErrorHandler', 'oiaCommentReply', 'oiaInboundRouter']) {
      await runN8n(n8nBin, ['publish:workflow', `--id=${id}`], env, logFile);
    }
    step('built workflows imported and published in n8n');

    await testPayroll({ n8nBin, env, logFile, services, connection });

    n8nServer = spawn(n8nBin, ['start'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const serverLog = fs.createWriteStream(logFile, { flags: 'a' });
    n8nServer.stdout.pipe(serverLog);
    n8nServer.stderr.pipe(serverLog);
    const base = `http://127.0.0.1:${port}`;
    await waitFor(
      async () => {
        try {
          const response = await fetch(`${base}/webhook/inbox/meta?hub.mode=subscribe`);
          return response.status !== 404;
        } catch {
          return false;
        }
      },
      'n8n webhooks to be registered',
      120000,
    );
    step('n8n started and registered the webhooks');

    await testWebhooks({ base, services, connection });
    passed = true;
    console.log('# all end-to-end checks passed');
  } finally {
    if (n8nServer) {
      const exited = new Promise((resolve) => n8nServer.once('exit', resolve));
      n8nServer.kill('SIGTERM');
      await Promise.race([exited, sleep(15000)]);
    }
    await connection.end();
    await Promise.all(Object.values(services).map((service) => service.close()));
    // Keep the n8n log and data of a failed run for debugging.
    if (passed) fs.rmSync(workDir, { recursive: true, force: true });
  }
}

async function testPayroll({ n8nBin, env, logFile, services, connection }) {
  const whatsappSends = () => services.meta.requests.filter((r) => r.path.startsWith('/fb/'));
  const opsAlerts = () =>
    services.telegram.requests.filter((r) => String(r.body.chat_id) === OPS_CHAT);
  const ackedIds = () =>
    services.payroll.requests
      .filter((r) => r.path.endsWith('/ack'))
      .flatMap((r) => r.body.ids)
      .sort((a, b) => a - b);

  await runN8n(n8nBin, ['execute', '--id=oiaPayslipNotify'], env, logFile);

  assert.deepEqual(ackedIds(), [1, 3, 4], 'ack must contain delivered and terminal ids only');
  const [rows] = await connection.query(
    'SELECT event_id, attempts, status, provider_message_id FROM outbox_delivery_attempts ORDER BY event_id',
  );
  assert.deepEqual(
    rows.map((r) => [r.event_id, r.attempts, r.status]),
    [
      [1, 1, 'delivered'],
      [2, 1, 'failed'],
      [3, 0, 'undeliverable'],
      [4, 5, 'gave_up'],
    ],
  );
  assert.match(rows[0].provider_message_id, /^wamid\.MOCK/);

  const first = whatsappSends().find((r) => r.body.to === '62812000011');
  assert.equal(first.body.type, 'template');
  assert.equal(first.body.template.name, 'payslip_ready');
  assert.deepEqual(
    first.body.template.components[0].parameters.map((p) => p.text),
    ['Budi Santoso', 'September 2026', 'http://localhost:8082/api/v1/payslips/11'],
  );
  const alertTexts = opsAlerts().map((r) => r.body.text);
  assert.equal(alertTexts.length, 2);
  assert.ok(alertTexts.some((text) => /Event: #3 payslip\.published[\s\S]*no phone/.test(text)));
  assert.ok(
    alertTexts.some((text) =>
      /Event: #4 payroll\.paid[\s\S]*HTTP 500: Service temporarily unavailable/.test(text),
    ),
  );
  step(
    'payroll run: delivered #1, kept failed #2 unacked, alerted and acked #3 (no phone) and #4 (5th attempt)',
  );

  const sendsBefore = whatsappSends().length;
  await runN8n(n8nBin, ['execute', '--id=oiaPayslipNotify'], env, logFile);
  const retried = whatsappSends().slice(sendsBefore);
  assert.ok(retried.length > 0 && retried.every((r) => r.body.to === FAILING_PHONE));
  assert.deepEqual(ackedIds(), [1, 3, 4]);
  const [[eventTwo]] = await connection.query(
    'SELECT attempts, status FROM outbox_delivery_attempts WHERE event_id = 2',
  );
  assert.deepEqual({ ...eventTwo }, { attempts: 2, status: 'failed' });
  step('second payroll run retried only the unacked failure and sent nothing twice');
}

async function testWebhooks({ base, services, connection }) {
  const metaUrl = `${base}/webhook/inbox/meta`;
  const telegramUrl = `${base}/webhook/inbox/telegram`;
  const fixture = (name) => fs.readFileSync(path.join(ROOT, 'test', 'fixtures', name), 'utf8');
  const signed = (body, secret = SECRETS.appSecret) => ({
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Hub-Signature-256': `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`,
    },
    body,
  });
  const whatsappPayload = (id, text) => {
    const payload = JSON.parse(fixture('whatsapp-text.json'));
    const message = payload.entry[0].changes[0].value.messages[0];
    message.id = id;
    message.text.body = text;
    // Pretty-printed with odd spacing on purpose: the signature must cover these exact bytes.
    return JSON.stringify(payload, null, 3);
  };
  const aiCallsFor = (id) => services.ai.requests.filter((r) => r.body.external_message_id === id);
  const graphCalls = (suffix) => services.meta.requests.filter((r) => r.path.endsWith(suffix));
  const telegramTo = (chatId) =>
    services.telegram.requests.filter((r) => String(r.body.chat_id) === chatId);
  const logRow = async (channel, id) => {
    const [rows] = await connection.query(
      'SELECT * FROM message_log WHERE channel = ? AND external_message_id = ?',
      [channel, id],
    );
    return rows[0];
  };

  // Meta verification handshake
  const challenge = await fetch(
    `${metaUrl}?hub.mode=subscribe&hub.verify_token=${SECRETS.verifyToken}&hub.challenge=1158201444`,
  );
  assert.equal(challenge.status, 200);
  assert.equal(await challenge.text(), '1158201444');
  const wrongToken = await fetch(
    `${metaUrl}?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1`,
  );
  assert.equal(wrongToken.status, 403);
  step('Meta GET verification echoes the challenge only for the right verify token');

  // Signed WhatsApp text -> AI reply -> WhatsApp send -> message_log
  const replyId = 'wamid.E2E_REPLY_0001';
  const replyBody = whatsappPayload(replyId, 'kak brp harga paket anggrek?');
  const accepted = await fetch(metaUrl, signed(replyBody));
  assert.equal(accepted.status, 200);
  assert.equal(await accepted.text(), 'EVENT_RECEIVED');
  const sent = await waitFor(
    () =>
      graphCalls('/messages').find(
        (r) => r.path === '/fb/v25.0/200000000000001/messages' && r.body.type === 'text',
      ),
    'WhatsApp reply',
  );
  assert.deepEqual(sent.body, {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: '6281200000001',
    type: 'text',
    text: {
      preview_url: false,
      body: 'Paket Anggrek mulai Rp 12.500.000 kak, untuk sampai 150 tamu.',
    },
  });
  const [aiCall] = aiCallsFor(replyId);
  assert.deepEqual(aiCall.body, {
    channel: 'whatsapp',
    external_message_id: replyId,
    customer_id: '6281200000001',
    customer_name: 'Rina Wulandari',
    text: 'kak brp harga paket anggrek?',
    received_at: '2026-10-09T10:00:00.000Z',
  });
  assert.match(aiCall.headers['x-request-id'], /^n8n-\d+$/);
  const replied = await waitFor(async () => {
    const row = await logRow('whatsapp', replyId);
    return row?.status === 'replied' ? row : null;
  }, 'message_log row marked replied');
  assert.equal(replied.intent, 'pricing_question');
  // mysql2 already decodes JSON columns on MySQL; MariaDB stores JSON as LONGTEXT.
  const reasons =
    typeof replied.reasons === 'string' ? JSON.parse(replied.reasons) : replied.reasons;
  assert.deepEqual(reasons, ['answered_from_knowledge_base']);
  step('signed WhatsApp message was answered through the AI service and logged');

  // Meta gets its 200 before the (slow) AI call finishes
  const slowId = 'wamid.E2E_SLOW_0001';
  const startedAt = Date.now();
  const slowResponse = await fetch(metaUrl, signed(whatsappPayload(slowId, 'jawabnya lambat ya')));
  const responseMs = Date.now() - startedAt;
  assert.equal(slowResponse.status, 200);
  assert.ok(responseMs < 2000, `Meta waited ${responseMs} ms for the response`);
  await waitFor(async () => (await logRow('whatsapp', slowId))?.status === 'replied', 'slow reply');
  step(`Meta is acknowledged in ${responseMs} ms while the AI call takes 4 s afterwards`);

  // Bad signature
  const forgedId = 'wamid.E2E_FORGED_0001';
  const forged = await fetch(metaUrl, signed(whatsappPayload(forgedId, 'halo'), 'wrong-secret'));
  assert.equal(forged.status, 401);
  const unsigned = await fetch(metaUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: whatsappPayload(forgedId, 'halo'),
  });
  assert.equal(unsigned.status, 401);
  await sleep(2000);
  assert.equal(aiCallsFor(forgedId).length, 0);
  assert.equal(await logRow('whatsapp', forgedId), undefined);
  step('badly signed and unsigned Meta requests are rejected with 401 and not processed');

  // Duplicate delivery of the same webhook
  const sendsBefore = graphCalls('/messages').length;
  const duplicate = await fetch(metaUrl, signed(replyBody));
  assert.equal(duplicate.status, 200);
  await sleep(3000);
  assert.equal(aiCallsFor(replyId).length, 1);
  assert.equal(graphCalls('/messages').length, sendsBefore);
  step('a redelivered webhook is acknowledged but not answered twice');

  // Delivery statuses are not messages
  const aiBefore = services.ai.requests.length;
  const status = await fetch(metaUrl, signed(fixture('whatsapp-status.json')));
  assert.equal(status.status, 200);
  await sleep(2000);
  assert.equal(services.ai.requests.length, aiBefore);
  step('WhatsApp status callbacks are acknowledged and dropped');

  // Escalation: holding reply to the customer and an alert in the admin group
  const escalateId = 'wamid.E2E_ESCALATE_0001';
  // The underscores in the reason codes and the "<" and "&" from the customer must survive
  // Telegram's parser, so the mock rejects anything that is not escaped for the parse mode.
  await fetch(
    metaUrl,
    signed(whatsappPayload(escalateId, 'saya mau refund DP kemarin <segera> & cepat ya')),
  );
  const alert = await waitFor(() => telegramTo(ADMIN_CHAT)[0], 'admin group alert');
  assert.equal(alert.body.parse_mode, 'HTML');
  assert.match(alert.body.text, /^Customer needs a human/);
  assert.match(alert.body.text, /Intent: refund_request \(confidence 0\.91\)/);
  assert.match(alert.body.text, /Reasons: intent_refund_request/);
  assert.match(alert.body.text, /saya mau refund DP kemarin &lt;segera&gt; &amp; cepat ya/);
  await waitFor(
    () => graphCalls('/messages').find((r) => r.body.text?.body?.startsWith('Terima kasih, kak.')),
    'holding message to the customer',
  );
  await waitFor(
    async () => (await logRow('whatsapp', escalateId))?.status === 'escalated',
    'escalated row',
  );
  step('escalation sent the holding message and alerted the admin group');

  // Telegram
  const telegramBody = fixture('telegram-message.json');
  const telegramRejected = await fetch(telegramUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': 'guess' },
    body: telegramBody,
  });
  assert.equal(telegramRejected.status, 401);
  const telegramAccepted = await fetch(telegramUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Telegram-Bot-Api-Secret-Token': SECRETS.telegramSecret,
    },
    body: telegramBody,
  });
  assert.equal(telegramAccepted.status, 200);
  const telegramReply = await waitFor(() => telegramTo('700000001')[0], 'Telegram reply');
  assert.match(telegramReply.body.text, /^Paket Anggrek/);
  step('Telegram update with the secret token is answered; a wrong token gets 401');

  // Instagram DM
  await fetch(metaUrl, signed(fixture('instagram-dm.json')));
  const dm = await waitFor(
    () =>
      graphCalls('/messages').find(
        (r) => r.path === '/ig/v25.0/17841400000000001/messages' && r.body.recipient?.id,
      ),
    'Instagram DM reply',
  );
  assert.equal(dm.body.recipient.id, '1100000000000001');
  const igMid = JSON.parse(fixture('instagram-dm.json')).entry[0].messaging[0].message.mid;
  assert.equal(aiCallsFor(igMid).length, 1);
  step('Instagram DM is answered through the Instagram API');

  // Instagram comments: price question replied publicly and privately, spam ignored,
  // and the hourly cap (2 in this run) stops the third price reply.
  await fetch(metaUrl, signed(fixture('instagram-comments.json')));
  await waitFor(() => graphCalls('/18100000000000001/replies')[0], 'public comment reply');
  const privateReply = await waitFor(
    () => graphCalls('/messages').find((r) => r.body.recipient?.comment_id === '18100000000000001'),
    'private comment reply',
  );
  assert.match(privateReply.body.message.text, /example\.com\/paket-dan-harga/);
  await waitFor(
    async () => (await logRow('instagram_comment', '18100000000000002'))?.status === 'ignored',
    'spam logged',
  );

  const more = JSON.parse(fixture('instagram-comments.json'));
  more.entry[0].changes = ['18100000000000011', '18100000000000012'].map((id, index) => ({
    field: 'comments',
    value: {
      from: { id: `550000000000010${index}`, username: `tamu.${index}` },
      media: { id: '18000000000000001', media_product_type: 'FEED' },
      id,
      text: 'Harga paket ini berapaan kak?',
    },
  }));
  await fetch(metaUrl, signed(JSON.stringify(more)));
  await waitFor(
    async () => (await logRow('instagram_comment', '18100000000000012'))?.status === 'rate_limited',
    'third reply rate limited',
  );
  assert.equal(graphCalls('/replies').length, 2);
  assert.equal((await logRow('instagram_comment', '18100000000000011')).status, 'replied');
  step('comment rules: price replies public + private, spam ignored, hourly cap enforced');

  // A failing node runs the error workflow, which alerts ops
  await fetch(metaUrl, signed(whatsappPayload('wamid.E2E_ERROR_0001', 'trigger-error please')));
  const failure = await waitFor(
    () => telegramTo(OPS_CHAT).find((r) => r.body.text.startsWith('n8n workflow failed')),
    'error workflow alert',
    60000,
  );
  assert.match(failure.body.text, /Workflow: inbound-message-router/);
  assert.match(failure.body.text, /Node: Ask AI Support/);
  assert.match(
    failure.body.text,
    /Execution: http:\/\/127\.0\.0\.1:\d+\/workflow\/oiaInboundRouter\/executions\/\d+/,
  );
  assert.equal(aiCallsFor('wamid.E2E_ERROR_0001').length, 3);
  step('a failing AI call is retried three times, then the error workflow alerts ops');
}

main().catch((error) => {
  console.error(`not ok - ${error.message}`);
  process.exitCode = 1;
});
