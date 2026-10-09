const { verifySecretHash } = require('../../../src/signature');

const valid = verifySecretHash($json.secret_sha256, CONFIG.TELEGRAM_WEBHOOK_SECRET_SHA256);
return { json: { valid, body: $json.body } };
