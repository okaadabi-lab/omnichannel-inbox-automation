'use strict';

const SHA256_HEX = /^[0-9a-f]{64}$/;
const META_SIGNATURE_HEADER = /^sha256=([0-9a-fA-F]{64})$/;

// The inputs are fixed-length hex digests, so only their contents are secret. The loop
// always visits every character instead of returning at the first difference, so the time
// taken does not reveal how many leading characters matched. Node's crypto.timingSafeEqual
// is not used because n8n Code nodes cannot load built-in modules by default.
function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i += 1) {
    difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return difference === 0;
}

function assertSha256Hex(value, label) {
  if (typeof value !== 'string' || !SHA256_HEX.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 hex digest`);
  }
}

// expectedHex is HMAC-SHA256(app secret, raw request body), computed by n8n's Crypto node
// so that the app secret stays in the n8n credential store.
function verifyMetaSignature(signatureHeader, expectedHex) {
  assertSha256Hex(expectedHex, 'Computed HMAC');
  if (typeof signatureHeader !== 'string' || signatureHeader.length === 0) {
    return { valid: false, reason: 'missing_signature' };
  }
  const match = META_SIGNATURE_HEADER.exec(signatureHeader.trim());
  if (!match) return { valid: false, reason: 'malformed_signature' };
  if (!constantTimeEqual(match[1].toLowerCase(), expectedHex)) {
    return { valid: false, reason: 'signature_mismatch' };
  }
  return { valid: true, reason: null };
}

// Shared-secret tokens (Meta verify token, Telegram secret_token) are checked by hashing the
// presented value and comparing it with a configured SHA-256. The workflow JSON then only
// contains the hash, never the token.
function verifySecretHash(presentedHash, configuredHash) {
  assertSha256Hex(configuredHash, 'Configured secret hash');
  assertSha256Hex(presentedHash, 'Presented secret hash');
  return constantTimeEqual(presentedHash, configuredHash);
}

function checkVerificationRequest(query, presentedHash, configuredHash) {
  const mode = query ? query['hub.mode'] : undefined;
  const challenge = query ? query['hub.challenge'] : undefined;
  if (mode !== 'subscribe') return { valid: false, reason: 'unexpected_mode', challenge: null };
  if (typeof challenge !== 'string' || challenge.length === 0) {
    return { valid: false, reason: 'missing_challenge', challenge: null };
  }
  if (!verifySecretHash(presentedHash, configuredHash)) {
    return { valid: false, reason: 'verify_token_mismatch', challenge: null };
  }
  return { valid: true, reason: null, challenge };
}

module.exports = {
  constantTimeEqual,
  verifyMetaSignature,
  verifySecretHash,
  checkVerificationRequest,
};
