const { checkVerificationRequest } = require('../../../src/signature');

return {
  json: checkVerificationRequest(
    $json.query,
    $json.verify_token_sha256,
    CONFIG.META_VERIFY_TOKEN_SHA256,
  ),
};
