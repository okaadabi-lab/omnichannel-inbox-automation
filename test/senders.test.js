'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildWhatsAppTemplate,
  buildInstagramPrivateReply,
  buildInstagramPublicReply,
  buildReply,
} = require('../src/senders');

test('WhatsApp template payload carries name, language and body parameters', () => {
  const payload = buildWhatsAppTemplate('62812000002', { name: 'payslip_ready', language: 'id' }, [
    'Budi Santoso',
    'Agustus 2026',
    'http://localhost:8082/api/v1/payslips/2',
  ]);
  assert.deepEqual(payload, {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: '62812000002',
    type: 'template',
    template: {
      name: 'payslip_ready',
      language: { code: 'id' },
      components: [
        {
          type: 'body',
          parameters: [
            { type: 'text', text: 'Budi Santoso' },
            { type: 'text', text: 'Agustus 2026' },
            { type: 'text', text: 'http://localhost:8082/api/v1/payslips/2' },
          ],
        },
      ],
    },
  });
});

test('template parameters are flattened to one line, as Meta requires', () => {
  const payload = buildWhatsAppTemplate('62812000002', { name: 't', language: 'id' }, [
    'Budi\n\tSantoso     Jr',
  ]);
  assert.equal(payload.template.components[0].parameters[0].text, 'Budi Santoso Jr');
});

test('template without a name or with an empty parameter is refused', () => {
  assert.throws(() => buildWhatsAppTemplate('1', { language: 'id' }, []), /name/);
  assert.throws(() => buildWhatsAppTemplate('1', { name: 't', language: 'id' }, ['']), /non-empty/);
});

test('Instagram comment replies address the comment', () => {
  assert.deepEqual(buildInstagramPrivateReply('18100000000000001', 'Halo kak'), {
    recipient: { comment_id: '18100000000000001' },
    message: { text: 'Halo kak' },
  });
  assert.deepEqual(buildInstagramPublicReply('Cek DM ya'), { message: 'Cek DM ya' });
});

test('buildReply refuses channels it cannot send to', () => {
  assert.throws(
    () => buildReply({ channel: 'tiktok', reply_target: {} }, 'halo'),
    /No sender for channel "tiktok"/,
  );
});
