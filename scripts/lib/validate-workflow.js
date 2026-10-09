'use strict';

const TRIGGER_TYPES = new Set([
  'n8n-nodes-base.webhook',
  'n8n-nodes-base.scheduleTrigger',
  'n8n-nodes-base.manualTrigger',
  'n8n-nodes-base.errorTrigger',
  'n8n-nodes-base.executeWorkflowTrigger',
]);
const OUTBOUND_TYPES = new Set(['n8n-nodes-base.httpRequest', 'n8n-nodes-base.telegram']);

const SECRET_PATTERNS = [
  { label: 'Meta access token', pattern: /\bEAA[A-Za-z0-9]{20,}/ },
  { label: 'Telegram bot token', pattern: /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/ },
  { label: 'hr-payroll-api key', pattern: /\bhrp_[0-9a-f]{12}_[0-9a-f]{48}\b/ },
  { label: 'literal bearer token', pattern: /Bearer\s+[A-Za-z0-9._~+/-]{16,}/ },
  { label: 'private key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { label: 'password value', pattern: /"password"\s*:\s*"[^"]+"/i },
];
const ASYNC_FUNCTION = Object.getPrototypeOf(async () => {}).constructor;

function targetsOf(connections, nodeName) {
  const outputs = connections[nodeName]?.main ?? [];
  return outputs.flatMap((branch) => (branch ?? []).map((link) => link.node));
}

function reachable(connections, start) {
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length > 0) {
    for (const next of targetsOf(connections, queue.shift())) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
}

function checkStructure(workflow, error) {
  if (typeof workflow.id !== 'string' || workflow.id.length === 0 || workflow.id.length > 21) {
    error('workflow id must be a string of 1-21 chars');
  }
  const names = new Set();
  const ids = new Set();
  for (const node of workflow.nodes) {
    if (names.has(node.name)) error(`duplicate node name "${node.name}"`);
    if (ids.has(node.id)) error(`duplicate node id "${node.id}" (${node.name})`);
    names.add(node.name);
    ids.add(node.id);
  }

  const targets = new Set();
  for (const [source, outputs] of Object.entries(workflow.connections)) {
    if (!names.has(source)) error(`connection from unknown node "${source}"`);
    for (const branch of outputs.main ?? []) {
      for (const link of branch ?? []) {
        if (!names.has(link.node)) error(`"${source}" connects to unknown node "${link.node}"`);
        targets.add(link.node);
      }
    }
  }
  for (const node of workflow.nodes) {
    if (!TRIGGER_TYPES.has(node.type) && !targets.has(node.name)) {
      error(`node "${node.name}" has no incoming connection`);
    }
  }
}

function checkCredentials(workflow, manifest, error) {
  for (const node of workflow.nodes) {
    for (const [type, reference] of Object.entries(node.credentials ?? {})) {
      if (!reference || reference.id !== null || typeof reference.name !== 'string') {
        error(`"${node.name}" must reference credentials by name with "id": null`);
        continue;
      }
      const expected = manifest[reference.name];
      if (!expected) error(`"${node.name}" uses unknown credential "${reference.name}"`);
      else if (expected.type !== type) {
        error(`"${node.name}" uses "${reference.name}" as ${type}, expected ${expected.type}`);
      }
    }
  }
}

function checkOutboundNodes(workflow, error) {
  for (const node of workflow.nodes) {
    if (!OUTBOUND_TYPES.has(node.type)) continue;
    if (node.retryOnFail !== true || !(node.maxTries >= 2) || !(node.waitBetweenTries > 0)) {
      error(`"${node.name}" needs retryOnFail with maxTries >= 2 and waitBetweenTries > 0`);
    }
    if (node.type === 'n8n-nodes-base.httpRequest' && !(node.parameters.options?.timeout > 0)) {
      error(`"${node.name}" needs an explicit timeout`);
    }
    if (
      node.type === 'n8n-nodes-base.telegram' &&
      node.parameters.additionalFields?.appendAttribution !== false
    ) {
      error(`"${node.name}" must disable the n8n attribution footer`);
    }
  }
}

function checkCodeAndQueries(workflow, error) {
  for (const node of workflow.nodes) {
    if (node.type === 'n8n-nodes-base.code') {
      const code = node.parameters.jsCode;
      try {
        new ASYNC_FUNCTION(code);
      } catch (cause) {
        error(`Code node "${node.name}" does not compile: ${cause.message}`);
      }
      if (/\bprocess\.env\b|\$env\b/.test(code)) {
        error(`Code node "${node.name}" reads environment variables`);
      }
      if (/\brequire\(\s*['"](?!\.\/)/.test(code)) {
        error(`Code node "${node.name}" requires a module; Code nodes have none allow-listed`);
      }
    }
    if (node.type === 'n8n-nodes-base.mySql' && node.parameters.operation === 'executeQuery') {
      if (/\{\{/.test(node.parameters.query ?? '')) {
        error(`"${node.name}" builds SQL from an expression; use query parameters`);
      }
    }
  }
}

function checkResponses(workflow, error) {
  for (const node of workflow.nodes) {
    if (node.type !== 'n8n-nodes-base.webhook' || node.parameters.responseMode !== 'responseNode') {
      continue;
    }
    const downstream = reachable(workflow.connections, node.name);
    const responds = workflow.nodes.some(
      (other) => other.type === 'n8n-nodes-base.respondToWebhook' && downstream.has(other.name),
    );
    if (!responds) error(`webhook "${node.name}" never reaches a Respond to Webhook node`);
  }
}

function checkSettings(workflow, { errorWorkflowId }, error) {
  const settings = workflow.settings ?? {};
  if (settings.executionOrder !== 'v1') error('settings.executionOrder must be "v1"');
  const isErrorHandler = workflow.nodes.some((n) => n.type === 'n8n-nodes-base.errorTrigger');
  if (isErrorHandler && settings.errorWorkflow) {
    error('the error handler must not have an error workflow itself');
  }
  if (!isErrorHandler && settings.errorWorkflow !== errorWorkflowId) {
    error(`settings.errorWorkflow must be "${errorWorkflowId}"`);
  }
}

function checkText(workflow, error) {
  const text = JSON.stringify(workflow);
  if (/%%[A-Z0-9_]+%%|"@code:|"@sql:/.test(text)) error('unresolved build placeholder');
  if (/\$env\b/.test(text)) error('uses $env, which n8n 2.x blocks by default');
  for (const { label, pattern } of SECRET_PATTERNS) {
    if (pattern.test(text)) error(`looks like it contains a ${label}`);
  }
}

// Validates a set of built workflows. Returns a list of human-readable problems.
function validateWorkflows(entries, { credentials, errorWorkflowId }) {
  const problems = [];
  const byId = new Map(entries.map(({ workflow }) => [workflow.id, workflow]));
  if (!byId.has(errorWorkflowId)) problems.push(`no workflow has id "${errorWorkflowId}"`);

  for (const { file, workflow } of entries) {
    const error = (message) => problems.push(`${file}: ${message}`);
    if (!Array.isArray(workflow.nodes) || typeof workflow.connections !== 'object') {
      error('missing nodes or connections');
      continue;
    }
    checkStructure(workflow, error);
    checkCredentials(workflow, credentials, error);
    checkOutboundNodes(workflow, error);
    checkCodeAndQueries(workflow, error);
    checkResponses(workflow, error);
    checkSettings(workflow, { errorWorkflowId }, error);
    checkText(workflow, error);

    for (const node of workflow.nodes) {
      if (node.type !== 'n8n-nodes-base.executeWorkflow') continue;
      const target = byId.get(node.parameters.workflowId?.value);
      if (!target) error(`"${node.name}" calls a workflow that is not in this repository`);
      else if (!target.nodes.some((n) => n.type === 'n8n-nodes-base.executeWorkflowTrigger')) {
        error(`"${node.name}" calls "${target.name}", which has no Execute Workflow Trigger`);
      }
    }
  }
  return problems;
}

module.exports = { validateWorkflows };
