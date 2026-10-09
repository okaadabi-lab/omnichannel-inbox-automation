'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { formatErrorAlert } = require('../src/error-alert');
const { loadFixture } = require('./helpers/fixtures');

test('formats workflow, node, error and execution link', () => {
  assert.equal(
    formatErrorAlert(loadFixture('error-trigger.json')),
    [
      'n8n workflow failed',
      'Workflow: inbound-message-router',
      'Node: Ask AI Support',
      'Detail: connect ECONNREFUSED 10.0.0.12:8083',
      'Error: The service was not able to process your request',
      'Execution: https://n8n.example.com/workflow/oiaInboundRouter/executions/231',
    ].join('\n'),
  );
});

test('handles trigger failures that have no execution', () => {
  const text = formatErrorAlert({
    trigger: { error: { message: 'Webhook could not be registered' }, mode: 'trigger' },
    workflow: { id: 'oiaPayslipNotify', name: 'payslip-notifications' },
  });
  assert.match(text, /Workflow: payslip-notifications/);
  assert.match(text, /Error: Webhook could not be registered/);
  assert.match(text, /Execution: not started/);
});

test('long error messages are truncated so the Telegram alert still fits', () => {
  const data = loadFixture('error-trigger.json');
  data.execution.error.message = 'x'.repeat(5000);
  assert.ok(formatErrorAlert(data).length < 4096);
});

test('HTML error pages from upstream services are escaped for Telegram', () => {
  const data = loadFixture('error-trigger.json');
  data.execution.error.message = '502 - "<html><body>Bad Gateway</body></html>"';
  const text = formatErrorAlert(data);
  assert.doesNotMatch(text, /</);
  assert.match(text, /&lt;html&gt;&lt;body&gt;Bad Gateway/);
});
