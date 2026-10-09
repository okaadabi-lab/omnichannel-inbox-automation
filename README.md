# omnichannel-inbox-automation

n8n workflows that bring WhatsApp, Instagram and Telegram messages into one pipeline: signature-verified webhooks, normalisation, AI triage through an external service, human escalation, retries and logging.

Portfolio project. All data in this repository is fictional sample data.

## Overview

A small service business gets customer messages on three channels and payroll notifications to send on a fourth path. The usual n8n setup for this is a canvas full of trigger-to-action chains with untested JavaScript pasted into Code nodes. This repository treats the workflows as software:

- All Code-node logic lives in plain JavaScript modules in `src/` with unit tests. A build script bundles each node's code from `src/` and injects it into the workflow JSON.
- Workflow JSON is generated from templates, checked by a validator and imported unchanged into n8n.
- An end-to-end harness runs the built workflows in a real n8n instance against mock services.

The workflows call two companion portfolio services over HTTP: ai-support-service (decides whether to reply, escalate or stay silent) and hr-payroll-api (publishes payroll events through an outbox).

![inbound-message-router in the n8n editor](docs/images/inbound-message-router.png)

## Workflows

| Workflow                  | Trigger                        | What it does                                                                                                                              |
| ------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `inbound-message-router`  | Webhooks (Meta, Telegram)      | Verifies the request, answers the webhook immediately, normalises messages, asks ai-support-service, replies or escalates, logs to MySQL. |
| `instagram-comment-reply` | Called by the router           | Applies comment rules: price questions get a public and a private reply under an hourly cap; spam and insults are logged and ignored.     |
| `payslip-notifications`   | Every 15 minutes (or manually) | Reads the hr-payroll-api outbox, sends approved WhatsApp templates, acknowledges what was delivered, retries failures, alerts ops.        |
| `error-handler`           | Error Trigger                  | Posts workflow name, node, error and execution link to the ops Telegram group. Set as the error workflow of the other three.              |

### inbound-message-router

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

Meta retries any webhook that does not get a quick 200, for days. The router therefore answers as soon as the signature is verified (a few milliseconds of work) and does the slow part afterwards: the AI call can take tens of seconds when the service has to retry its LLM. The end-to-end test checks this with an AI mock that takes 4 seconds; Meta's request still returns in well under a second. The cost of answering first is that Meta can no longer help with recovery, so failures after the 200 are handled by retries inside n8n and by the error workflow (see [Failure handling](#failure-handling)).

The webhook is answered from the same execution with a Respond to Webhook node, so there is no second workflow or queue to operate.

### instagram-comment-reply

```mermaid
flowchart LR
  IN["comments from router"] --> LOOP["one comment at a time"] --> RULES["comment rules"] --> CLAIM["claim in message_log"]
  CLAIM --> DUP{"first delivery?"}
  DUP -- no --> LOOP
  DUP -- yes --> PRICE{"price inquiry?"}
  PRICE -- "no: spam, insult, other" --> SKIP["log ignored"]
  PRICE -- yes --> SLOT["reserve hourly slot (MySQL)"] --> CAP{"under cap?"}
  CAP -- no --> RL["log rate_limited"]
  CAP -- yes --> PUB["public reply on the comment"] --> PRIV["private reply (DM by comment id)"] --> OK["log replied"]
```

Meta delivers Instagram DMs and comments to the same callback URL, so the router hands comments to this workflow. Rules are ordered: spam (links, gambling spam, follow-for-follow) wins over a price keyword, then insults, then price questions in Indonesian and English. Our own replies come back as comment webhooks and are skipped, which prevents reply loops. The hourly counter is incremented atomically before each reply, so concurrent executions cannot exceed the cap.

### payslip-notifications

```mermaid
flowchart LR
  T["every 15 min"] --> GET["GET /api/v1/integrations/outbox?after=0&limit=50 (2 pages max)"] --> REG["register events in outbox_delivery_attempts"] --> PLAN{"plan per event"}
  PLAN -- send --> CLAIM["claim: attempts + 1, status sending"] --> OWN{"claimed?"}
  OWN -- "no: another run is sending it" --> LEAVE["leave it"]
  OWN -- yes --> WA["WhatsApp template message"] --> EVAL{"message id?"}
  EVAL -- yes --> DEL["delivered: ack"]
  EVAL -- "no, attempts left" --> FAIL["failed: no ack, retry next run"]
  EVAL -- "no, 5th attempt" --> GIVE["gave_up: alert ops, ack"]
  PLAN -- "no phone / bad payload" --> UND["undeliverable: alert ops, ack"]
  PLAN -- "already handled earlier" --> RE["ack again only"]
  DEL --> ACK["POST /api/v1/integrations/outbox/ack {ids}"]
  GIVE --> ACK
  UND --> ACK
  RE --> ACK
```

Messages to employees are business-initiated, so WhatsApp only accepts them as **pre-approved message templates**; free-form text is rejected outside the 24-hour customer service window. The workflow uses two templates (`payslip_ready` with name, period and link; `salary_paid` with name, period and amount) that must be created and approved in WhatsApp Manager first.

The outbox is at-least-once. Every event id gets a row in `outbox_delivery_attempts` before anything is sent, so an event that was delivered but whose acknowledgement failed is only acknowledged again on the next run, not sent twice. Failed sends stay unacknowledged and come back on the next run. The fifth failed attempt, an employee without a phone number and an invalid payload are terminal: ops gets an alert and the event is acknowledged, so it does not return every 15 minutes forever.

Two runs can overlap when WhatsApp is slow, and n8n has no per-workflow concurrency limit outside queue mode. Before each send the run claims the event with a conditional `UPDATE`, and only the run that changed the row sends. A run takes at most 100 events, so it ends well within the two hours after which a claim left behind by a crashed run expires.

## Canonical message

Every normaliser returns the same shape, which is all the rest of the pipeline knows about a channel:

| Field                 | Example                                     | Notes                                                               |
| --------------------- | ------------------------------------------- | ------------------------------------------------------------------- |
| `channel`             | `whatsapp`, `instagram`, `telegram`         |                                                                     |
| `external_message_id` | `wamid.HBgN...`, IG `mid`, `700000001:42`   | The channel's own id; Telegram ids are only unique per chat         |
| `customer_id`         | `6281200000001`                             | WhatsApp `wa_id`, Instagram-scoped id, Telegram chat id             |
| `customer_name`       | `Rina Wulandari` or `null`                  | Instagram webhooks carry no name                                    |
| `text`                | `kak brp harga paket anggrek?`              | Trimmed, at most 4000 chars; image captions and button titles count |
| `received_at`         | `2026-10-09T10:00:00.000Z`                  | ISO-8601 UTC                                                        |
| `reply_target`        | `{ "phone_number_id": "...", "to": "..." }` | Whatever the channel's send API needs                               |

Dropped before the AI call: WhatsApp delivery and read statuses, reactions and media without text; Instagram echoes of our own messages, reactions, read receipts, edits, deletions and attachment-only messages; Telegram edits, bot senders, group chats (the bot also sits in the admin group) and updates without text.

The request to ai-support-service is the canonical message without `reply_target`. Instagram message ids can be longer than 128 characters; both ai-support-service and `message_log` accept `external_message_id` values up to 255 characters.

## Failure handling

| What happens                                    | Behaviour                                                                                                                                                                                                                                                                         |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bad or missing Meta signature                   | `401`, nothing is processed or stored. The HMAC covers the raw request bytes, not re-serialised JSON. A wrong Telegram `secret_token` also gets `401`; a wrong verify token on the GET handshake gets `403`.                                                                      |
| Duplicate webhook (Meta or Telegram redelivers) | Answered `200`. The insert into `message_log` hits the unique `(channel, external_message_id)` key and the message is skipped before the AI call. ai-support-service is also idempotent on the same key.                                                                          |
| ai-support-service down or slow                 | 100 s timeout, 3 tries 5 s apart with the same `external_message_id` (safe because the service is idempotent). Then the execution fails, the error workflow alerts ops with the execution link, and the `message_log` row stays `processing`. Fix and retry the execution in n8n. |
| ai-support-service answers 4xx                  | Same path: n8n retries every error the same way, so a bad API key surfaces as an ops alert after three tries.                                                                                                                                                                     |
| Channel API 429 or 5xx on a reply               | 3 tries 3 s apart, then the error workflow alerts ops. n8n does not read `Retry-After` and caps the wait between tries at 5 s.                                                                                                                                                    |
| Channel API 429 or 5xx on a payroll template    | 3 tries inside the run, then the event stays unacknowledged and is retried on the next run. The fifth failed run marks it `gave_up`, alerts ops and acknowledges it.                                                                                                              |
| hr-payroll-api down                             | The fetch retries 3 times, then the run fails and ops is alerted. Nothing is acknowledged, so nothing is lost; the next run starts again from `after=0`.                                                                                                                          |
| Acknowledgement call fails                      | Delivered events keep status `delivered` locally and are only re-acknowledged next run, never re-sent.                                                                                                                                                                            |
| Employee without a phone, invalid payload       | Marked `undeliverable`, ops alerted, acknowledged. Unknown event types are marked `skipped` and acknowledged quietly.                                                                                                                                                             |
| MySQL down                                      | The claim step fails, the error workflow alerts ops. Meta has already received its `200`.                                                                                                                                                                                         |
| Comment reply cap reached                       | No reply; the comment is logged as `rate_limited`.                                                                                                                                                                                                                                |

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

Create the credentials below in the n8n editor first, then import and publish:

```bash
docker compose exec n8n n8n import:workflow --separate --input=/opt/workflows/local
for id in oiaErrorHandler oiaCommentReply oiaInboundRouter oiaPayslipNotify; do
  docker compose exec n8n n8n publish:workflow --id=$id
done
docker compose restart n8n
```

Credentials are referenced by name only, and the import links each node to the existing credential with that name and type. The sub-workflow and the error handler must be published, or the router cannot call them.

### Credentials to create in n8n

| Name                 | Type         | Value                                                                                        |
| -------------------- | ------------ | -------------------------------------------------------------------------------------------- |
| `Meta App Secret`    | Crypto       | Hmac Secret: the Meta app secret                                                             |
| `WhatsApp Cloud API` | Bearer Auth  | System user token with `whatsapp_business_messaging`                                         |
| `Instagram API`      | Bearer Auth  | Instagram user token with `instagram_business_manage_messages` and `..._manage_comments`     |
| `Telegram Bot`       | Telegram API | Bot token from BotFather                                                                     |
| `AI Support Service` | Bearer Auth  | ai-support-service key with scope `messages:write`                                           |
| `HR Payroll API`     | Header Auth  | Name `X-Api-Key`, value: hr-payroll-api key with scope `outbox:read`                         |
| `Inbox MySQL`        | MySQL        | The database that holds `sql/schema.sql` (`mysql` / `inbox_automation` in the compose stack) |

### Settings (`.env`)

`scripts/build.js` validates the non-secret values in `.env` (service URLs, Graph API version, WhatsApp sender and template names, Telegram chat ids, attempt and reply caps; see `.env.example`) and bakes them into the workflow JSON. The two shared tokens are configured as hashes:

```bash
printf '%s' "$META_VERIFY_TOKEN"   | sha256sum   # META_VERIFY_TOKEN_SHA256
printf '%s' "$TELEGRAM_SECRET"     | sha256sum   # TELEGRAM_WEBHOOK_SECRET_SHA256
```

The defaults are 64 zeros, which match no token, so verification fails closed until they are set.

### n8n environment

| Variable             | Value                                                                                     |
| -------------------- | ----------------------------------------------------------------------------------------- |
| `N8N_ENCRYPTION_KEY` | Long random string; encrypts the stored credentials                                       |
| `WEBHOOK_URL`        | Public HTTPS base URL that Meta and Telegram can reach (behind a reverse proxy or tunnel) |
| `GENERIC_TIMEZONE`   | `Asia/Jakarta` in the compose file                                                        |

Leave `N8N_BLOCK_ENV_ACCESS_IN_NODE` at its default (`true`) and `NODE_FUNCTION_ALLOW_BUILTIN` unset: the workflows never read `$env`, and the Code nodes load no modules.

### Connect the channels

- **Meta (WhatsApp and Instagram):** callback URL `https://<host>/webhook/inbox/meta`, verify token = the token you hashed. Subscribe WhatsApp to `messages` and Instagram to `messages` and `comments`.
- **Telegram:** register the webhook with the secret token:

  ```bash
  curl "https://api.telegram.org/bot<token>/setWebhook" \
    -d url=https://<host>/webhook/inbox/telegram \
    -d secret_token=<secret> -d 'allowed_updates=["message"]'
  ```

## Tests

```bash
npm run lint
npm run build:check && npm run validate
TEST_MYSQL_URL=mysql://user:pass@127.0.0.1:3306/inbox_automation_test npm test
```

`npm test` runs 89 tests with `node:test`: normalisers against fixtures shaped like the official WhatsApp Cloud API, Instagram and Telegram Bot API payloads, signature checks, decision mapping, comment rules, outbox planning, the validator against deliberately broken workflows, and the built Code nodes executed outside n8n with stand-in globals. With `TEST_MYSQL_URL` set it also applies the schema and runs the workflow SQL against a real database (MariaDB 10.11 in CI); without it those tests are skipped.

### End-to-end (optional, not in CI)

`scripts/e2e.js` builds the workflows against local mock servers for ai-support-service, the WhatsApp and Instagram APIs, the Telegram Bot API and hr-payroll-api, imports and publishes them into a throwaway n8n (SQLite, temporary user folder), and checks what each mock received and what ended up in MySQL: the verify-token handshake; signed, wrongly signed and unsigned Meta requests; Meta answered in under 2 s while the AI call takes 4 s; duplicate deliveries and status callbacks; escalation with customer text that Telegram would reject unescaped; Telegram with and without the secret token; an Instagram DM; comment rules and the hourly cap; AI retries ending in the error workflow alert; and two payroll runs (acknowledgements, retry, give-up, an event claimed by another run, nothing sent twice).

```bash
N8N_BIN=/path/to/node_modules/.bin/n8n \
E2E_MYSQL_URL=mysql://user:pass@127.0.0.1:3306/inbox_automation_e2e \
npm run e2e
```

Verified with **n8n 2.42.5** on Node.js 24.21.0 and MariaDB 10.11.

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

- **Code in `src/`, built into the nodes.** A Code node in the template only says `@code:inbound-message-router/plan-actions.js`. The build bundles that glue file with the `src/` modules it requires into one self-contained script. Logic gets real tests and code review; n8n still shows readable code in each node.
- **Settings at build time, not `$env`.** n8n 2.x blocks `$env` in nodes by default, and turning it on exposes every variable of the n8n process, including `N8N_ENCRYPTION_KEY`, to anyone who can edit a workflow. Baking non-secret settings into the JSON avoids that. The cost: changing a URL means rebuilding and re-importing.
- **Secrets stay in credentials.** The Meta app secret is only used by the Crypto node's HMAC. The verify token and the Telegram secret are compared as SHA-256 hashes, so the workflow JSON holds hashes, never tokens. Comparisons run in constant time in plain JavaScript because Code nodes cannot load `crypto` by default.
- **One message per loop iteration.** When an n8n node retries, it re-runs for all its input items. With several messages in one webhook, a failed second reply would resend the first. The Loop Over Items node keeps every send, and every retry, to a single message.
- **De-duplication in MySQL.** The unique key on `message_log` is visible, queryable and survives an n8n reset, unlike n8n's internal de-duplication store.
- **MySQL node details.** The MySQL node (v2.3+) turns numeric-looking query parameters into numbers, which corrupts 17-digit Instagram ids, so ids are written through the insert and update operations, and the reply counter uses a string key such as `instagram:<id>`. Query placeholders are used once each in ascending order because the node binds values by placeholder number, not by position. These rules are tested in `test/sql.test.js`.
- **Telegram messages in HTML parse mode.** Without a parse mode the n8n Telegram node sends legacy Markdown, where one stray `_` (in a reason code or a customer's text) makes the send fail. HTML only needs `<`, `>` and `&` escaped, which `src/` does for every Telegram text; the validator rejects a Telegram node without `parse_mode: HTML`.

## Adding a channel

A channel is a normaliser and a sender: add `src/normalize-<channel>.js` returning canonical messages, a case in `buildReply` in `src/senders.js` and the channel name in `src/canonical.js`, then a webhook branch with its verification step and a send node behind `Route by Channel`. TikTok was left out on purpose: its direct message API is restricted and not available for general use.

## Limitations and future work

- Media messages without a caption are dropped instead of being passed to a human.
- Handing a conversation back to the bot (`POST /v1/conversations/:id/handoff`) is left to the agent; there is no agent inbox here.
- A failure stops the remaining messages of the same webhook delivery. They are not lost (the execution can be retried), but they wait.
- Rows that stay `processing` after a failure are found by query; a sweeper workflow that reports them daily would be the next step.
- Payroll sends are at least once: if n8n crashes during a run, the messages that run already sent are sent again once their claims expire.
- `comment_reply_counter` rows are never pruned.
- The compose file runs the n8n task runner in internal mode, which n8n 2.x marks as deprecated in favour of a separate runner container.

## License

MIT
