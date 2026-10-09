'use strict';

const { truncate, escapeTelegramHtml } = require('./text');

const MESSAGE_LIMIT = 1500;

// Input is the item produced by n8n's Error Trigger. When the failure happened before an
// execution existed (for example a trigger that could not start) there is no execution block.
function formatErrorAlert(data) {
  const workflowName = data?.workflow?.name ?? 'unknown workflow';
  const execution = data?.execution;
  const error = execution?.error ?? data?.trigger?.error ?? {};
  const node = error.node?.name ?? execution?.lastNodeExecuted ?? 'unknown node';
  const message = truncate(String(error.message ?? 'no error message'), MESSAGE_LIMIT);

  const lines = ['n8n workflow failed', `Workflow: ${workflowName}`, `Node: ${node}`];
  if (error.description) lines.push(`Detail: ${truncate(String(error.description), 500)}`);
  lines.push(`Error: ${message}`);
  if (execution?.retryOf) lines.push(`Retry of execution: ${execution.retryOf}`);
  lines.push(execution?.url ? `Execution: ${execution.url}` : 'Execution: not started');
  return escapeTelegramHtml(lines.join('\n'));
}

module.exports = { formatErrorAlert };
