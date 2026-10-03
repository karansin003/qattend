/**
 * Tests for mandatory Firebase Email Verification in QAttend:
 *   node test/emailVerification.test.js
 *
 * Covers:
 *   1. New unverified user registration (blocks dashboard, redirects to /verify-email)
 *   2. Login with unverified email (blocks dashboard, redirects to /verify-email)
 *   3. Existing unverified user blocked by requireAuth from protected pages and APIs
 *   4. Protected APIs block unverified users (HTTP 403 EMAIL_VERIFICATION_REQUIRED)
 *   5. Protected APIs allow verified users (HTTP 200)
 *   6. Check Again / refresh verification (/api/auth/verify-token updates DB & session)
 *   7. Verification status endpoint (/api/auth/verification-status)
 *   8. Resend verification rate limiting and verify-email UI components
 *   9. Forgot password flow remains intact and functional
 *  10. QUMS identity preserved (UID = QAttend identity, QID = QUMS identity)
 *  11. Telegram linking and data preservation (zero data deletion)
 *  12. Multi-user isolation (unverified user state is strictly isolated from verified user)
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

// Hermetic test isolation before requiring app
const tmpDbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qattend-verify-test-')), 'db.json');
process.env.DB_FILE = tmpDbFile;
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret-verification';

const TEST_KEY_PATH = path.join(__dirname, 'fixtures', 'firebase-test-key.pem');
const TEST_CERT_PATH = path.join(__dirname, 'fixtures', 'firebase-test-cert.pem');
const TEST_PRIVATE_KEY = fs.readFileSync(TEST_KEY_PATH, 'utf8');
const TEST_CERT = fs.readFileSync(TEST_CERT_PATH, 'utf8');
const TEST_KID = 'test-kid-1';
const PROJECT_ID = 'qums-forgot-password-test';

const firebaseAuth = require('../src/firebaseAuth');
const db = require('../src/db');
const app = require('../src/server');

// Mock Google cert fetch
const origFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  if (String(url).startsWith('https://www.googleapis.com/robot/v1/metadata/x509/securetoken')) {
    return {
      ok: true,
      status: 200,
      headers: { get: (h) => (String(h).toLowerCase() === 'cache-control' ? 'public, max-age=3600' : null) },
      json: async () => ({ [TEST_KID]: TEST_CERT }),
    };
  }
  return origFetch(url, opts);
};

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

function makeIdToken(payload) {
  const header = { alg: 'RS256', kid: TEST_KID, typ: 'JWT' };
  const nowSec = Math.floor(Date.now() / 1000);
  const fullPayload = {
    iss: `https://securetoken.google.com/${PROJECT_ID}`,
    aud: PROJECT_ID,
    auth_time: nowSec - 5,
    iat: nowSec - 5,
    exp: nowSec + 3600,
    sub: payload.sub || 'uid-' + Math.random().toString(36).slice(2),
    email: payload.email || 'user@example.com',
    email_verified: payload.email_verified === true,
    ...payload,
  };
  const signedPart = `${b64url(header)}.${b64url(fullPayload)}`;
  const sig = crypto.createSign('sha256').update(signedPart).sign(TEST_PRIVATE_KEY, 'base64url');
  return `${signedPart}.${sig}`;
}

let server;
let baseUrl;

async function startServer() {
  await db.init();
  return new Promise((resolve) => {
    server = http.createServer(app);
    server.listen(0, () => {
      const port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
}

function stopServer() {
  return new Promise((resolve) => server.close(resolve));
}

let testCookie = '';

async function apiRequest(method, path, body = null, cookie = testCookie) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers['Cookie'] = cookie;
  const res = await origFetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) {
    testCookie = setCookie.split(';')[0];
  }
  let json = null;
  const text = await res.text();
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, headers: res.headers, json, text };
}

let passed = 0;
function ok(title, condition, extra = '') {
  if (!condition) {
    console.error(`FAIL: ${title}`, extra);
    process.exit(1);
  }
  console.log(`PASS  ${title}`);
  passed++;
}

async function runTests() {
  console.log('\n=== RUNNING EMAIL VERIFICATION TEST SUITE ===\n');
  await startServer();

  try {
    // -------------------------------------------------------------
    // Test 1: New unverified user registers with Firebase token (email_verified: false)
    // -------------------------------------------------------------
    const unverifiedEmail = 'new-student@example.com';
    const unverifiedUid = 'fb-uid-unverified-1';
    const unverifiedToken = makeIdToken({
      email: unverifiedEmail,
      email_verified: false,
      sub: unverifiedUid,
    });

    testCookie = ''; // clear session
    const regRes = await apiRequest('POST', '/api/register', {
      email: unverifiedEmail,
      idToken: unverifiedToken,
    });

    ok('1. Registration succeeds with unverified token', regRes.status === 200 && regRes.json.ok === true);
    ok('1. Registration returns emailVerified === false', regRes.json.emailVerified === false);
    ok('1. Registration redirects to /verify-email', regRes.json.redirect === '/verify-email');

    const createdUser = await db.getUserByEmail(unverifiedEmail);
    ok('1. User saved in DB with emailVerified === false', createdUser && createdUser.emailVerified === false);
    ok('1. User saved with correct firebaseUid', createdUser.firebaseUid === unverifiedUid);

    // -------------------------------------------------------------
    // Test 2: Protected APIs block unverified user (HTTP 403 EMAIL_VERIFICATION_REQUIRED)
    // -------------------------------------------------------------
    const meRes = await apiRequest('GET', '/api/me');
    ok('2. GET /api/me blocked for unverified user (HTTP 403)', meRes.status === 403);
    ok('2. Error code is EMAIL_VERIFICATION_REQUIRED', meRes.json.code === 'EMAIL_VERIFICATION_REQUIRED');

    const attRes = await apiRequest('GET', '/api/attendance');
    ok('2. GET /api/attendance blocked for unverified user (HTTP 403)', attRes.status === 403);
    ok('2. Attendance returns EMAIL_VERIFICATION_REQUIRED', attRes.json.code === 'EMAIL_VERIFICATION_REQUIRED');

    const qumsStartRes = await apiRequest('POST', '/api/qums-login/start');
    ok('2. POST /api/qums-login/start blocked for unverified user (HTTP 403)', qumsStartRes.status === 403);

    // -------------------------------------------------------------
    // Test 3: Protected pages redirect unverified user to /verify-email
    // -------------------------------------------------------------
    const dashRes = await apiRequest('GET', '/dashboard');
    ok('3. GET /dashboard redirects unverified user (HTTP 302)', dashRes.status === 302);
    ok('3. Redirect target is /verify-email', dashRes.headers.get('location') === '/verify-email');

    const qumsSetupRes = await apiRequest('GET', '/qums-setup');
    ok('3. GET /qums-setup redirects unverified user to /verify-email', qumsSetupRes.headers.get('location') === '/verify-email');

    // -------------------------------------------------------------
    // Test 4: Verification status API reflects unverified state
    // -------------------------------------------------------------
    const statusRes = await apiRequest('GET', '/api/auth/verification-status');
    ok('4. GET /api/auth/verification-status returns loggedIn: true', statusRes.json.loggedIn === true);
    ok('4. Verification status reports emailVerified: false', statusRes.json.emailVerified === false);
    ok('4. Verification status reports correct email', statusRes.json.email === unverifiedEmail);

    // -------------------------------------------------------------
    // Test 5: Verify-token rejects if token is still unverified
    // -------------------------------------------------------------
    const rejectedCheck = await apiRequest('POST', '/api/auth/verify-token', {
      idToken: unverifiedToken,
    });
    ok('5. POST /api/auth/verify-token rejects unverified token (HTTP 400)', rejectedCheck.status === 400);
    ok('5. Rejected check returns emailVerified: false', rejectedCheck.json.emailVerified === false);

    // -------------------------------------------------------------
    // Test 6: Check Again / verify-token with verified token (email_verified: true)
    // -------------------------------------------------------------
    const verifiedToken = makeIdToken({
      email: unverifiedEmail,
      email_verified: true,
      sub: unverifiedUid,
    });

    const verifyRes = await apiRequest('POST', '/api/auth/verify-token', {
      idToken: verifiedToken,
    });
    ok('6. POST /api/auth/verify-token succeeds with verified token', verifyRes.status === 200 && verifyRes.json.ok === true);
    ok('6. Verify-token returns emailVerified: true', verifyRes.json.emailVerified === true);
    ok('6. Verify-token redirects to /qums-setup (new user)', verifyRes.json.redirect === '/qums-setup');

    const refreshedUser = await db.getUserByEmail(unverifiedEmail);
    ok('6. DB record updated to emailVerified === true', refreshedUser.emailVerified === true);

    // -------------------------------------------------------------
    // Test 7: Protected APIs now ALLOW the verified user
    // -------------------------------------------------------------
    const meVerified = await apiRequest('GET', '/api/me');
    ok('7. GET /api/me allowed for verified user (HTTP 200)', meVerified.status === 200);
    ok('7. GET /api/me returns user email', meVerified.json.email === unverifiedEmail);

    // -------------------------------------------------------------
    // Test 8: Login with unverified token vs verified token
    // -------------------------------------------------------------
    testCookie = ''; // simulate fresh login
    const loginUnverifiedToken = makeIdToken({
      email: 'login-test@example.com',
      email_verified: false,
      sub: 'fb-login-unverified',
    });
    const loginRes1 = await apiRequest('POST', '/api/login', {
      email: 'login-test@example.com',
      idToken: loginUnverifiedToken,
    });
    ok('8. Login with unverified token returns redirect to /verify-email', loginRes1.json.redirect === '/verify-email');
    ok('8. Login returns emailVerified: false', loginRes1.json.emailVerified === false);

    const loginVerifiedToken = makeIdToken({
      email: 'login-test@example.com',
      email_verified: true,
      sub: 'fb-login-unverified',
    });
    const loginRes2 = await apiRequest('POST', '/api/login', {
      email: 'login-test@example.com',
      idToken: loginVerifiedToken,
    });
    ok('8. Login with verified token returns emailVerified: true', loginRes2.json.emailVerified === true);
    ok('8. Login with verified token redirects to /qums-setup or /dashboard', loginRes2.json.redirect === '/qums-setup');

    // -------------------------------------------------------------
    // Test 9: Existing unverified account data preservation
    // -------------------------------------------------------------
    const existingUser = await db.createUser({
      email: 'existing-legacy@example.com',
      passwordHash: 'dummy-hash',
      firebaseUid: 'fb-existing-legacy',
      emailVerified: false,
    });
    // Attach QUMS data, attendance, telegram to existing unverified user
    await db.updateUser(existingUser.id, {
      qumsQid: '998877',
      studentName: 'LEGACY STUDENT',
      telegramChatId: '123456789',
      qumsSessionPath: '/tmp/nonexistent-session.json',
    });

    const userInDb = await db.getUserById(existingUser.id);
    ok('9. Existing account exists with emailVerified === false', userInDb.emailVerified === false);
    ok('9. Existing account has QID preserved', userInDb.qumsQid === '998877');
    ok('9. Existing account has studentName preserved', userInDb.studentName === 'LEGACY STUDENT');
    ok('9. Existing account has Telegram chatId preserved', userInDb.telegramChatId === '123456789');

    // When existing unverified user logs in, they are redirected to /verify-email without data deletion
    const existingUnverifiedToken = makeIdToken({
      email: 'existing-legacy@example.com',
      email_verified: false,
      sub: 'fb-existing-legacy',
    });
    testCookie = '';
    const existingLogin = await apiRequest('POST', '/api/login', {
      email: 'existing-legacy@example.com',
      idToken: existingUnverifiedToken,
    });
    ok('9. Existing unverified user login redirected to /verify-email', existingLogin.json.redirect === '/verify-email');

    // Verify data remains untouched after login attempt
    const preservedUser = await db.getUserById(existingUser.id);
    ok('9. QID preserved after unverified login', preservedUser.qumsQid === '998877');
    ok('9. Student name preserved after unverified login', preservedUser.studentName === 'LEGACY STUDENT');
    ok('9. Telegram chat ID preserved after unverified login', preservedUser.telegramChatId === '123456789');

    // -------------------------------------------------------------
    // Test 10: Multi-user isolation
    // User A (unverified) and User B (verified)
    // -------------------------------------------------------------
    const userA_token = makeIdToken({ email: 'userA@example.com', email_verified: false, sub: 'fb-user-A' });
    const userB_token = makeIdToken({ email: 'userB@example.com', email_verified: true, sub: 'fb-user-B' });

    testCookie = '';
    await apiRequest('POST', '/api/register', { email: 'userA@example.com', idToken: userA_token });
    const cookieA = testCookie;

    testCookie = '';
    await apiRequest('POST', '/api/register', { email: 'userB@example.com', idToken: userB_token });
    const cookieB = testCookie;

    const meA = await apiRequest('GET', '/api/me', null, cookieA);
    ok('10. Multi-user: User A is blocked from /api/me (HTTP 403)', meA.status === 403);

    const meB = await apiRequest('GET', '/api/me', null, cookieB);
    ok('10. Multi-user: User B is allowed to access /api/me (HTTP 200)', meB.status === 200);
    ok('10. Multi-user: User B sees only their email', meB.json.email === 'userb@example.com');

    // -------------------------------------------------------------
    // Test 11: Verification page UI and Rate Limiting
    // -------------------------------------------------------------
    const verifyPageHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'verify-email.html'), 'utf8');
    ok('11. UI: Heading "Verify your email" exists', verifyPageHtml.includes('Verify your email'));
    ok('11. UI: Subtext message exists', verifyPageHtml.includes("We've sent a verification link to your email address"));
    ok('11. UI: Button "Resend Verification Email" exists', verifyPageHtml.includes('Resend Verification Email'));
    ok('11. UI: Button "I\'ve Verified — Check Again" exists', verifyPageHtml.includes("I've Verified — Check Again"));
    ok('11. UI: Button "Logout" exists', verifyPageHtml.includes('Logout'));
    ok('11. UI: Cooldown rate-limiting timer logic exists', verifyPageHtml.includes('RESEND_COOLDOWN_MS'));
    ok('11. UI: Reload/auth refresh call exists', verifyPageHtml.includes('user.reload()'));

    // -------------------------------------------------------------
    // Test 12: Forgot password flow intact
    // -------------------------------------------------------------
    const forgotRegistered = await apiRequest('POST', '/api/forgot', { email: unverifiedEmail });
    ok('12. Forgot password works for registered user', forgotRegistered.status === 200 && forgotRegistered.json.registered === true);

    const forgotUnknown = await apiRequest('POST', '/api/forgot', { email: 'unregistered_999@example.com' });
    ok('12. Forgot password rejects unknown email', forgotUnknown.status === 404 && forgotUnknown.json.registered === false);

    console.log(`\nALL ${passed} EMAIL VERIFICATION TESTS PASSED!\n`);
  } finally {
    await stopServer();
    try { fs.rmSync(path.dirname(tmpDbFile), { recursive: true, force: true }); } catch {}
  }
}

runTests().catch((err) => {
  console.error('[x] Test runner failed:', err);
  process.exit(1);
});
