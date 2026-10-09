'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  constantTimeEqual,
  verifyMetaSignature,
  verifySecretHash,
  checkVerificationRequest,
} = require('../src/signature');
const { rawFixture, hmacHex, sha256Hex } = require('./helpers/fixtures');

const APP_SECRET = 'fictional-app-secret';
const body = rawFixture('whatsapp-text.json');
const expected = hmacHex(APP_SECRET, body);

test('accepts the signature Meta computes over the raw body', () => {
  assert.deepEqual(verifyMetaSignature(`sha256=${expected}`, expected), {
    valid: true,
    reason: null,
  });
});

test('accepts an upper-case hex signature', () => {
  assert.equal(verifyMetaSignature(`sha256=${expected.toUpperCase()}`, expected).valid, true);
});

test('rejects a signature made with another secret', () => {
  const forged = hmacHex('another-secret', body);
  assert.deepEqual(verifyMetaSignature(`sha256=${forged}`, expected), {
    valid: false,
    reason: 'signature_mismatch',
  });
});

test('rejects a signature over a re-serialised body', () => {
  // Signing JSON.stringify(JSON.parse(body)) instead of the raw bytes is the classic bug.
  const reserialised = hmacHex(APP_SECRET, JSON.stringify(JSON.parse(body.toString('utf8'))));
  assert.equal(verifyMetaSignature(`sha256=${reserialised}`, expected).valid, false);
});

test('reports missing and malformed signature headers', () => {
  assert.equal(verifyMetaSignature(undefined, expected).reason, 'missing_signature');
  assert.equal(verifyMetaSignature('', expected).reason, 'missing_signature');
  assert.equal(verifyMetaSignature(`sha1=${expected}`, expected).reason, 'malformed_signature');
  assert.equal(verifyMetaSignature(`sha256=${expected}00`, expected).reason, 'malformed_signature');
});

test('throws when the computed HMAC is not a digest, which means the workflow is miswired', () => {
  assert.throws(() => verifyMetaSignature(`sha256=${expected}`, undefined), /Computed HMAC/);
  assert.throws(() => verifyMetaSignature(`sha256=${expected}`, 'abc'), /Computed HMAC/);
});

test('constantTimeEqual compares content and length', () => {
  assert.equal(constantTimeEqual('abcd', 'abcd'), true);
  assert.equal(constantTimeEqual('abcd', 'abce'), false);
  assert.equal(constantTimeEqual('abcd', 'abcde'), false);
  assert.equal(constantTimeEqual('abcd', null), false);
});

test('verifySecretHash matches only the configured token hash', () => {
  const configured = sha256Hex('telegram-secret-token');
  assert.equal(verifySecretHash(sha256Hex('telegram-secret-token'), configured), true);
  assert.equal(verifySecretHash(sha256Hex('guess'), configured), false);
  assert.throws(() => verifySecretHash(sha256Hex('x'), 'not-a-hash'), /Configured secret hash/);
});

test('checkVerificationRequest returns the challenge only for the right token', () => {
  const configured = sha256Hex('verify-me');
  const query = { 'hub.mode': 'subscribe', 'hub.challenge': '1158201444', 'hub.verify_token': 'x' };

  assert.deepEqual(checkVerificationRequest(query, sha256Hex('verify-me'), configured), {
    valid: true,
    reason: null,
    challenge: '1158201444',
  });
  assert.equal(
    checkVerificationRequest(query, sha256Hex('wrong'), configured).reason,
    'verify_token_mismatch',
  );
  assert.equal(
    checkVerificationRequest(
      { ...query, 'hub.mode': 'unsubscribe' },
      sha256Hex('verify-me'),
      configured,
    ).reason,
    'unexpected_mode',
  );
  assert.equal(
    checkVerificationRequest({ 'hub.mode': 'subscribe' }, sha256Hex('verify-me'), configured)
      .reason,
    'missing_challenge',
  );
});
