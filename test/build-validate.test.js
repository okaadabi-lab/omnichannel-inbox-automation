'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildAll } = require('../scripts/build');
const { loadSettings } = require('../scripts/lib/config');
const { bundleCode } = require('../scripts/lib/bundle');
const { validateWorkflows } = require('../scripts/lib/validate-workflow');
const credentials = require('../scripts/lib/credentials');

const ROOT = path.join(__dirname, '..');
const ENV_EXAMPLE = path.join(ROOT, '.env.example');
const built = buildAll(ENV_EXAMPLE).map(({ file, text }) => ({ file, workflow: JSON.parse(text) }));
const options = { credentials, errorWorkflowId: 'oiaErrorHandler' };

function withChange(file, change) {
  const copy = structuredClone(built);
  change(copy.find((entry) => entry.file === file).workflow);
  return validateWorkflows(copy, options);
}

const node = (workflow, name) => workflow.nodes.find((n) => n.name === name);

test('the committed workflows/dist matches a fresh build of the templates', () => {
  for (const { file, text } of buildAll(ENV_EXAMPLE)) {
    const committed = fs.readFileSync(path.join(ROOT, 'workflows', 'dist', file), 'utf8');
    assert.equal(committed, text, `${file} is stale; run npm run build`);
  }
});

test('the built workflows pass validation', () => {
  assert.deepEqual(
    built.map((entry) => entry.file),
    [
      'error-handler.json',
      'inbound-message-router.json',
      'instagram-comment-reply.json',
      'payslip-notifications.json',
    ],
  );
  assert.deepEqual(validateWorkflows(built, options), []);
});

test('validation catches structural mistakes', () => {
  const router = 'inbound-message-router.json';
  assert.match(
    withChange(router, (w) => {
      node(w, 'Plan Actions').name = 'Prepare Message';
    }).join('\n'),
    /duplicate node name "Prepare Message"/,
  );
  assert.match(
    withChange(router, (w) => {
      w.connections['Plan Actions'].main[0][0].node = 'Missing Node';
    }).join('\n'),
    /connects to unknown node "Missing Node"/,
  );
  assert.match(
    withChange(router, (w) => {
      delete w.connections['Check Meta Signature'];
    }).join('\n'),
    /"Meta Signature Valid\?" has no incoming connection/,
  );
  assert.match(
    withChange(router, (w) => {
      w.connections['Meta Signature Valid?'].main = [[], []];
    }).join('\n'),
    /webhook "Meta Webhook" never reaches a Respond to Webhook node/,
  );
});

test('validation rejects embedded credentials and secrets', () => {
  const router = 'inbound-message-router.json';
  assert.match(
    withChange(router, (w) => {
      node(w, 'Ask AI Support').credentials.httpBearerAuth.id = 'a1b2c3';
    }).join('\n'),
    /must reference credentials by name/,
  );
  assert.match(
    withChange(router, (w) => {
      node(w, 'Ask AI Support').credentials.httpBearerAuth.name = 'My Key';
    }).join('\n'),
    /unknown credential "My Key"/,
  );
  assert.match(
    withChange(router, (w) => {
      node(w, 'Send Telegram Reply').parameters.text =
        '123456789:AAHfictionalTokenValue1234567890abc';
    }).join('\n'),
    /Telegram bot token/,
  );
  assert.match(
    withChange(router, (w) => {
      node(w, 'Ask AI Support').parameters.headerParameters.parameters.push({
        name: 'Authorization',
        value: 'Bearer sk_live_fictional_value_1234',
      });
    }).join('\n'),
    /literal bearer token/,
  );
});

test('validation enforces retries, timeouts and the error workflow', () => {
  const router = 'inbound-message-router.json';
  assert.match(
    withChange(router, (w) => {
      delete node(w, 'Ask AI Support').parameters.options.timeout;
    }).join('\n'),
    /"Ask AI Support" needs an explicit timeout/,
  );
  assert.match(
    withChange(router, (w) => {
      node(w, 'Send WhatsApp Reply').retryOnFail = false;
    }).join('\n'),
    /"Send WhatsApp Reply" needs retryOnFail/,
  );
  assert.match(
    withChange(router, (w) => {
      node(w, 'Alert Admin Group').parameters.additionalFields = {};
    }).join('\n'),
    /attribution footer/,
  );
  assert.match(
    withChange(router, (w) => {
      delete node(w, 'Alert Admin Group').parameters.additionalFields.parse_mode;
    }).join('\n'),
    /"Alert Admin Group" must set parse_mode to HTML/,
  );
  assert.match(
    withChange('payslip-notifications.json', (w) => {
      delete w.settings.errorWorkflow;
    }).join('\n'),
    /settings\.errorWorkflow must be "oiaErrorHandler"/,
  );
});

test('validation rejects environment access, SQL built from expressions and dangling calls', () => {
  assert.match(
    withChange('error-handler.json', (w) => {
      node(w, 'Format Alert').parameters.jsCode += '\nconst token = $env.BOT_TOKEN;';
    }).join('\n'),
    /reads environment variables/,
  );
  assert.match(
    withChange('error-handler.json', (w) => {
      node(w, 'Format Alert').parameters.jsCode += "\nconst crypto = require('crypto');";
    }).join('\n'),
    /requires a module/,
  );
  assert.match(
    withChange('payslip-notifications.json', (w) => {
      node(w, 'Claim Send').parameters.query += ' AND event_type = "{{ $json.type }}"';
    }).join('\n'),
    /builds SQL from an expression/,
  );
  assert.match(
    withChange('inbound-message-router.json', (w) => {
      node(w, 'Hand Off Comments').parameters.workflowId.value = 'unknownWorkflow';
    }).join('\n'),
    /calls a workflow that is not in this repository/,
  );
});

test('settings are validated when loading the env file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oia-settings-'));
  const envFile = path.join(dir, 'bad.env');
  const text = fs
    .readFileSync(ENV_EXAMPLE, 'utf8')
    .replace(/^AI_SUPPORT_BASE_URL=.*$/m, 'AI_SUPPORT_BASE_URL=ftp://ai/')
    .replace(/^META_VERIFY_TOKEN_SHA256=.*$/m, 'META_VERIFY_TOKEN_SHA256=plain-token')
    .replace(/^OUTBOX_MAX_ATTEMPTS=.*$/m, '');
  fs.writeFileSync(envFile, text);

  assert.throws(
    () => loadSettings(envFile),
    (error) => {
      assert.match(error.message, /AI_SUPPORT_BASE_URL must be an http\(s\) URL/);
      assert.match(error.message, /META_VERIFY_TOKEN_SHA256 must be a lowercase SHA-256/);
      assert.match(error.message, /OUTBOX_MAX_ATTEMPTS is missing/);
      return true;
    },
  );
  assert.equal(loadSettings(ENV_EXAMPLE).OUTBOX_MAX_ATTEMPTS, 5);
});

test('a Code node may only use settings that exist', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oia-glue-'));
  const glue = path.join(dir, 'glue.js');
  fs.writeFileSync(glue, 'return { json: { value: CONFIG.NOT_A_SETTING } };\n');
  assert.throws(
    () => bundleCode(glue, { srcDir: path.join(ROOT, 'src'), settings: {}, label: 'glue.js' }),
    /unknown setting CONFIG\.NOT_A_SETTING/,
  );
});
