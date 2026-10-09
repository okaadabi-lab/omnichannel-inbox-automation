'use strict';

const { truncate, toMysqlDateTime } = require('./text');

const CHANNELS = ['whatsapp', 'instagram', 'telegram'];
const MAX_EXTERNAL_ID_LENGTH = 255;
const MAX_CUSTOMER_ID_LENGTH = 128;
const MAX_CUSTOMER_NAME_LENGTH = 120;
const MAX_TEXT_LENGTH = 4000;
const TEXT_PREVIEW_LENGTH = 500;

function requireString(message, field, maxLength) {
  const value = message[field];
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw new Error(`Canonical message field "${field}" must be a string of 1-${maxLength} chars`);
  }
}

// Guards the contract between the normalisers and the rest of the pipeline, so a normaliser
// bug fails here with a clear message instead of as a 400 from the AI service.
function assertCanonicalMessage(message) {
  if (!message || typeof message !== 'object') throw new Error('Canonical message is missing');
  if (!CHANNELS.includes(message.channel)) {
    throw new Error(`Unknown channel "${String(message.channel)}"`);
  }
  requireString(message, 'external_message_id', MAX_EXTERNAL_ID_LENGTH);
  requireString(message, 'customer_id', MAX_CUSTOMER_ID_LENGTH);
  requireString(message, 'text', MAX_TEXT_LENGTH);
  if (Number.isNaN(Date.parse(message.received_at))) {
    throw new Error('Canonical message field "received_at" must be an ISO-8601 timestamp');
  }
  if (message.customer_name !== null && typeof message.customer_name !== 'string') {
    throw new Error('Canonical message field "customer_name" must be a string or null');
  }
  if (!message.reply_target || typeof message.reply_target !== 'object') {
    throw new Error('Canonical message field "reply_target" is required');
  }
  return message;
}

// Request body for ai-support-service POST /v1/messages.
function buildAiRequest(message) {
  assertCanonicalMessage(message);
  const request = {
    channel: message.channel,
    external_message_id: message.external_message_id,
    customer_id: message.customer_id,
    text: message.text,
    received_at: message.received_at,
  };
  const name = message.customer_name ? message.customer_name.trim() : '';
  if (name) request.customer_name = truncate(name, MAX_CUSTOMER_NAME_LENGTH);
  return request;
}

// First write to message_log. The UNIQUE (channel, external_message_id) key turns this
// insert into the de-duplication step for webhook redeliveries.
function buildClaimRow(message) {
  return {
    channel: message.channel,
    external_message_id: message.external_message_id,
    customer_id: message.customer_id,
    customer_name: message.customer_name
      ? truncate(message.customer_name, MAX_CUSTOMER_NAME_LENGTH)
      : null,
    text_preview: truncate(message.text, TEXT_PREVIEW_LENGTH),
    received_at: toMysqlDateTime(message.received_at),
  };
}

module.exports = { CHANNELS, assertCanonicalMessage, buildAiRequest, buildClaimRow };
