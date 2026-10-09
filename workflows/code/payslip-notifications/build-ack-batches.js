const { buildAckBatches } = require('../../../src/outbox');

return buildAckBatches($input.all().map((item) => item.json)).map((batch) => ({ json: batch }));
