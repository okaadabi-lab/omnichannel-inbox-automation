const { collectOutboxEvents } = require('../../../src/outbox');

return collectOutboxEvents($input.all().map((item) => item.json)).map((event) => ({ json: event }));
