'use strict';

const path = require('node:path');
const { bundleCode } = require('./bundle');

const SETTING_PLACEHOLDER = /%%([A-Z0-9_]+)%%/g;
const SQL_REFERENCE = /^@sql:([A-Z0-9_]+)$/;
const CODE_REFERENCE = /^@code:([a-z0-9/-]+\.js)$/;

function mapStrings(value, transform) {
  if (typeof value === 'string') return transform(value);
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, transform));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapStrings(v, transform)]));
  }
  return value;
}

function resolveParameter(value, { settings, sql, nodeName }) {
  const sqlMatch = SQL_REFERENCE.exec(value);
  if (sqlMatch) {
    if (!(sqlMatch[1] in sql)) throw new Error(`${nodeName}: unknown SQL statement ${sqlMatch[1]}`);
    return sql[sqlMatch[1]];
  }
  return value.replace(SETTING_PLACEHOLDER, (_match, key) => {
    if (!(key in settings)) throw new Error(`${nodeName}: unknown setting %%${key}%%`);
    return String(settings[key]);
  });
}

// Turns a template from workflows/src into an importable workflow: settings placeholders and
// SQL references are resolved, and every Code node gets its bundled JavaScript.
function buildWorkflow(template, { settings, sql, rootDir }) {
  const nodes = template.nodes.map((node) => {
    const parameters = mapStrings(node.parameters ?? {}, (value) =>
      resolveParameter(value, { settings, sql, nodeName: node.name }),
    );
    if (node.type === 'n8n-nodes-base.code') {
      const match = CODE_REFERENCE.exec(parameters.jsCode ?? '');
      if (!match) throw new Error(`${node.name}: jsCode must be an @code: reference`);
      const relative = path.posix.join('workflows/code', match[1]);
      parameters.jsCode = bundleCode(path.join(rootDir, relative), {
        srcDir: path.join(rootDir, 'src'),
        settings,
        label: relative,
      });
    }
    return { ...node, parameters };
  });
  return { ...template, nodes };
}

module.exports = { buildWorkflow };
