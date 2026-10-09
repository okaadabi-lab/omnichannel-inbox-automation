# Tests

Commands are in the [README](../README.md#tests).

## Unit and SQL tests

`npm test` runs 89 tests with `node:test`: normalisers against fixtures shaped like the official WhatsApp Cloud API, Instagram and Telegram Bot API payloads, signature checks, decision mapping, comment rules, outbox planning, the validator against deliberately broken workflows, and the built Code nodes executed outside n8n with stand-in globals. With `TEST_MYSQL_URL` set it also applies the schema and runs the workflow SQL against a real database (MariaDB 10.11 in CI); without it those tests are skipped.

## End-to-end (optional, not in CI)

`scripts/e2e.js` builds the workflows against local mock servers for ai-support-service, the WhatsApp and Instagram APIs, the Telegram Bot API and hr-payroll-api, imports and publishes them into a throwaway n8n (SQLite, temporary user folder), and checks what each mock received and what ended up in MySQL: the verify-token handshake; signed, wrongly signed and unsigned Meta requests; Meta answered in under 2 s while the AI call takes 4 s; duplicate deliveries and status callbacks; escalation with customer text that Telegram would reject unescaped; Telegram with and without the secret token; an Instagram DM; comment rules and the hourly cap; AI retries ending in the error workflow alert; and two payroll runs (acknowledgements, retry, give-up, an event claimed by another run, nothing sent twice).

```bash
N8N_BIN=/path/to/node_modules/.bin/n8n \
E2E_MYSQL_URL=mysql://user:pass@127.0.0.1:3306/inbox_automation_e2e \
npm run e2e
```

Verified with **n8n 2.42.5** on Node.js 24.21.0 and MariaDB 10.11.
