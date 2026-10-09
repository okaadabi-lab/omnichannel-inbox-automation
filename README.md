# Omnichannel Inbox Automation

n8n workflows that bring WhatsApp, Instagram and Telegram messages into one pipeline: signature-verified webhooks, normalisation, AI triage through an external service, human escalation, retries and logging.

[![CI](https://github.com/okaadabi-lab/omnichannel-inbox-automation/actions/workflows/ci.yml/badge.svg)](https://github.com/okaadabi-lab/omnichannel-inbox-automation/actions/workflows/ci.yml)

> Portfolio project. All data in this repository is fictional sample data.

![inbound-message-router in the n8n editor](docs/images/inbound-message-router.png)

## Overview

A small service business gets customer messages on three channels and payroll notifications to send on a fourth path. The usual n8n setup for this is a canvas full of trigger-to-action chains with untested JavaScript pasted into Code nodes. This repository treats the workflows as software:

- All Code-node logic lives in plain JavaScript modules in `src/` with unit tests. A build script bundles each node's code from `src/` and injects it into the workflow JSON.
- Workflow JSON is generated from templates, checked by a validator and imported unchanged into n8n.
- An end-to-end harness runs the built workflows in a real n8n instance against mock services.

The workflows call two companion portfolio services over HTTP: [ai-support-service](https://github.com/okaadabi-lab/ai-support-service) (decides whether to reply, escalate or stay silent) and [hr-payroll-api](https://github.com/okaadabi-lab/hr-payroll-api) (publishes payroll events through an outbox).

## Workflows

| Workflow                  | Trigger                        | What it does                                                                                                                              |
| ------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `inbound-message-router`  | Webhooks (Meta, Telegram)      | Verifies the request, answers the webhook immediately, normalises messages, asks ai-support-service, replies or escalates, logs to MySQL. |
| `instagram-comment-reply` | Called by the router           | Applies comment rules: price questions get a public and a private reply under an hourly cap; spam and insults are logged and ignored.     |
| `payslip-notifications`   | Every 15 minutes (or manually) | Reads the hr-payroll-api outbox, sends approved WhatsApp templates, acknowledges what was delivered, retries failures, alerts ops.        |
| `error-handler`           | Error Trigger                  | Posts workflow name, node, error and execution link to the ops Telegram group. Set as the error workflow of the other three.              |

Every normaliser returns the same canonical message (`channel`, `external_message_id`, `customer_id`, `customer_name`, `text`, `received_at`, `reply_target`), which is all the rest of the pipeline knows about a channel. Statuses, reactions, echoes of our own messages, edits and media without text are dropped before the AI call. Field details, the comment rules and the payroll delivery states are in [docs/workflows.md](docs/workflows.md).

## Tech stack

n8n 2.x, JavaScript (CommonJS modules bundled into Code nodes), MySQL 8 / MariaDB 10.11, Node.js 22+ for the build, validator and tests (`node:test`), ESLint and Prettier, Docker Compose for the local stack.

## Architecture

The main workflow, `inbound-message-router`:

```mermaid
flowchart LR
  MG["GET /inbox/meta"] --> VT["hash verify token"] --> VC{"token ok?"}
  VC -- yes --> CH["200 hub.challenge"]
  VC -- no --> R403["403"]

  MP["POST /inbox/meta (raw body)"] --> HM["HMAC-SHA256 with app secret"] --> SC{"X-Hub-Signature-256 ok?"}
  SC -- no --> R401a["401"]
  SC -- yes --> ACK["200 EVENT_RECEIVED"]
  ACK --> NM["normalise WhatsApp / Instagram"]
  ACK --> CM["extract comments"] --> SUB["instagram-comment-reply"]

  TP["POST /inbox/telegram"] --> TS{"secret_token ok?"}
  TS -- no --> R401b["401"]
  TS -- yes --> ACK2["200"] --> NT["normalise Telegram"]

  NM --> LOOP["one message at a time"]
  NT --> LOOP
  LOOP --> CLAIM["claim in message_log"] --> DUP{"first delivery?"}
  DUP -- no --> LOOP
  DUP -- yes --> AI["POST /v1/messages"] --> ACT{"action"}
  ACT -- reply --> SEND["send via channel API"]
  ACT -- escalate --> ADM["alert admin Telegram group"] --> SEND
  ACT -- none --> LOG["update message_log"]
  SEND --> LOG --> LOOP
```

Meta retries any webhook that does not get a quick 200, for days. The router therefore answers as soon as the signature is verified and does the slow part afterwards: the AI call can take tens of seconds when the service has to retry its LLM. Failures after the 200 are handled by retries inside n8n and by the error workflow.

## Failure handling

The most common cases:

| What happens                                    | Behaviour                                                                                                                                                        |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bad or missing Meta signature                   | `401`, nothing is processed or stored. The HMAC covers the raw request bytes. A wrong Telegram `secret_token` also gets `401`.                                   |
| Duplicate webhook (Meta or Telegram redelivers) | Answered `200`; the unique `(channel, external_message_id)` key in `message_log` skips it before the AI call.                                                    |
| ai-support-service down or slow                 | 100 s timeout, 3 tries with the same `external_message_id` (safe because the service is idempotent), then the error workflow alerts ops with the execution link. |
| hr-payroll-api down                             | The run fails and ops is alerted. Nothing is acknowledged, so nothing is lost.                                                                                   |

Channel API errors, acknowledgement failures, undeliverable payslips, MySQL outages and the comment reply cap are covered in [docs/workflows.md](docs/workflows.md#failure-handling).

## Getting started

Requirements: Node.js 22+ for building and testing; n8n 2.x (the Docker image in `docker-compose.yml`, or n8n on Node.js 24); MySQL 8 or MariaDB 10.11.

```bash
npm ci
cp .env.example .env              # set URLs, chat ids and token hashes
node scripts/build.js --env .env --out workflows/local
npm run validate -- --dir workflows/local
```

`workflows/dist` is built from `.env.example` and committed, so the JSON can be read and imported as is; CI fails if it is out of date with the templates. `workflows/local` (gitignored) is the build for your own instance.

### Run with Docker

```bash
docker compose up -d              # n8n on http://localhost:5678, MySQL with sql/schema.sql applied
```

Create the seven credentials listed in [docs/setup.md](docs/setup.md) in the n8n editor first, then import and publish:

```bash
docker compose exec n8n n8n import:workflow --separate --input=/opt/workflows/local
for id in oiaErrorHandler oiaCommentReply oiaInboundRouter oiaPayslipNotify; do
  docker compose exec n8n n8n publish:workflow --id=$id
done
docker compose restart n8n
```

Credentials are referenced by name only, and the import links each node to the existing credential with that name and type. The sub-workflow and the error handler must be published, or the router cannot call them. [docs/setup.md](docs/setup.md) also covers the `.env` settings, the n8n environment and registering the Meta and Telegram webhooks.

## Tests

```bash
npm run lint
npm run build:check && npm run validate
TEST_MYSQL_URL=mysql://user:pass@127.0.0.1:3306/inbox_automation_test npm test
```

`npm test` runs 89 tests with `node:test`: normalisers against fixtures shaped like the official channel payloads, signature checks, decision mapping, comment rules, outbox planning, the validator against deliberately broken workflows, and the built Code nodes executed outside n8n. With `TEST_MYSQL_URL` set it also runs the workflow SQL against a real database; without it those tests are skipped. An optional end-to-end harness (`npm run e2e`, not in CI) runs the built workflows in a throwaway n8n against mock services; see [docs/testing.md](docs/testing.md).

## Repository layout

```
src/                 pure functions used by the Code nodes (no Node.js built-ins)
workflows/src/       workflow templates with settings placeholders and code references
workflows/code/      per-node glue: read n8n inputs, call src/, return items
workflows/dist/      built workflows (from .env.example), importable as is
scripts/             build, validate and the optional e2e harness
sql/schema.sql       message_log, comment_reply_counter, outbox_delivery_attempts
test/                unit, SQL and built-code tests with fixture payloads
```

## Design decisions

- **Answer the webhook first.** The 200 goes back from the same execution with a Respond to Webhook node as soon as the request is verified, so Meta does not redeliver while the AI call runs, and there is no second workflow or queue to operate. The end-to-end test checks that Meta is answered in under 2 s while the AI mock takes 4 s.
- **Code in `src/`, built into the nodes.** A Code node in the template only says `@code:inbound-message-router/plan-actions.js`. The build bundles that glue file with the `src/` modules it requires into one self-contained script. Logic gets real tests and code review; n8n still shows readable code in each node.
- **Settings at build time, not `$env`.** n8n 2.x blocks `$env` in nodes by default, and turning it on exposes every variable of the n8n process, including `N8N_ENCRYPTION_KEY`, to anyone who can edit a workflow. Baking non-secret settings into the JSON avoids that. The cost: changing a URL means rebuilding and re-importing.
- **Secrets stay in credentials.** The Meta app secret is only used by the Crypto node's HMAC. The verify token and the Telegram secret are compared as SHA-256 hashes, so the workflow JSON holds hashes, never tokens. Comparisons run in constant time in plain JavaScript because Code nodes cannot load `crypto` by default.
- **One message per loop iteration.** When an n8n node retries, it re-runs for all its input items. With several messages in one webhook, a failed second reply would resend the first. The Loop Over Items node keeps every send, and every retry, to a single message.
- **De-duplication in MySQL.** The unique key on `message_log` is visible, queryable and survives an n8n reset, unlike n8n's internal de-duplication store.

Two n8n-specific rules (how the MySQL node binds parameters, and why Telegram messages use HTML parse mode) are in [docs/workflows.md](docs/workflows.md#implementation-notes).

## Limitations and future work

- Media messages without a caption are dropped instead of being passed to a human.
- Handing a conversation back to the bot (`POST /v1/conversations/:id/handoff`) is left to the agent; there is no agent inbox here.
- A failure stops the remaining messages of the same webhook delivery. They are not lost (the execution can be retried), but they wait.
- Rows that stay `processing` after a failure are found by query; a sweeper workflow that reports them daily would be the next step.
- Payroll sends are at least once: if n8n crashes during a run, the messages that run already sent are sent again once their claims expire.
- `comment_reply_counter` rows are never pruned.
- The compose file runs the n8n task runner in internal mode, which n8n 2.x marks as deprecated in favour of a separate runner container.

## Part of a portfolio

This repository is the integration point of the set. It calls [ai-support-service](https://github.com/okaadabi-lab/ai-support-service) for every inbound customer message and polls the payroll outbox of [hr-payroll-api](https://github.com/okaadabi-lab/hr-payroll-api) to send payslip notifications.

## License

MIT
