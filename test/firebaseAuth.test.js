/**
 * Tests for src/firebaseAuth.js — server-side Firebase ID-token verification.
 *
 *   node test/firebaseAuth.test.js
 *
 * NO network, NO Firebase project access: the verifier's fetchImpl is injected
 * and tokens are signed with a THROWAWAY RSA key (test/fixtures/) whose cert
 * pretends to be Google's published cert. Covers:
 *   1. valid token  -> { uid, email } (normalized)
 *   2. tampered payload / wrong-key signature -> rejected
 *   3. wrong aud / iss, expired, future-iat, missing sub/email -> rejected
 *   4. malformed token / HS256 alg confusion / unknown kid -> rejected
 *   5. cert cache: one fetch per max-age window; refresh after expiry
 *   6. cert endpoint unreachable -> rejected
 *   7. friendlyTokenError -> safe user-facing text (no internals leak)
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let TEST_PRIVATE_KEY = '';
let TEST_CERT = '';
const keyPath = path.join(__dirname, 'fixtures', 'firebase-test-key.pem');
const certPath = path.join(__dirname, 'fixtures', 'firebase-test-cert.pem');
if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
  TEST_PRIVATE_KEY = fs.readFileSync(keyPath, 'utf8');
  TEST_CERT = fs.readFileSync(certPath, 'utf8');
} else {
  const { execSync } = require('child_process');
  const combined = execSync('openssl req -x509 -newkey rsa:2048 -keyout /dev/stdout -out /dev/stdout -days 1 -nodes -subj "/CN=test" 2>/dev/null', { encoding: 'utf8' });
  const keyMatch = combined.match(/-----BEGIN (?:RSA )?PRIVATE KEY-----[\s\S]+?-----END (?:RSA )?PRIVATE KEY-----/);
  const certMatch = combined.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/);
  TEST_PRIVATE_KEY = keyMatch ? keyMatch[0] : '';
  TEST_CERT = certMatch ? certMatch[0] : '';
}
const TEST_KID = 'test-kid-1';
const PROJECT_ID = 'qums-forgot-password-test';

let failures = 0;
function check(label, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${pass ? '' : `  -> got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`}`);
  if (!pass) failures += 1;
}

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

/** Sign a Firebase-style ID token with the throwaway key (RS256, header.kid). */
function makeIdToken(payload, headerOverrides = {}, signOptions = {}) {
  const header = { alg: 'RS256', kid: TEST_KID, typ: 'JWT', ...headerOverrides };
  const signedPart = `${b64url(header)}.${b64url(payload)}`;
  if (signOptions.hmacSecret) {
    const sig = crypto.createHmac('sha256', signOptions.hmacSecret).update(signedPart).digest('base64url');
    return `${signedPart}.${sig}`;
  }
  const key = signOptions.privateKey || TEST_PRIVATE_KEY;
  const signature = crypto.createSign('sha256').update(signedPart).sign(key, 'base64url');
  return `${signedPart}.${signature}`;
}

function nowPayload(overrides = {}) {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    iss: `https://securetoken.google.com/${PROJECT_ID}`,
    aud: PROJECT_ID,
    auth_time: nowSec - 10,
    user_id: 'firebase-uid-abc123',
    sub: 'firebase-uid-abc123',
    iat: nowSec - 10,
    exp: nowSec + 3600,
    email: 'Student@Example.COM', // intentionally mixed case — must normalize
    email_verified: true,
    firebase: { sign_in_provider: 'password', identities: {} },
    ...overrides,
  };
}

/** Fake Google cert endpoint returning the throwaway cert. */
function fakeFetch(countRef) {
  return async () => {
    if (countRef) countRef.n += 1;
    return {
      ok: true,
      status: 200,
      headers: { get: (k) => (String(k).toLowerCase() === 'cache-control' ? 'public, max-age=3600, must-revalidate' : null) },
      json: async () => ({ [TEST_KID]: TEST_CERT }),
    };
  };
}

async function expectCode(fn, expectedCode, label) {
  let err = null;
  try { await fn(); } catch (e) { err = e; }
  check(label, err && err.code, expectedCode);
}


(async () => {
  const fa = require('../src/firebaseAuth');

  check('normalizeEmail: trim + lowercase', fa.normalizeEmail('  Student@Example.COM '), 'student@example.com');
  check('parseMaxAge: 3600 header', fa.parseMaxAge('public, max-age=3600'), 3600);
  check('parseMaxAge: missing header -> 1h default', fa.parseMaxAge(''), 3600);

  // ---- 1. valid token ----
  {
    fa.resetCertificateCache();
    const count = { n: 0 };
    const res = await fa.verifyIdToken(makeIdToken(nowPayload()), { fetchImpl: fakeFetch(count) });
    check('valid token: uid', res.uid, 'firebase-uid-abc123');
    check('valid token: email normalized', res.email, 'student@example.com');
    check('valid token: emailVerified', res.emailVerified, true);
    check('cert fetch called once', count.n, 1);
  }

  // ---- 2. tampering / signature ----
  {
    fa.resetCertificateCache();
    const good = makeIdToken(nowPayload());
    const [h, p, s] = good.split('.');
    const payloadObj = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
    payloadObj.email = 'attacker@evil.com';
    await expectCode(
      () => fa.verifyIdToken(`${h}.${b64url(payloadObj)}.${s}`, { fetchImpl: fakeFetch({ n: 0 }) }),
      'invalid-signature',
      'tampered payload -> rejected'
    );

    // signed by a DIFFERENT key (rogue pair; cert store only knows TEST_KID cert)
    fa.resetCertificateCache();
    const rogue = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    await expectCode(
      () => fa.verifyIdToken(makeIdToken(nowPayload(), {}, { privateKey: rogue.privateKey }), { fetchImpl: fakeFetch({ n: 0 }) }),
      'invalid-signature',
      'wrong-key signature -> rejected'
    );
  }

  // ---- 3. claim checks ----
  const claimCases = [
    ['wrong audience', nowPayload({ aud: 'other-project' }), 'wrong-audience'],
    ['wrong issuer', nowPayload({ iss: 'https://accounts.google.com' }), 'wrong-issuer'],
    ['expired token', nowPayload({ exp: Math.floor(Date.now() / 1000) - 3600 }), 'token-expired'],
    ['future iat', nowPayload({ iat: Math.floor(Date.now() / 1000) + 3600 }), 'invalid-iat'],
    ['missing sub', nowPayload({ sub: '', user_id: '' }), 'missing-subject'],
    ['missing email', nowPayload({ email: undefined }), 'missing-email'],
  ];
  for (const [label, payload, expectedCode] of claimCases) {
    fa.resetCertificateCache();
    await expectCode(
      () => fa.verifyIdToken(makeIdToken(payload), { fetchImpl: fakeFetch({ n: 0 }) }),
      expectedCode,
      `claim: ${label} -> rejected`
    );
  }

  // ---- 4. header checks ----
  {
    fa.resetCertificateCache();
    await expectCode(
      () => fa.verifyIdToken('not-a-jwt', { fetchImpl: fakeFetch({ n: 0 }) }),
      'malformed-token',
      'malformed token -> rejected'
    );

    fa.resetCertificateCache();
    await expectCode(
      () => fa.verifyIdToken(makeIdToken(nowPayload(), { alg: 'HS256' }, { hmacSecret: 'secret' }), { fetchImpl: fakeFetch({ n: 0 }) }),
      'wrong-algorithm',
      'alg HS256 -> rejected (alg confusion)'
    );

    fa.resetCertificateCache();
    await expectCode(
      () => fa.verifyIdToken(makeIdToken(nowPayload(), { kid: 'unknown-kid' }), { fetchImpl: fakeFetch({ n: 0 }) }),
      'unknown-kid',
      'unknown kid -> rejected'
    );
  }

  // ---- 5. cert cache behavior ----
  {
    fa.resetCertificateCache();
    const count = { n: 0 };
    const fetchImpl = fakeFetch(count);
    const t0 = Date.now();
    await fa.verifyIdToken(makeIdToken(nowPayload()), { fetchImpl, nowMs: t0 });
    await fa.verifyIdToken(makeIdToken(nowPayload()), { fetchImpl, nowMs: t0 + 1000 });
    check('cache: 2 verifies, 1 fetch (same window)', count.n, 1);
    // after the max-age window: new fetch (fresh token so it is not expired at t0+2h)
    await fa.verifyIdToken(makeIdToken(nowPayload({ iat: t0 / 1000 + 7000, exp: t0 / 1000 + 11000, auth_time: t0 / 1000 + 7000 })), { fetchImpl, nowMs: t0 + 2 * 3600 * 1000 });
    check('cache: refresh after max-age window', count.n, 2);
  }

  // ---- 6. cert endpoint unreachable ----
  {
    fa.resetCertificateCache();
    await expectCode(
      () => fa.verifyIdToken(makeIdToken(nowPayload()), { fetchImpl: async () => { throw new Error('offline'); } }),
      'certificates-unreachable',
      'cert endpoint unreachable -> rejected'
    );
  }

  // ---- 7. friendly error text (no internals leak) ----
  check('friendlyTokenError: expired', fa.friendlyTokenError({ name: 'FirebaseTokenError', code: 'token-expired' }), 'Your session token expired. Please try again.');
  check('friendlyTokenError: cert outage', fa.friendlyTokenError({ name: 'FirebaseTokenError', code: 'certificates-unreachable' }), 'Authentication service is temporarily unavailable. Please try again shortly.');
  check('friendlyTokenError: generic (no internals leak)', fa.friendlyTokenError({ name: 'FirebaseTokenError', code: 'wrong-issuer' }), 'Could not verify your login. Please try again.');
  check('friendlyTokenError: unknown error type', fa.friendlyTokenError(new Error('x')), 'Could not verify your login. Please try again.');

  console.log(failures === 0 ? '\nALL FIREBASE AUTH TESTS PASSED' : `\n${failures} test(s) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error('[x]', err.name || 'Error', '-', err.message);
  process.exit(1);
});
