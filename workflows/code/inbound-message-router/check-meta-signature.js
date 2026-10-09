const { verifyMetaSignature } = require('../../../src/signature');

const result = verifyMetaSignature($json.headers['x-hub-signature-256'], $json.computed_signature);
return { json: { valid: result.valid, reason: result.reason, body: $json.body } };
