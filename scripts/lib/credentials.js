'use strict';

// Every credential the workflows reference, by the name it must have in n8n. Workflow JSON
// only contains these names; scripts/validate.js rejects anything else. What goes into each
// credential is listed in the README.
module.exports = {
  'Meta App Secret': { type: 'crypto' },
  'WhatsApp Cloud API': { type: 'httpBearerAuth' },
  'Instagram API': { type: 'httpBearerAuth' },
  'Telegram Bot': { type: 'telegramApi' },
  'AI Support Service': { type: 'httpBearerAuth' },
  'HR Payroll API': { type: 'httpHeaderAuth' },
  'Inbox MySQL': { type: 'mySql' },
};
