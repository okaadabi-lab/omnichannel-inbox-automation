'use strict';

const fs = require('node:fs');

const url = (value) =>
  /^https?:\/\/[^\s]+[^/]$/.test(value) || 'must be an http(s) URL without a trailing slash';
const sha256 = (value) => /^[0-9a-f]{64}$/.test(value) || 'must be a lowercase SHA-256 hex digest';
const chatId = (value) => /^-?\d+$/.test(value) || 'must be a numeric Telegram chat id';
const positiveInt = (value) => /^[1-9]\d*$/.test(value) || 'must be a positive integer';

// Non-secret settings that are baked into the workflow JSON at build time. Secrets never go
// here; they live in n8n credentials. `type: 'number'` values are injected as numbers.
const SETTINGS = {
  AI_SUPPORT_BASE_URL: { check: url },
  HR_PAYROLL_BASE_URL: { check: url },
  META_GRAPH_BASE_URL: { check: url },
  INSTAGRAM_GRAPH_BASE_URL: { check: url },
  META_GRAPH_VERSION: { check: (v) => /^v\d+\.\d+$/.test(v) || 'must look like v25.0' },
  WHATSAPP_PHONE_NUMBER_ID: { check: (v) => /^\d+$/.test(v) || 'must be numeric' },
  WHATSAPP_TEMPLATE_LANGUAGE: {
    check: (v) => /^[a-z]{2}(_[A-Z]{2})?$/.test(v) || 'e.g. id or en_US',
  },
  PAYSLIP_TEMPLATE_NAME: { check: (v) => /^[a-z0-9_]+$/.test(v) || 'must be a template name' },
  PAYROLL_PAID_TEMPLATE_NAME: { check: (v) => /^[a-z0-9_]+$/.test(v) || 'must be a template name' },
  OUTBOX_MAX_ATTEMPTS: { check: positiveInt, type: 'number' },
  TELEGRAM_ADMIN_CHAT_ID: { check: chatId },
  TELEGRAM_OPS_CHAT_ID: { check: chatId },
  META_VERIFY_TOKEN_SHA256: { check: sha256 },
  TELEGRAM_WEBHOOK_SECRET_SHA256: { check: sha256 },
  COMMENT_REPLY_CAP_PER_HOUR: { check: positiveInt, type: 'number' },
  PRICE_LIST_URL: { check: url },
};

function parseEnvFile(text) {
  const values = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    values[key] = value;
  }
  return values;
}

// Returns typed settings or throws one error listing every problem.
function loadSettings(envPath) {
  const raw = parseEnvFile(fs.readFileSync(envPath, 'utf8'));
  const problems = [];
  const settings = {};
  for (const [key, spec] of Object.entries(SETTINGS)) {
    const value = raw[key];
    if (value === undefined || value === '') {
      problems.push(`${key} is missing`);
      continue;
    }
    const result = spec.check(value);
    if (result !== true) problems.push(`${key} ${result}`);
    settings[key] = spec.type === 'number' ? Number(value) : value;
  }
  if (problems.length > 0) {
    throw new Error(`Invalid settings in ${envPath}:\n- ${problems.join('\n- ')}`);
  }
  return settings;
}

module.exports = { SETTINGS, parseEnvFile, loadSettings };
