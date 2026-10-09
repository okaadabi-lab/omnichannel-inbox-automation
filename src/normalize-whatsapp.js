'use strict';

const { asArray, cleanText, truncate, unixToIso } = require('./text');

const MAX_TEXT_LENGTH = 4000;

function extractText(message) {
  switch (message.type) {
    case 'text':
      return message.text?.body;
    case 'button':
      return message.button?.text;
    case 'interactive':
      return message.interactive?.button_reply?.title ?? message.interactive?.list_reply?.title;
    case 'image':
    case 'video':
    case 'document':
      return message[message.type]?.caption;
    default:
      return undefined;
  }
}

function ignoredReason(message) {
  if (message.type === 'reaction') return 'reaction';
  if (message.type === 'unsupported' || message.errors) return 'unsupported_message';
  return `no_text:${String(message.type)}`;
}

function normalizeMessage(message, value, contactNames) {
  const text = cleanText(extractText(message));
  if (!text) return { ignored: { reason: ignoredReason(message), ref: message.id ?? null } };

  const receivedAt = unixToIso(message.timestamp);
  const phoneNumberId = value.metadata?.phone_number_id;
  if (!message.id || !message.from || !receivedAt || !phoneNumberId) {
    return { ignored: { reason: 'incomplete_message', ref: message.id ?? null } };
  }

  return {
    message: {
      channel: 'whatsapp',
      external_message_id: message.id,
      customer_id: message.from,
      customer_name: contactNames.get(message.from) ?? null,
      text: truncate(text, MAX_TEXT_LENGTH),
      received_at: receivedAt,
      reply_target: { phone_number_id: phoneNumberId, to: message.from },
    },
  };
}

// WhatsApp Cloud API webhook: entry[].changes[].value holds either `messages` (inbound) or
// `statuses` (sent/delivered/read receipts for our own outbound messages).
function normalizeWhatsApp(payload) {
  const result = { messages: [], ignored: [] };

  for (const entry of asArray(payload?.entry)) {
    for (const change of asArray(entry?.changes)) {
      if (change?.field !== 'messages') {
        result.ignored.push({ reason: `unsupported_field:${String(change?.field)}`, ref: null });
        continue;
      }
      const value = change.value ?? {};
      for (const status of asArray(value.statuses)) {
        result.ignored.push({ reason: 'delivery_status', ref: status?.id ?? null });
      }

      const contactNames = new Map(
        asArray(value.contacts).map((contact) => [contact?.wa_id, contact?.profile?.name]),
      );
      for (const message of asArray(value.messages)) {
        const outcome = normalizeMessage(message ?? {}, value, contactNames);
        if (outcome.message) result.messages.push(outcome.message);
        else result.ignored.push(outcome.ignored);
      }
    }
  }

  return result;
}

module.exports = { normalizeWhatsApp };
