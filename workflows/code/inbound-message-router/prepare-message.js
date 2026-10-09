const { buildAiRequest, buildClaimRow } = require('../../../src/canonical');

return {
  json: { message: $json, ai_request: buildAiRequest($json), claim: buildClaimRow($json) },
};
