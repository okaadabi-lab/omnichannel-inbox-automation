const { evaluateDelivery } = require('../../../src/outbox');

const plan = $('Loop Sends').item.json;
return { json: evaluateDelivery(plan, $json, { maxAttempts: CONFIG.OUTBOX_MAX_ATTEMPTS }) };
