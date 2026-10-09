'use strict';

const { buildWhatsAppTemplate } = require('./senders');
const { asArray, truncate, escapeTelegramHtml } = require('./text');

const ACK_BATCH_SIZE = 100;
const PHONE_PATTERN = /^\+?[1-9]\d{7,14}$/;
const PERIOD_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;
const MONTHS_ID = [
  'Januari',
  'Februari',
  'Maret',
  'April',
  'Mei',
  'Juni',
  'Juli',
  'Agustus',
  'September',
  'Oktober',
  'November',
  'Desember',
];
// Statuses after which an event is only acknowledged again, never re-sent.
const FINAL_STATUSES = ['delivered', 'undeliverable', 'gave_up', 'skipped'];

function formatRupiah(amount) {
  return `Rp ${String(amount).replace(/\B(?=(\d{3})+(?!\d))/g, '.')}`;
}

function periodLabel(period) {
  const match = PERIOD_PATTERN.exec(period);
  return `${MONTHS_ID[Number(match[2]) - 1]} ${match[1]}`;
}

// The two event types from hr-payroll-api and how each becomes a WhatsApp template message.
const EVENT_TYPES = {
  'payslip.published': {
    templateKey: 'payslipPublished',
    validate: (p) => typeof p.payslip_url === 'string' && p.payslip_url.length > 0,
    parameters: (p) => [p.employee_name, periodLabel(p.period), p.payslip_url],
  },
  'payroll.paid': {
    templateKey: 'payrollPaid',
    validate: (p) => Number.isInteger(p.net_pay) && p.net_pay >= 0,
    parameters: (p) => [p.employee_name, periodLabel(p.period), formatRupiah(p.net_pay)],
  },
};

// Flattens the pages returned by GET /api/v1/integrations/outbox. Delivery is at least once,
// so the same id can appear twice; the first copy wins.
function collectOutboxEvents(pages) {
  const byId = new Map();
  for (const page of asArray(pages)) {
    if (!page || !Array.isArray(page.data)) {
      throw new Error('Outbox response has no "data" array; the hr-payroll-api contract changed');
    }
    for (const event of page.data) {
      if (!Number.isInteger(event?.id) || event.id < 1) {
        throw new Error(`Outbox event has an invalid id: ${JSON.stringify(event?.id)}`);
      }
      if (!byId.has(event.id)) byId.set(event.id, event);
    }
  }
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

function payloadProblem(event, type) {
  const payload = event.payload;
  if (!payload || typeof payload !== 'object') return 'payload missing';
  if (typeof payload.employee_name !== 'string' || payload.employee_name.trim() === '') {
    return 'employee_name missing';
  }
  if (typeof payload.period !== 'string' || !PERIOD_PATTERN.test(payload.period)) {
    return 'period is not YYYY-MM';
  }
  if (!type.validate(payload)) return `payload incomplete for ${event.type}`;
  if (payload.phone === null || payload.phone === undefined) return 'employee has no phone number';
  if (
    typeof payload.phone !== 'string' ||
    !PHONE_PATTERN.test(payload.phone.replace(/[\s-]/g, ''))
  ) {
    return 'phone number is not a valid international number';
  }
  return null;
}

function renderOpsAlert(event, reason, attempts) {
  const payload = event.payload ?? {};
  const lines = [
    'Payroll notification needs attention',
    `Event: #${event.id} ${event.type}`,
    `Employee: ${payload.employee_name ?? 'unknown'} (id ${payload.employee_id ?? 'unknown'})`,
    `Period: ${payload.period ?? 'unknown'}`,
    `Reason: ${reason}`,
    `Attempts: ${attempts}`,
    'The event has been acknowledged in hr-payroll-api. Please notify the employee manually.',
  ];
  return escapeTelegramHtml(lines.join('\n'));
}

function finalOutcome(event, status, reason, attempts, alert) {
  return {
    event_id: event.id,
    status,
    last_error: reason ? truncate(reason, 500) : null,
    provider_message_id: null,
    ack: true,
    alert_text: alert ? renderOpsAlert(event, reason, attempts) : null,
  };
}

// Decides what to do with one outbox event, given its row in outbox_delivery_attempts:
// - send: deliver a WhatsApp template (send_request), evaluated afterwards
// - finalize: record a terminal status, alert ops if needed, then acknowledge
// - ack_only: already handled in an earlier run whose acknowledgement did not go through
function planOutboxDelivery(event, state, { maxAttempts, templates }) {
  const attempts = Number(state?.attempts ?? 0);
  if (FINAL_STATUSES.includes(state?.status)) {
    return { action: 'ack_only', event_id: event.id, ack: true };
  }

  const type = EVENT_TYPES[event.type];
  if (!type) {
    const reason = `unsupported event type ${String(event.type)}`;
    return { action: 'finalize', ...finalOutcome(event, 'skipped', reason, attempts, false) };
  }

  const problem = payloadProblem(event, type);
  if (problem) {
    return { action: 'finalize', ...finalOutcome(event, 'undeliverable', problem, attempts, true) };
  }
  if (attempts >= maxAttempts) {
    const reason = 'maximum attempts reached';
    return { action: 'finalize', ...finalOutcome(event, 'gave_up', reason, attempts, true) };
  }

  const to = event.payload.phone.replace(/[^\d]/g, '');
  return {
    action: 'send',
    event,
    attempts,
    send_request: buildWhatsAppTemplate(
      to,
      templates[type.templateKey],
      type.parameters(event.payload),
    ),
  };
}

// n8n reports HTTP failures as '500 - "<response body as a JSON string>"'. Graph API bodies
// look like {"error":{"message":...}}, so the provider's own message is pulled out when possible.
function providerMessage(message) {
  const match = /^\d{3} - "(.*)"$/s.exec(message);
  if (!match) return message;
  try {
    const body = JSON.parse(JSON.parse(`"${match[1]}"`));
    return body?.error?.message ?? message;
  } catch {
    return message;
  }
}

function describeSendError(response) {
  const error = response?.error;
  if (!error) return 'provider response has no message id';
  if (typeof error === 'string') return error;
  const status = error.httpCode ?? error.status ?? error.statusCode;
  const message = providerMessage(String(error.message ?? error.description ?? 'request failed'));
  return status ? `HTTP ${status}: ${message}` : message;
}

// Interprets the WhatsApp send result for one planned event. Failures stay unacked so the next
// run retries them, until the attempt that reaches maxAttempts turns into an ops alert.
function evaluateDelivery(plan, response, { maxAttempts }) {
  const attempts = plan.attempts + 1;
  const messageId = response?.messages?.[0]?.id;
  if (typeof messageId === 'string' && messageId.length > 0) {
    return {
      event_id: plan.event.id,
      status: 'delivered',
      last_error: null,
      provider_message_id: messageId,
      ack: true,
      alert_text: null,
    };
  }

  const reason = describeSendError(response);
  if (attempts >= maxAttempts) {
    return finalOutcome(plan.event, 'gave_up', reason, attempts, true);
  }
  return {
    event_id: plan.event.id,
    status: 'failed',
    last_error: truncate(reason, 500),
    provider_message_id: null,
    ack: false,
    alert_text: null,
  };
}

function buildAckBatches(outcomes) {
  const ids = [...new Set(outcomes.filter((o) => o.ack).map((o) => o.event_id))];
  const batches = [];
  for (let i = 0; i < ids.length; i += ACK_BATCH_SIZE) {
    batches.push({ ids: ids.slice(i, i + ACK_BATCH_SIZE) });
  }
  return batches;
}

module.exports = {
  formatRupiah,
  periodLabel,
  collectOutboxEvents,
  planOutboxDelivery,
  evaluateDelivery,
  buildAckBatches,
};
