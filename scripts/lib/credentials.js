'use strict';

// Every credential the workflows reference, by the name it must have in n8n. Workflow JSON
// only contains these names; scripts/validate.js rejects anything else.
module.exports = {
  'Meta App Secret': {
    type: 'crypto',
    fields: 'Hmac Secret = the Meta app secret (App settings > Basic)',
  },
  'WhatsApp Cloud API': {
    type: 'httpBearerAuth',
    fields: 'Bearer Token = system user access token with whatsapp_business_messaging',
  },
  'Instagram API': {
    type: 'httpBearerAuth',
    fields:
      'Bearer Token = Instagram user access token with instagram_business_manage_messages and instagram_business_manage_comments',
  },
  'Telegram Bot': {
    type: 'telegramApi',
    fields: 'Access Token = bot token from BotFather',
  },
  'AI Support Service': {
    type: 'httpBearerAuth',
    fields: 'Bearer Token = ai-support-service API key with scope messages:write',
  },
  'HR Payroll API': {
    type: 'httpHeaderAuth',
    fields: 'Name = X-Api-Key, Value = hr-payroll-api key with scope outbox:read',
  },
  'Inbox MySQL': {
    type: 'mySql',
    fields: 'Host, database, user and password of the database that holds sql/schema.sql',
  },
};
