'use strict';

// Statements used by n8n MySQL "Execute Query" nodes. $1, $2... are the node's query
// parameters. Each placeholder is used once and in ascending order, because n8n binds the
// values in placeholder-number order rather than in the order they appear in the text.
// Statements are kept on one line: n8n strips newlines when it splits multi-statement queries.
const statements = (...lines) => lines.join(' ');

const RESERVE_COMMENT_REPLY_SLOT = [
  statements(
    'INSERT INTO comment_reply_counter (scope_key, window_start, reply_count)',
    'VALUES ($1, $2, 1)',
    'ON DUPLICATE KEY UPDATE reply_count = reply_count + 1',
  ),
  statements(
    'SELECT reply_count FROM comment_reply_counter',
    'WHERE scope_key = $3 AND window_start = $4',
  ),
].join(';\n');

const REGISTER_OUTBOX_EVENT = [
  statements(
    'INSERT INTO outbox_delivery_attempts (event_id, event_type, employee_id)',
    'VALUES ($1, $2, $3)',
    'ON DUPLICATE KEY UPDATE event_id = event_id',
  ),
  statements(
    'SELECT event_id, attempts, status FROM outbox_delivery_attempts',
    'WHERE event_id = $4',
  ),
].join(';\n');

const COUNT_DELIVERY_ATTEMPT = statements(
  'UPDATE outbox_delivery_attempts',
  'SET attempts = attempts + 1, last_attempt_at = UTC_TIMESTAMP(3)',
  'WHERE event_id = $1',
);

module.exports = { RESERVE_COMMENT_REPLY_SLOT, REGISTER_OUTBOX_EVENT, COUNT_DELIVERY_ATTEMPT };
