const { planActions } = require('../../../src/actions');

const message = $('Prepare Message').item.json.message;
const logId = $('Claim Message').item.json.data.insertId;
return { json: planActions(message, $json, { logId }) };
