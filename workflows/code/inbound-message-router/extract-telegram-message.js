const { normalizeTelegram } = require('../../../src/normalize-telegram');

return $input
  .all()
  .flatMap((item) => normalizeTelegram(item.json.body).messages)
  .map((message) => ({ json: message }));
