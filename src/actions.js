'use strict';

const { buildReply } = require('./senders');
const { renderEscalationAlert } = require('./escalation');
const { toMysqlDateTime } = require('./text');

const ACTIONS = ['reply', 'escalate', 'none'];
const LOG_STATUS = { reply: 'replied', escalate: 'escalated', none: 'no_action' };

function isStringOrNull(value) {
  return value === null || typeof value === 'string';
}

// Validates the ai-support-service response before anything is sent to a customer.
function assertDecision(decision) {
  if (!decision || typeof decision !== 'object') throw new Error('AI decision is missing');
  if (!ACTIONS.includes(decision.action)) {
    throw new Error(`AI decision has unknown action "${String(decision.action)}"`);
  }
  if (typeof decision.conversation_id !== 'string' || decision.conversation_id.length === 0) {
    throw new Error('AI decision is missing conversation_id');
  }
  if (decision.action !== 'none') {
    if (typeof decision.reply_text !== 'string' || decision.reply_text.trim().length === 0) {
      throw new Error(`AI decision "${decision.action}" has no reply_text`);
    }
  }
  if (!Array.isArray(decision.reasons) || !decision.reasons.every((r) => typeof r === 'string')) {
    throw new Error('AI decision reasons must be an array of strings');
  }
  if (!isStringOrNull(decision.intent ?? null)) throw new Error('AI decision intent is invalid');
  const confidence = decision.confidence ?? null;
  if (confidence !== null && (typeof confidence !== 'number' || confidence < 0 || confidence > 1)) {
    throw new Error('AI decision confidence must be a number between 0 and 1 or null');
  }
  return decision;
}

// Turns one AI decision into everything the workflow does next: what to send to the customer,
// whether to alert the admin group, and the final message_log values.
function planActions(message, decision, { logId, now = new Date() }) {
  assertDecision(decision);
  const action = decision.action;
  const replyText = action === 'none' ? null : decision.reply_text.trim();

  return {
    action,
    channel: message.channel,
    send: replyText ? buildReply(message, replyText) : null,
    admin_alert_text: action === 'escalate' ? renderEscalationAlert(message, decision) : null,
    log: {
      id: logId,
      status: LOG_STATUS[action],
      action,
      intent: decision.intent ?? null,
      confidence: decision.confidence ?? null,
      reasons: JSON.stringify(decision.reasons),
      conversation_id: decision.conversation_id,
      reply_text: replyText,
      processed_at: toMysqlDateTime(now),
    },
  };
}

module.exports = { assertDecision, planActions };
