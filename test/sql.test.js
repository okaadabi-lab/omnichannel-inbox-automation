'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const sql = require('../src/sql');

const DATABASE_URL = process.env.TEST_MYSQL_URL;
const schema = fs.readFileSync(path.join(__dirname, '..', 'sql', 'schema.sql'), 'utf8');

// n8n's MySQL node replaces $1, $2... with ? and binds values by placeholder number.
function bindLikeN8n(query, values) {
  return { sql: query.replace(/\$(\d+)/g, '?'), values };
}

test('every placeholder is used once and in ascending order', () => {
  for (const [name, query] of Object.entries(sql)) {
    const numbers = [...query.matchAll(/\$(\d+)/g)].map((match) => Number(match[1]));
    assert.deepEqual(
      numbers,
      numbers.map((_, index) => index + 1),
      name,
    );
    assert.doesNotMatch(query, /[^;]\n/, `${name} must keep each statement on one line`);
  }
});

test(
  'database behaviour',
  { skip: DATABASE_URL ? false : 'TEST_MYSQL_URL is not set' },
  async (t) => {
    const mysql = require('mysql2/promise');
    const db = await mysql.createConnection({ uri: DATABASE_URL, multipleStatements: true });
    t.after(() => db.end());

    await db.query(
      'DROP TABLE IF EXISTS message_log, comment_reply_counter, outbox_delivery_attempts',
    );
    await db.query(schema);
    await db.query(schema);

    const run = async (query, values) => {
      const bound = bindLikeN8n(query, values);
      const [results] = await db.query(bound.sql, bound.values);
      return results;
    };

    await t.test('the claim insert lets each message through exactly once', async () => {
      const claim =
        'INSERT IGNORE INTO message_log (channel, external_message_id, customer_id, text_preview, received_at) VALUES (?, ?, ?, ?, ?)';
      const row = ['whatsapp', 'wamid.TEST1', '6281200000001', 'halo', '2026-10-09 10:00:00.000'];

      const [first] = await db.query(claim, row);
      const [second] = await db.query(claim, row);
      const [otherChannel] = await db.query(claim, ['telegram', ...row.slice(1)]);

      assert.equal(first.affectedRows, 1);
      assert.ok(first.insertId > 0);
      assert.equal(second.affectedRows, 0);
      assert.equal(otherChannel.affectedRows, 1);
    });

    await t.test('message_log constraints reject bad data', async () => {
      await assert.rejects(
        db.query(
          "INSERT INTO message_log (channel, external_message_id, customer_id, text_preview, received_at, confidence) VALUES ('whatsapp', 'wamid.TEST2', 'c', 't', NOW(), 1.5)",
        ),
        /constraint|Out of range/i,
      );
      await assert.rejects(
        db.query(
          "INSERT INTO message_log (channel, external_message_id, customer_id, text_preview, received_at, reasons) VALUES ('whatsapp', 'wamid.TEST3', 'c', 't', NOW(), 'not json')",
        ),
        /constraint|Invalid JSON/i,
      );
      await assert.rejects(
        db.query(
          "INSERT INTO message_log (channel, external_message_id, customer_id, text_preview, received_at, status) VALUES ('whatsapp', 'wamid.TEST4', 'c', 't', NOW(), 'lost')",
        ),
        /status/i,
      );
    });

    await t.test('the reply counter increments atomically per account and hour', async () => {
      const scope = 'instagram:17841400000000001';
      const hour = '2026-10-09 10:00:00';
      const reserve = (scopeKey, window) =>
        run(sql.RESERVE_COMMENT_REPLY_SLOT, [scopeKey, window, scopeKey, window]);

      const counts = [];
      for (let i = 0; i < 3; i += 1) {
        const [, rows] = await reserve(scope, hour);
        counts.push(rows[0].reply_count);
      }
      const [, nextHour] = await reserve(scope, '2026-10-09 11:00:00');
      const [, otherAccount] = await reserve('instagram:17841400000000002', hour);

      assert.deepEqual(counts, [1, 2, 3]);
      assert.equal(nextHour[0].reply_count, 1);
      assert.equal(otherAccount[0].reply_count, 1);
    });

    await t.test('outbox events are registered once and keep their attempt count', async () => {
      const register = (id) => run(sql.REGISTER_OUTBOX_EVENT, [id, 'payslip.published', 2, id]);

      const [, first] = await register(41);
      assert.deepEqual(first, [{ event_id: 41, attempts: 0, status: 'pending' }]);

      await run(sql.COUNT_DELIVERY_ATTEMPT, [41]);
      await run(sql.COUNT_DELIVERY_ATTEMPT, [41]);
      await db.query("UPDATE outbox_delivery_attempts SET status = 'failed' WHERE event_id = 41");

      const [, again] = await register(41);
      assert.deepEqual(again, [{ event_id: 41, attempts: 2, status: 'failed' }]);

      const [[row]] = await db.query(
        'SELECT last_attempt_at FROM outbox_delivery_attempts WHERE event_id = 41',
      );
      assert.ok(row.last_attempt_at instanceof Date);
    });
  },
);
