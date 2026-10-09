const { planOutboxDelivery } = require('../../../src/outbox');

const event = $('Collect Events').item.json;
return {
  json: planOutboxDelivery(event, $json, {
    maxAttempts: CONFIG.OUTBOX_MAX_ATTEMPTS,
    templates: {
      payslipPublished: {
        name: CONFIG.PAYSLIP_TEMPLATE_NAME,
        language: CONFIG.WHATSAPP_TEMPLATE_LANGUAGE,
      },
      payrollPaid: {
        name: CONFIG.PAYROLL_PAID_TEMPLATE_NAME,
        language: CONFIG.WHATSAPP_TEMPLATE_LANGUAGE,
      },
    },
  }),
};
