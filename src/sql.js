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

// Two runs of the payroll workflow can overlap when one is slow. Only the run whose UPDATE
// changes the row sends the message. A row stays 'sending' until its run saves the outcome;
// after two hours (much longer than a run can take) it is treated as a crashed run.
const CLAIM_DELIVERY_ATTEMPT = statements(
  'UPDATE outbox_delivery_attempts',
  "SET attempts = attempts + 1, status = 'sending', last_attempt_at = UTC_TIMESTAMP(3)",
  "WHERE event_id = $1 AND (status IN ('pending', 'failed')",
  "OR (status = 'sending' AND last_attempt_at < UTC_TIMESTAMP(3) - INTERVAL 2 HOUR))",
);

module.exports = { RESERVE_COMMENT_REPLY_SLOT, REGISTER_OUTBOX_EVENT, CLAIM_DELIVERY_ATTEMPT };
