const { normalizeMetaPayload } = require('../../../src/normalize-meta');

return $input
  .all()
  .flatMap((item) => normalizeMetaPayload(item.json.body).messages)
  .map((message) => ({ json: message }));
