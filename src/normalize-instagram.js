'use strict';

const { asArray, cleanText, truncate, unixToIso } = require('./text');

const MAX_TEXT_LENGTH = 4000;

function messagingIgnoreReason(event, accountId) {
  if (event.reaction) return 'reaction';
  if (event.read) return 'read_receipt';
  if (event.message_edit) return 'edit';
  if (event.postback) return 'postback';
  if (!event.message) return 'unsupported_event';
  if (event.message.is_echo) return 'echo';
  if (event.message.is_deleted) return 'deleted';
  if (event.message.is_unsupported) return 'unsupported_message';
  if (event.sender?.id === accountId) return 'own_message';
  return null;
}

function normalizeMessagingEvent(event, accountId) {
  const reason = messagingIgnoreReason(event, accountId);
  const ref = event.message?.mid ?? event.message_edit?.mid ?? event.reaction?.mid ?? null;
  if (reason) return { ignored: { reason, ref } };

  const text = cleanText(event.message.text);
  if (!text) return { ignored: { reason: 'no_text:attachment', ref } };

  const receivedAt = unixToIso(event.timestamp);
  const senderId = event.sender?.id;
  if (!event.message.mid || !senderId || !receivedAt) {
    return { ignored: { reason: 'incomplete_message', ref } };
  }

  return {
    message: {
      channel: 'instagram',
      external_message_id: event.message.mid,
      customer_id: senderId,
      customer_name: null,
      text: truncate(text, MAX_TEXT_LENGTH),
      received_at: receivedAt,
      reply_target: { account_id: accountId, recipient_id: senderId },
    },
  };
}

function normalizeCommentChange(change, accountId, entryTime) {
  const value = change.value ?? {};
  const ref = value.id ?? null;
  if (value.from?.id === accountId) return { ignored: { reason: 'own_comment', ref } };

  const text = cleanText(value.text);
  if (!value.id || !value.from?.id || !text) {
    return { ignored: { reason: 'incomplete_comment', ref } };
  }

  return {
    comment: {
      comment_id: value.id,
      parent_id: value.parent_id ?? null,
      media_id: value.media?.id ?? null,
      account_id: accountId,
      from_id: value.from.id,
      username: value.from.username ?? null,
      text: truncate(text, MAX_TEXT_LENGTH),
      received_at: unixToIso(entryTime) ?? new Date().toISOString(),
    },
  };
}

// Instagram webhooks deliver direct messages in entry[].messaging[] and comments in
// entry[].changes[] (field "comments"), both to the same callback URL.
function normalizeInstagram(payload) {
  const result = { messages: [], comments: [], ignored: [] };

  for (const entry of asArray(payload?.entry)) {
    const accountId = entry?.id;
    for (const event of asArray(entry?.messaging)) {
      const outcome = normalizeMessagingEvent(event ?? {}, accountId);
      if (outcome.message) result.messages.push(outcome.message);
      else result.ignored.push(outcome.ignored);
    }
    for (const change of asArray(entry?.changes)) {
      if (change?.field !== 'comments') {
        result.ignored.push({ reason: `unsupported_field:${String(change?.field)}`, ref: null });
        continue;
      }
      const outcome = normalizeCommentChange(change, accountId, entry.time);
      if (outcome.comment) result.comments.push(outcome.comment);
      else result.ignored.push(outcome.ignored);
    }
  }

  return result;
}

module.exports = { normalizeInstagram };
