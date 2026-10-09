'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  formatRupiah,
  periodLabel,
  collectOutboxEvents,
  planOutboxDelivery,
  evaluateDelivery,
  buildAckBatches,
} = require('../src/outbox');
const { loadFixture } = require('./helpers/fixtures');

const options = {
  maxAttempts: 5,
  templates: {
    payslipPublished: { name: 'payslip_ready', language: 'id' },
    payrollPaid: { name: 'salary_paid', language: 'id' },
  },
};
const page = loadFixture('outbox-page.json');
const [payslipEvent, paidEventWithoutPhone] = page.data;
const fresh = { attempts: 0, status: 'pending' };

test('formats rupiah amounts and Indonesian period labels', () => {
  assert.equal(formatRupiah(9275318), 'Rp 9.275.318');
  assert.equal(formatRupiah(500), 'Rp 500');
  assert.equal(periodLabel('2026-08'), 'Agustus 2026');
});

test('collects events from all pages, de-duplicated by id and sorted', () => {
  const secondPage = { data: [page.data[1], { ...page.data[0], id: 40 }], meta: {} };
  assert.deepEqual(
    collectOutboxEvents([page, secondPage]).map((event) => event.id),
    [40, 41, 42],
  );
});

test('refuses a page that does not follow the outbox contract', () => {
  assert.throws(() => collectOutboxEvents([{ items: [] }]), /contract changed/);
  assert.throws(() => collectOutboxEvents([{ data: [{ id: '41' }] }]), /invalid id/);
});

test('payslip.published becomes an approved-template WhatsApp message', () => {
  const plan = planOutboxDelivery(payslipEvent, fresh, options);
  assert.equal(plan.action, 'send');
  assert.equal(plan.attempts, 0);
  assert.equal(plan.send_request.to, '62812000002');
  assert.equal(plan.send_request.template.name, 'payslip_ready');
  assert.deepEqual(
    plan.send_request.template.components[0].parameters.map((p) => p.text),
    ['Budi Santoso', 'Agustus 2026', 'http://localhost:8082/api/v1/payslips/2'],
  );
});

test('payroll.paid uses the salary template with the formatted amount', () => {
  const event = {
    ...paidEventWithoutPhone,
    payload: { ...paidEventWithoutPhone.payload, phone: '+62 812-000-003' },
  };
  const plan = planOutboxDelivery(event, fresh, options);
  assert.equal(plan.send_request.to, '62812000003');
  assert.equal(plan.send_request.template.name, 'salary_paid');
  assert.deepEqual(
    plan.send_request.template.components[0].parameters.map((p) => p.text),
    ['Citra Lestari', 'Agustus 2026', 'Rp 7.150.000'],
  );
});

test('an employee without a phone is undeliverable: alert ops and acknowledge', () => {
  const plan = planOutboxDelivery(paidEventWithoutPhone, fresh, options);
  assert.equal(plan.action, 'finalize');
  assert.equal(plan.status, 'undeliverable');
  assert.equal(plan.ack, true);
  assert.equal(plan.last_error, 'employee has no phone number');
  assert.match(plan.alert_text, /Event: #42 payroll\.paid/);
  assert.match(plan.alert_text, /Employee: Citra Lestari \(id 3\)/);
});

test('invalid payloads and phone numbers are undeliverable too', () => {
  const badPeriod = { ...payslipEvent, payload: { ...payslipEvent.payload, period: '08-2026' } };
  assert.equal(planOutboxDelivery(badPeriod, fresh, options).last_error, 'period is not YYYY-MM');

  const badPhone = { ...payslipEvent, payload: { ...payslipEvent.payload, phone: '0812' } };
  assert.match(planOutboxDelivery(badPhone, fresh, options).last_error, /not a valid/);

  const noUrl = { ...payslipEvent, payload: { ...payslipEvent.payload, payslip_url: '' } };
  assert.match(planOutboxDelivery(noUrl, fresh, options).last_error, /payload incomplete/);
});

test('unknown event types are skipped quietly and acknowledged', () => {
  const plan = planOutboxDelivery({ ...payslipEvent, type: 'employee.created' }, fresh, options);
  assert.equal(plan.action, 'finalize');
  assert.equal(plan.status, 'skipped');
  assert.equal(plan.ack, true);
  assert.equal(plan.alert_text, null);
});

test('events already handled in an earlier run are only acknowledged again', () => {
  for (const status of ['delivered', 'undeliverable', 'gave_up', 'skipped']) {
    assert.deepEqual(planOutboxDelivery(payslipEvent, { attempts: 1, status }, options), {
      action: 'ack_only',
      event_id: 41,
      ack: true,
    });
  }
});

test('an event that already used every attempt is given up without another send', () => {
  const plan = planOutboxDelivery(payslipEvent, { attempts: 5, status: 'failed' }, options);
  assert.equal(plan.action, 'finalize');
  assert.equal(plan.status, 'gave_up');
  assert.match(plan.alert_text, /Attempts: 5/);
});

test('a WhatsApp message id means delivered and acknowledged', () => {
  const plan = planOutboxDelivery(payslipEvent, fresh, options);
  const outcome = evaluateDelivery(
    plan,
    { messaging_product: 'whatsapp', messages: [{ id: 'wamid.SENT0001' }] },
    options,
  );
  assert.deepEqual(outcome, {
    event_id: 41,
    status: 'delivered',
    last_error: null,
    provider_message_id: 'wamid.SENT0001',
    ack: true,
    alert_text: null,
  });
});

test('a failed send stays unacknowledged until the last attempt', () => {
  const failure = { error: { message: 'Too Many Requests', httpCode: '429' } };

  const early = evaluateDelivery(
    planOutboxDelivery(payslipEvent, { attempts: 3, status: 'failed' }, options),
    failure,
    options,
  );
  assert.equal(early.status, 'failed');
  assert.equal(early.ack, false);
  assert.equal(early.last_error, 'HTTP 429: Too Many Requests');

  const last = evaluateDelivery(
    planOutboxDelivery(payslipEvent, { attempts: 4, status: 'failed' }, options),
    failure,
    options,
  );
  assert.equal(last.status, 'gave_up');
  assert.equal(last.ack, true);
  assert.match(last.alert_text, /Reason: HTTP 429: Too Many Requests/);
  assert.match(last.alert_text, /Attempts: 5/);
});

test('the Graph API error message is extracted from the n8n HTTP error', () => {
  const outcome = evaluateDelivery(
    planOutboxDelivery(payslipEvent, fresh, options),
    {
      error: {
        httpCode: '500',
        message:
          '500 - "{\\"error\\":{\\"message\\":\\"Service temporarily unavailable\\",\\"code\\":2}}"',
      },
    },
    options,
  );
  assert.equal(outcome.last_error, 'HTTP 500: Service temporarily unavailable');
});

test('acknowledgements are batched in groups of at most 100 unique ids', () => {
  const outcomes = [];
  for (let id = 1; id <= 230; id += 1) outcomes.push({ event_id: id, ack: id % 10 !== 0 });
  outcomes.push({ event_id: 1, ack: true });

  const batches = buildAckBatches(outcomes);
  assert.deepEqual(
    batches.map((batch) => batch.ids.length),
    [100, 100, 7],
  );
  assert.equal(batches.flatMap((batch) => batch.ids).includes(10), false);
  assert.deepEqual(buildAckBatches([{ event_id: 3, ack: false }]), []);
});
