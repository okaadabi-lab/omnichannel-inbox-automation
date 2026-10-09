'use strict';

const { truncate } = require('./text');

const CHANNEL_LABELS = { whatsapp: 'WhatsApp', instagram: 'Instagram', telegram: 'Telegram' };
const LAST_MESSAGE_LIMIT = 1000;

function formatConfidence(confidence) {
  return typeof confidence === 'number' ? confidence.toFixed(2) : 'n/a';
}

// Plain text on purpose: Telegram Markdown would need every customer-supplied character
// escaped, and a single unescaped "_" makes the whole alert fail to send.
function renderEscalationAlert(message, decision) {
  const customer = message.customer_name
    ? `${message.customer_name} (${message.customer_id})`
    : message.customer_id;
  const reasons = decision.reasons.length > 0 ? decision.reasons.join(', ') : 'none given';

  return [
    'Customer needs a human',
    `Channel: ${CHANNEL_LABELS[message.channel] ?? message.channel}`,
    `Customer: ${customer}`,
    `Intent: ${decision.intent ?? 'unknown'} (confidence ${formatConfidence(decision.confidence)})`,
    `Reasons: ${reasons}`,
    `Conversation: ${decision.conversation_id}`,
    `Received: ${message.received_at}`,
    '',
    'Last message:',
    truncate(message.text, LAST_MESSAGE_LIMIT),
    '',
    `Holding reply sent: ${decision.reply_text}`,
  ].join('\n');
}

module.exports = { renderEscalationAlert };
