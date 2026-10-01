/**
 * firebaseAuth — server-side Firebase ID-token verification (Web SDK flow).
 *
 * WHY NOT THE FIREBASE ADMIN SDK?
 *   The Admin SDK requires a service-account PRIVATE KEY on the server. This
 *   project intentionally avoids storing any Firebase private credential:
 *   verifying an ID token is a PUBLIC-KEY operation. Google publishes the
 *   Firebase token-signing certificates at a well-known public URL, so the
 *   backend can verify tokens with ZERO stored secrets. This module performs
 *   the same checks the Admin SDK does internally:
 *     - RS256 signature against the published cert (kid rotation aware)
 *     - iss === https://securetoken.google.com/<projectId>
 *     - aud === <projectId>
 *     - exp / iat within tolerance, sub (uid) present, email claim present
 *
 * FLOW (secure — browser identity is never trusted directly):
 *   1. Browser: Firebase Web SDK signIn/signUp -> user.getIdToken()
 *   2. Browser: POST /api/register | /api/login | /api/link-firebase { idToken }
 *   3. Server:  verifyIdToken(idToken) -> { uid, email }   (crypto-verified)
 *   4. Server:  map/link app user by NORMALIZED email -> req.session.userId
 *   The client never sends "firebaseUid" as an identity claim — only the
 *   verified token counts. Nothing in this file is secret.
 *
 * Only env var: FIREBASE_PROJECT_ID (public identifier, NOT a secret).
 * Default: qums-forgot-password-test (the project's public Web config).
 */
require('dotenv').config();

const crypto = require('crypto');

const CERT_URL =
  'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';

/** Public project identifier (safe to hardcode — it is not a credential). */
const FIREBASE_PROJECT_ID =
  String(process.env.FIREBASE_PROJECT_ID || 'qums-forgot-password-test').trim();

/** Allow small clock drift between our server and Firebase tokens. */
const CLOCK_SKEW_SECONDS = 300;

/** Typed error so routes can map to user-friendly messages without leaking internals. */
class FirebaseTokenError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'FirebaseTokenError';
    this.code = code;
  }
}

function firebaseProjectId() {
  return FIREBASE_PROJECT_ID;
}

/** Normalized email everywhere: trim + lowercase (Firebase, PostgreSQL, UI). */
function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function b64urlDecodeJson(part) {
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public certificate cache: { kid -> pem }, refreshed per Cache-Control max-age.
// Injectable fetchImpl keeps this unit-testable without network access.
// ---------------------------------------------------------------------------
const certCache = { certs: null, expiresAt: 0, inflight: null };

function parseMaxAge(cacheControlHeader) {
  const m = /max-age\s*=\s*(\d+)/i.exec(String(cacheControlHeader || ''));
  const n = m ? Number(m[1]) : 0;
  if (!Number.isFinite(n) || n <= 0) return 3600;
  return Math.min(Math.max(n, 300), 3600); // clamp: [5 min, 1 hour]
}

async function fetchCertificates(deps = {}) {
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  const nowMs = deps.nowMs || Date.now();
  if (certCache.certs && nowMs < certCache.expiresAt) return certCache.certs;
  if (certCache.inflight) return certCache.inflight;

  certCache.inflight = (async () => {
    let res;
    try {
      res = await fetchImpl(CERT_URL);
    } catch {
      throw new FirebaseTokenError('certificates-unreachable', 'Unable to reach Google public certificates.');
    }
    if (!res.ok) {
      throw new FirebaseTokenError('certificates-unavailable', `Certificate endpoint responded ${res.status}.`);
    }
    const certs = await res.json();
    if (!certs || typeof certs !== 'object') {
      throw new FirebaseTokenError('certificates-invalid', 'Unexpected certificate payload.');
    }
    certCache.certs = certs;
    certCache.expiresAt = nowMs + parseMaxAge(res.headers.get('cache-control')) * 1000;
    return certs;
  })();

  try {
    return await certCache.inflight;
  } finally {
    certCache.inflight = null;
  }
}

/** Test hook — reset the in-memory certificate cache. */
function resetCertificateCache() {
  certCache.certs = null;
  certCache.expiresAt = 0;
  certCache.inflight = null;
}

/** RS256 signature check against the published cert for header.kid. */
function verifySignature(signedPart, signatureB64url, certPem) {
  let ok = false;
  try {
    const publicKey = new crypto.X509Certificate(certPem).publicKey;
    const data = Buffer.from(signedPart, 'utf8');
    const sig = Buffer.from(signatureB64url, 'base64url');
    ok = crypto.verify('sha256', data, publicKey, sig);
  } catch {
    ok = false;
  }
  if (!ok) throw new FirebaseTokenError('invalid-signature', 'Token signature verification failed.');
}

/** Claim checks: aud / iss / exp / iat / sub / email — Admin-SDK-equivalent rules. */
function verifyClaims(payload, projectId, nowSec) {
  if (!payload || typeof payload !== 'object') {
    throw new FirebaseTokenError('invalid-payload', 'Token payload missing.');
  }
  if (payload.aud !== projectId) throw new FirebaseTokenError('wrong-audience', 'Token audience mismatch.');
  if (payload.iss !== `https://securetoken.google.com/${projectId}`) {
    throw new FirebaseTokenError('wrong-issuer', 'Token issuer mismatch.');
  }
  if (typeof payload.exp !== 'number' || nowSec >= payload.exp + CLOCK_SKEW_SECONDS) {
    throw new FirebaseTokenError('token-expired', 'Token expired.');
  }
  if (typeof payload.iat !== 'number' || payload.iat > nowSec + CLOCK_SKEW_SECONDS) {
    throw new FirebaseTokenError('invalid-iat', 'Token issued-in-future.');
  }
  if (!payload.sub || typeof payload.sub !== 'string' || !payload.sub.length) {
    throw new FirebaseTokenError('missing-subject', 'Token subject (uid) missing.');
  }
  if (!payload.email || typeof payload.email !== 'string') {
    throw new FirebaseTokenError('missing-email', 'Token email claim missing.');
  }
}


/**
 * Verify a Firebase ID token. Returns { uid, email, emailVerified }.
 * deps (all optional, tests): fetchImpl, nowMs, projectId.
 * Throws FirebaseTokenError on ANY failure — routes translate to friendly text.
 */
async function verifyIdToken(idToken, deps = {}) {
  const projectId = deps.projectId || FIREBASE_PROJECT_ID;
  const nowSec = Math.floor((deps.nowMs || Date.now()) / 1000);

  const token = String(idToken || '').trim();
  const parts = token.split('.');
  if (parts.length !== 3) throw new FirebaseTokenError('malformed-token', 'Token is not a JWT.');

  const header = b64urlDecodeJson(parts[0]);
  const payload = b64urlDecodeJson(parts[1]);
  if (!header || !payload) throw new FirebaseTokenError('malformed-token', 'Token is not decodable.');
  if (header.alg !== 'RS256') throw new FirebaseTokenError('wrong-algorithm', 'Unexpected token algorithm.');
  if (!header.kid) throw new FirebaseTokenError('missing-kid', 'Token key id missing.');

  const certs = await fetchCertificates({ fetchImpl: deps.fetchImpl, nowMs: deps.nowMs || Date.now() });
  const certPem = certs[header.kid];
  if (!certPem || typeof certPem !== 'string') {
    throw new FirebaseTokenError('unknown-kid', 'Token signed by an unrecognized key.');
  }

  verifySignature(`${parts[0]}.${parts[1]}`, parts[2], certPem);
  verifyClaims(payload, projectId, nowSec);

  return {
    uid: payload.sub,
    email: normalizeEmail(payload.email),
    emailVerified: Boolean(payload.email_verified),
  };
}

/**
 * Safe, user-friendly message for a failed verification (no internals leak).
 * Used by routes; development logs may print err.code for diagnostics only.
 */
function friendlyTokenError(err) {
  const code = err instanceof FirebaseTokenError ? err.code : err && err.code;
  if (!code) {
    return 'Could not verify your login. Please try again.';
  }
  switch (code) {
    case 'token-expired':
      return 'Your session token expired. Please try again.';
    case 'certificates-unreachable':
    case 'certificates-unavailable':
    case 'certificates-invalid':
      return 'Authentication service is temporarily unavailable. Please try again shortly.';
    default:
      return 'Could not verify your login. Please try again.';
  }
}

module.exports = {
  FirebaseTokenError,
  CERT_URL,
  firebaseProjectId,
  normalizeEmail,
  verifyIdToken,
  friendlyTokenError,
  resetCertificateCache,
  // exported for tests only:
  parseMaxAge,
};

