const { planComment } = require('../../../src/comment-rules');

return {
  json: planComment($json, {
    priceListUrl: CONFIG.PRICE_LIST_URL,
    hourlyCap: CONFIG.COMMENT_REPLY_CAP_PER_HOUR,
  }),
};
