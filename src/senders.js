'use strict';

const { truncate, truncateUtf8, singleLine } = require('./text');

const WHATSAPP_TEXT_LIMIT = 4096;
const INSTAGRAM_TEXT_BYTES = 1000;
const TELEGRAM_TEXT_LIMIT = 4096;
const TEMPLATE_PARAM_LIMIT = 1024;

function requireText(text) {
  if (typeof text !== 'string' || text.trim().length === 0) {
    throw new Error('Outgoing message text must be a non-empty string');
  }
  return text.trim();
}

// WhatsApp Cloud API POST /{phone-number-id}/messages, free-form text. Only allowed inside
// the 24-hour customer service window, which is always the case when replying to a message.
function buildWhatsAppText(to, text) {
  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'text',
    text: { preview_url: false, body: truncate(requireText(text), WHATSAPP_TEXT_LIMIT) },
  };
}

// Business-initiated messages (outside the 24-hour window) must use a template that Meta has
// approved. Template text parameters may not contain newlines, tabs or long runs of spaces.
function buildWhatsAppTemplate(to, template, bodyParameters) {
  if (!template?.name || !template?.language) {
    throw new Error('WhatsApp template needs a name and a language code');
  }
  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'template',
    template: {
      name: template.name,
      language: { code: template.language },
      components: [
        {
          type: 'body',
          parameters: bodyParameters.map((value) => ({
            type: 'text',
            text: truncate(singleLine(requireText(String(value))), TEMPLATE_PARAM_LIMIT),
          })),
        },
      ],
    },
  };
}

// Instagram API with Instagram Login, POST /{ig-id}/messages. Text is limited to 1000 bytes.
function buildInstagramText(recipientId, text) {
  return {
    recipient: { id: recipientId },
    message: { text: truncateUtf8(requireText(text), INSTAGRAM_TEXT_BYTES) },
  };
}

// Private reply: a DM addressed by comment id. Meta allows one per comment, within 7 days.
function buildInstagramPrivateReply(commentId, text) {
  return {
    recipient: { comment_id: commentId },
    message: { text: truncateUtf8(requireText(text), INSTAGRAM_TEXT_BYTES) },
  };
}

// Public reply: POST /{ig-comment-id}/replies.
function buildInstagramPublicReply(text) {
  return { message: truncateUtf8(requireText(text), INSTAGRAM_TEXT_BYTES) };
}

function buildTelegramText(chatId, text) {
  return { chat_id: String(chatId), text: truncate(requireText(text), TELEGRAM_TEXT_LIMIT) };
}

// One channel-neutral description of "send this text back to the customer", consumed by the
// per-channel send nodes. path_id is the id that goes into the Graph API URL.
function buildReply(message, text) {
  const target = message.reply_target;
  switch (message.channel) {
    case 'whatsapp':
      return {
        channel: 'whatsapp',
        path_id: target.phone_number_id,
        body: buildWhatsAppText(target.to, text),
      };
    case 'instagram':
      return {
        channel: 'instagram',
        path_id: target.account_id,
        body: buildInstagramText(target.recipient_id, text),
      };
    case 'telegram':
      return { channel: 'telegram', ...buildTelegramText(target.chat_id, text) };
    default:
      throw new Error(`No sender for channel "${String(message.channel)}"`);
  }
}

module.exports = {
  buildWhatsAppText,
  buildWhatsAppTemplate,
  buildInstagramText,
  buildInstagramPrivateReply,
  buildInstagramPublicReply,
  buildTelegramText,
  buildReply,
};
