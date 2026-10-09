'use strict';

const { cleanText, truncate, unixToIso } = require('./text');

const MAX_TEXT_LENGTH = 4000;
const UNSUPPORTED_UPDATES = [
  'edited_message',
  'channel_post',
  'edited_channel_post',
  'callback_query',
  'my_chat_member',
  'chat_member',
];

function updateIgnoreReason(update) {
  if (update.edited_message) return 'edit';
  const kind = UNSUPPORTED_UPDATES.find((key) => update[key]);
  if (kind) return `unsupported_update:${kind}`;
  if (!update.message) return 'unsupported_update';
  if (update.message.from?.is_bot) return 'from_bot';
  // The bot is also a member of the admin alert group; only private chats are customers.
  if (update.message.chat?.type !== 'private') return 'non_private_chat';
  return null;
}

function displayName(user) {
  const name = [user?.first_name, user?.last_name].filter(Boolean).join(' ').trim();
  return name || user?.username || null;
}

// Telegram Bot API Update. message_id is only unique within a chat, so the external id
// combines chat id and message id.
function normalizeTelegram(update) {
  const result = { messages: [], ignored: [] };
  const safeUpdate = update ?? {};
  const ref = safeUpdate.update_id ?? null;

  const reason = updateIgnoreReason(safeUpdate);
  if (reason) {
    result.ignored.push({ reason, ref });
    return result;
  }

  const message = safeUpdate.message;
  const text = cleanText(message.text ?? message.caption);
  if (!text) {
    result.ignored.push({ reason: 'no_text', ref });
    return result;
  }

  const chatId = message.chat?.id;
  const receivedAt = unixToIso(message.date);
  if (chatId === undefined || message.message_id === undefined || !receivedAt) {
    result.ignored.push({ reason: 'incomplete_message', ref });
    return result;
  }

  result.messages.push({
    channel: 'telegram',
    external_message_id: `${chatId}:${message.message_id}`,
    customer_id: String(chatId),
    customer_name: displayName(message.from),
    text: truncate(text, MAX_TEXT_LENGTH),
    received_at: receivedAt,
    reply_target: { chat_id: String(chatId) },
  });
  return result;
}

module.exports = { normalizeTelegram };
