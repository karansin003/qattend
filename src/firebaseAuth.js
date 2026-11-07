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

const fs = require('fs');
const path = require('path');
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

let adminApp = null;
let adminInitAttempted = false;

function getFirebaseAdminApp() {
  if (adminInitAttempted) return adminApp;
  adminInitAttempted = true;
  try {
    const admin = require('firebase-admin');
    const existingApps = admin.getApps ? admin.getApps() : [];
    if (existingApps && existingApps.length > 0) {
      adminApp = existingApps[0];
      return adminApp;
    }

    const serviceAccountVar =
      process.env.FIREBASE_SERVICE_ACCOUNT ||
      process.env.FIREBASE_SERVICE_ACCOUNT_KEY ||
      process.env.FIREBASE_ADMIN_CREDENTIALS;

    if (serviceAccountVar) {
      let parsed = null;
      let trimmed = serviceAccountVar.trim();
      // Support base64 encoded JSON strings (common on Render to prevent multiline mangling)
      if (!trimmed.startsWith('{') && !trimmed.startsWith('/') && !trimmed.startsWith('.')) {
        try {
          const decoded = Buffer.from(trimmed, 'base64').toString('utf8');
          if (decoded.trim().startsWith('{')) {
            trimmed = decoded.trim();
          }
        } catch {}
      }
      if (trimmed.startsWith('{')) {
        parsed = JSON.parse(trimmed);
      } else if (fs.existsSync(trimmed)) {
        parsed = JSON.parse(fs.readFileSync(trimmed, 'utf8'));
      }
      if (parsed) {
        adminApp = admin.initializeApp({
          credential: admin.cert(parsed),
          projectId: parsed.project_id || FIREBASE_PROJECT_ID,
        });
        console.log('[firebase] Admin SDK initialized with service account.');
        return adminApp;
      }
    }

    // Check candidate local file paths if present
    const candidateFiles = [
      process.env.GOOGLE_APPLICATION_CREDENTIALS,
      path.join(process.cwd(), 'serviceAccountKey.json'),
      path.join(process.cwd(), 'firebase-service-account.json'),
      path.join(process.cwd(), 'service-account.json'),
    ].filter(Boolean);

    for (const f of candidateFiles) {
      if (fs.existsSync(f)) {
        try {
          const parsed = JSON.parse(fs.readFileSync(f, 'utf8'));
          if (parsed && (parsed.private_key || parsed.client_email)) {
            adminApp = admin.initializeApp({
              credential: admin.cert(parsed),
              projectId: parsed.project_id || FIREBASE_PROJECT_ID,
            });
            console.log(`[firebase] Admin SDK initialized with credential file: ${f}`);
            return adminApp;
          }
        } catch {}
      }
    }

    if (process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY) {
      const privateKey = process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n');
      adminApp = admin.initializeApp({
        credential: admin.cert({
          projectId: FIREBASE_PROJECT_ID,
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
          privateKey,
        }),
      });
      console.log('[firebase] Admin SDK initialized with client_email & private_key.');
      return adminApp;
    }

    // Try application default credentials if available (e.g. Google Cloud)
    if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      adminApp = admin.initializeApp({
        projectId: FIREBASE_PROJECT_ID,
      });
      return adminApp;
    }

    console.warn('[firebase] Admin SDK credentials not configured. Set FIREBASE_SERVICE_ACCOUNT_KEY in .env / Render to enable Firebase user deletion.');
  } catch (err) {
    console.warn('[firebase] Could not initialize Firebase Admin SDK:', err.message);
  }
  return null;
}

/**
 * Delete a user from Firebase Authentication, Firestore, and Realtime Database by UID and/or Email.
 * deps.auth or deps.app allows injecting mocks for unit testing.
 */
async function deleteFirebaseUser({ uid, email } = {}, deps = {}) {
  const app = deps.app || getFirebaseAdminApp();
  if (!app && !deps.auth) {
    return { ok: false, deleted: false, reason: 'admin-sdk-unconfigured' };
  }
  let auth = deps.auth;
  if (!auth) {
    const { getAuth } = require('firebase-admin/auth');
    auth = getAuth(app);
  }
  let deletedCount = 0;
  let targetUid = uid;

  if (targetUid) {
    try {
      await auth.deleteUser(targetUid);
      deletedCount += 1;
      console.log(`[firebase] Deleted user by UID from Firebase Auth: ${targetUid}`);
    } catch (err) {
      if (err && err.code !== 'auth/user-not-found') {
        console.error(`[firebase] Failed to delete user by UID ${targetUid}:`, err.message);
      }
    }
  }

  if (email) {
    try {
      const userRecord = await auth.getUserByEmail(email);
      if (userRecord && userRecord.uid) {
        if (!targetUid) targetUid = userRecord.uid;
        if (userRecord.uid !== uid) {
          await auth.deleteUser(userRecord.uid);
          deletedCount += 1;
          console.log(`[firebase] Deleted user by email lookup from Firebase Auth: ${userRecord.uid} (${email})`);
        }
      }
    } catch (err) {
      if (err && err.code !== 'auth/user-not-found') {
        console.error(`[firebase] Failed to find/delete user by email ${email}:`, err.message);
      }
    }
  }

  // Also clean up any Firestore user document if Firestore is in use
  if (app && (targetUid || email)) {
    try {
      const { getFirestore } = require('firebase-admin/firestore');
      const firestore = getFirestore(app);
      if (targetUid) {
        await firestore.collection('users').doc(targetUid).delete().catch(() => {});
      }
      if (email) {
        const snap = await firestore.collection('users').where('email', '==', email).get().catch(() => null);
        if (snap && !snap.empty) {
          for (const doc of snap.docs) {
            await doc.ref.delete().catch(() => {});
          }
        }
      }
    } catch {
      // Firestore not used or enabled, safe to ignore
    }

    // Also clean up any Realtime Database user node if RTDB is in use
    try {
      const { getDatabase } = require('firebase-admin/database');
      const rtdb = getDatabase(app);
      if (targetUid) {
        await rtdb.ref(`users/${targetUid}`).remove().catch(() => {});
      }
    } catch {
      // Realtime Database not used, safe to ignore
    }
  }

  return { ok: true, deleted: deletedCount > 0, deletedCount };
}

module.exports = {
  FirebaseTokenError,
  CERT_URL,
  firebaseProjectId,
  normalizeEmail,
  verifyIdToken,
  friendlyTokenError,
  resetCertificateCache,
  getFirebaseAdminApp,
  deleteFirebaseUser,
  // exported for tests only:
  parseMaxAge,
};

