'use strict';

const { normalizeWhatsApp } = require('./normalize-whatsapp');
const { normalizeInstagram } = require('./normalize-instagram');

// WhatsApp and Instagram webhooks are both signed with the Meta app secret and can share
// one callback URL; the top-level `object` field says which product sent the payload.
function normalizeMetaPayload(payload) {
  switch (payload?.object) {
    case 'whatsapp_business_account':
      return { ...normalizeWhatsApp(payload), comments: [] };
    case 'instagram':
      return normalizeInstagram(payload);
    default:
      return {
        messages: [],
        comments: [],
        ignored: [{ reason: `unsupported_object:${String(payload?.object)}`, ref: null }],
      };
  }
}

module.exports = { normalizeMetaPayload };
