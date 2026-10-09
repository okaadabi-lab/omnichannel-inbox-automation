# Setting up your own n8n instance

The build, Docker and import commands are in the [README](../README.md#getting-started). This
page covers the credentials, settings and channel registration the workflows need.

## Credentials to create in n8n

| Name                 | Type         | Value                                                                                        |
| -------------------- | ------------ | -------------------------------------------------------------------------------------------- |
| `Meta App Secret`    | Crypto       | Hmac Secret: the Meta app secret                                                             |
| `WhatsApp Cloud API` | Bearer Auth  | System user token with `whatsapp_business_messaging`                                         |
| `Instagram API`      | Bearer Auth  | Instagram user token with `instagram_business_manage_messages` and `..._manage_comments`     |
| `Telegram Bot`       | Telegram API | Bot token from BotFather                                                                     |
| `AI Support Service` | Bearer Auth  | ai-support-service key with scope `messages:write`                                           |
| `HR Payroll API`     | Header Auth  | Name `X-Api-Key`, value: hr-payroll-api key with scope `outbox:read`                         |
| `Inbox MySQL`        | MySQL        | The database that holds `sql/schema.sql` (`mysql` / `inbox_automation` in the compose stack) |

## Settings (`.env`)

`scripts/build.js` validates the non-secret values in `.env` (service URLs, Graph API version, WhatsApp sender and template names, Telegram chat ids, attempt and reply caps; see `.env.example`) and bakes them into the workflow JSON. The two shared tokens are configured as hashes:

```bash
printf '%s' "$META_VERIFY_TOKEN"   | sha256sum   # META_VERIFY_TOKEN_SHA256
printf '%s' "$TELEGRAM_SECRET"     | sha256sum   # TELEGRAM_WEBHOOK_SECRET_SHA256
```

The defaults are 64 zeros, which match no token, so verification fails closed until they are set.

## n8n environment

| Variable             | Value                                                                                     |
| -------------------- | ----------------------------------------------------------------------------------------- |
| `N8N_ENCRYPTION_KEY` | Long random string; encrypts the stored credentials                                       |
| `WEBHOOK_URL`        | Public HTTPS base URL that Meta and Telegram can reach (behind a reverse proxy or tunnel) |
| `GENERIC_TIMEZONE`   | `Asia/Jakarta` in the compose file                                                        |

Leave `N8N_BLOCK_ENV_ACCESS_IN_NODE` at its default (`true`) and `NODE_FUNCTION_ALLOW_BUILTIN` unset: the workflows never read `$env`, and the Code nodes load no modules.

## Connect the channels

- **Meta (WhatsApp and Instagram):** callback URL `https://<host>/webhook/inbox/meta`, verify token = the token you hashed. Subscribe WhatsApp to `messages` and Instagram to `messages` and `comments`.
- **Telegram:** register the webhook with the secret token:

  ```bash
  curl "https://api.telegram.org/bot<token>/setWebhook" \
    -d url=https://<host>/webhook/inbox/telegram \
    -d secret_token=<secret> -d 'allowed_updates=["message"]'
  ```
