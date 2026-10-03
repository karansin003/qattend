
require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const bcrypt = require('bcryptjs');
// NOTE: mailer.js (Resend/SMTP) is NO LONGER used for password-reset emails —
// Firebase Authentication owns the reset flow now (single sender, no
// duplicates). The mailer module itself is untouched and its tests remain.
const firebaseAuth = require('./firebaseAuth');

const db = require('./db');
const { encryptSecret } = require('./crypto');
const { resolveUserRuntime } = require('./credentials');
const { scrapeAttendance, scrapeTodaysAttendance, getStudentProfile, ensureStudentName } = require('./scraper');
const { analyzeAttendance } = require('./calculator');
const telegram = require('./telegram');
const { sendMessage } = require('./telegram');
const { startScheduler, runMorningScheduleJob, catchUpMorningSchedule, getMorningScheduleText, getSchedulerStatus } = require('./scheduler');
const { startWatcher, runBaselineForUser, getWatcherStatus } = require('./watcher');
const { getAssignmentStatus } = require('./assignments');
const { clearSessionAlert } = require('./alerts');
const qumsLogin = require('./qums-login-web');
const { formatMorningSchedule, formatAttendanceMessage } = require('./messages');

const app = express();
const PORT = Number(process.env.PORT) || 10000; // Render PORT deta hai; local fallback 10000
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const SESSION_DIR = path.join(__dirname, '..', 'data', 'app-sessions');
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-only-insecure-secret-change-me';
// Render automatically RENDER=true set karta hai — NODE_ENV bhool jao to bhi
// secure-cookie/prod behavior theek rahega.
const IS_PROD = process.env.NODE_ENV === 'production' || Boolean(process.env.RENDER);

if (IS_PROD && !process.env.SESSION_SECRET) {
  console.error('[server] ⚠️ SESSION_SECRET missing in production — insecure dev fallback in use!');
  console.error('[server] ⚠️ Render Dashboard → Environment → SESSION_SECRET set karo (phir restart).');
}

/**
 * Public base URL — deployment-safe resolution order:
 *   1. APP_BASE_URL               (explicit; Render Dashboard → Environment me set)
 *   2. RENDER_EXTERNAL_URL        (Render khud inject karta hai — APP_BASE_URL
 *                                  set karna bhool jao to bhi reset link sahi banega)
 *   3. http://localhost:<PORT>    (LOCAL DEV ONLY — production me pehle dono
 *                                  available hote hain, isliye localhost kabhi
 *                                  production reset links me nahi jaayega)
 * Trailing "/" normalize hota hai -> `https://host//reset` jaisa bug kabhi nahi.
 */
function normalizeBaseUrl(u) {
  return String(u || '').trim().replace(/\/+$/, '');
}
const BASE_URL =
  normalizeBaseUrl(process.env.APP_BASE_URL) ||
  normalizeBaseUrl(process.env.RENDER_EXTERNAL_URL) ||
  `http://localhost:${PORT}`;

fs.mkdirSync(SESSION_DIR, { recursive: true }); // Render/first-run pe dir missing na ho

app.disable('x-powered-by');
app.set('trust proxy', 1); // Render ke reverse proxy ke peeche req.protocol/secure sahi rahe
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(
  session({
    store: new FileStore({
      path: SESSION_DIR,
      ttl: 90 * 24 * 60 * 60, // seconds — 90 din
      logFn: () => {}, // silence file-store noise
    }),
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 90 * 24 * 60 * 60 * 1000, // 90 din
      httpOnly: true, // JS se cookie accessible nahi (XSS safe-ish)
      sameSite: 'lax', // basic CSRF protection
      secure: IS_PROD, // production me HTTPS-only
    },
  })
);

// ---- helpers ----
async function currentUser(req) {
  if (!req.session || !req.session.userId) return null;
  return await db.getUserById(req.session.userId);
}

/** Pages -> redirect /login; APIs -> 401 JSON. /api/auth/* aur /health public rehte hain. */
async function requireAuth(req, res, next) {
  try {
    const user = await currentUser(req);
    if (user) {
      if (user.isSuspended) {
        if (req.session) {
          req.session.userId = null;
        }
        if (req.path.startsWith('/api/')) {
          return res.status(403).json({
            error: 'Your account has been suspended by the administrator.',
            code: 'ACCOUNT_SUSPENDED',
          });
        }
        return res.status(403).send('<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Account Suspended</title><link rel="stylesheet" href="/style.css"></head><body style="padding:40px;text-align:center;"><h1>Account Suspended</h1><p>Your account has been suspended by the administrator. Please contact support if you believe this is an error.</p><p style="margin-top:20px;"><a href="/login" class="btn" style="display:inline-block;padding:8px 16px;background:var(--primary,#1e3a8a);color:#fff;text-decoration:none;border-radius:6px;">Back to Login</a></p></body></html>');
      }
      if (!user.emailVerified) {
        if (req.path.startsWith('/api/')) {
          return res.status(403).json({
            error: 'Email verification required',
            code: 'EMAIL_VERIFICATION_REQUIRED',
          });
        }
        return res.redirect('/verify-email');
      }
      req.appUser = user;
      return next();
    }
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Login required', code: 'AUTH_REQUIRED' });
    return res.redirect('/login');
  } catch (err) {
    console.error('[auth] lookup failed:', err.message);
    return res.status(500).json({ error: 'Authentication service temporarily unavailable.' });
  }
}

const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '')
  .split(',')
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

function isUserAdmin(user) {
  if (!user) return false;
  if (user.isAdmin) return true;
  if (user.email && ADMIN_EMAILS.includes(user.email.toLowerCase())) return true;
  return false;
}

async function requireAdmin(req, res, next) {
  try {
    const user = await currentUser(req);
    if (!user) {
      if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Login required', code: 'AUTH_REQUIRED' });
      return res.redirect('/login');
    }
    if (user.isSuspended) {
      if (req.session) {
        req.session.userId = null;
      }
      if (req.path.startsWith('/api/')) {
        return res.status(403).json({
          error: 'Your account has been suspended by the administrator.',
          code: 'ACCOUNT_SUSPENDED',
        });
      }
      return res.status(403).send('<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Account Suspended</title><link rel="stylesheet" href="/style.css"></head><body style="padding:40px;text-align:center;"><h1>Account Suspended</h1><p>Your account has been suspended by the administrator.</p></body></html>');
    }
    if (!user.emailVerified) {
      if (req.path.startsWith('/api/')) {
        return res.status(403).json({
          error: 'Email verification required',
          code: 'EMAIL_VERIFICATION_REQUIRED',
        });
      }
      return res.redirect('/verify-email');
    }
    req.appUser = user;
    if (!isUserAdmin(user)) {
      if (req.path.startsWith('/api/')) {
        return res.status(403).json({ error: 'Admin access required', code: 'ADMIN_REQUIRED' });
      }
      return res.status(403).send('<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>403 Forbidden</title><link rel="stylesheet" href="/style.css"></head><body style="padding:40px;text-align:center;"><h1>403 Forbidden</h1><p>You do not have administrative privileges to access this area.</p><p style="margin-top:20px;"><a href="/dashboard" class="btn" style="display:inline-block;padding:8px 16px;background:var(--primary,#1e3a8a);color:#fff;text-decoration:none;border-radius:6px;">Return to Dashboard</a></p></body></html>');
    }
    return next();
  } catch (err) {
    console.error('[admin auth] lookup failed:', err.message);
    return res.status(500).json({ error: 'Authentication service temporarily unavailable.' });
  }
}

function httpStatusFor(err) {
  if (err.name === 'QumsSetupRequired') return 403;
  if (err.name === 'SessionExpiredError' || err.name === 'NoSessionError') return 409;
  if (err.name === 'NoPendingLogin' || err.name === 'TelegramNotLinked') return 409;
  if (err.name === 'QumsCredsMissing' || err.name === 'QumsCredsRequired') return 400;
  if (err.name === 'ScrapeError') return 502;
  return 500;
}

function validEmail(e) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || ''));
}

// ---- minimal in-memory rate limiter (auth endpoints — brute-force/email-spam guard) ----
const RATE_WINDOW_MS = 15 * 60 * 1000; // 15 min window
const RATE_LIMITS = {
  '/api/login': 20,
  '/api/register': 10,
  '/api/forgot': 5,
  '/api/reset': 10,
  '/api/auth/verify-token': 30,
};
const rateHits = new Map(); // `${ip}:${route}` -> [hit timestamps]

function rateLimit(route) {
  const max = RATE_LIMITS[route];
  return (req, res, next) => {
    const key = `${req.ip || 'unknown'}:${route}`;
    const now = Date.now();
    const hits = (rateHits.get(key) || []).filter((t) => now - t < RATE_WINDOW_MS);
    if (hits.length >= max) {
      return res.status(429).json({ error: 'Bahut zyada requests — thodi der baad try karo.' });
    }
    hits.push(now);
    rateHits.set(key, hits);
    if (rateHits.size > 5000) {
      // memory growth guard: purani entries delete
      for (const [k, v] of rateHits) {
        if (!v.some((t) => now - t < RATE_WINDOW_MS)) rateHits.delete(k);
      }
    }
    return next();
  };
}

/** 500s: prod me generic message (internals leak na ho), dev me detail. */
function safeServerError(res, err) {
  console.error('[server] route error:', err.name || 'Error', '-', err.message);
  const msg = IS_PROD ? 'Server error. Thodi der baad try karo.' : `${err.name || 'Error'}: ${err.message}`;
  res.status(500).json({ error: msg });
}

// ---- page routes ----
const sendPage = (name) => (req, res) => res.sendFile(path.join(PUBLIC_DIR, name));

/**
 * Contact page — optional REAL support address.
 *
 * `CONTACT_EMAIL` set (and valid) => the address is injected into the page.
 * Not set => the page keeps its clearly-marked placeholder text. A guessed or
 * invented support address is never rendered.
 */
function withContactEmail(html) {
  const configured = String(process.env.CONTACT_EMAIL || '').trim();
  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(configured);
  const escapeHtml = (s) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return html
    .replace(/__CONTACT_EMAIL__/g, valid ? escapeHtml(configured) : 'Not configured yet')
    .replace(
      /__CONTACT_EMAIL_NOTE__/g,
      valid
        ? 'This is the support address configured for this QAttend deployment.'
        : 'Placeholder: this deployment has no support email configured yet (set CONTACT_EMAIL to publish a real one). Please use the Telegram bot channel instead.'
    );
}

/**
 * Home / Landing page (public).
 *
 * "/" used to redirect only: first run -> /register, signed out -> /login,
 * signed in -> /dashboard. A production site needs a real public landing page,
 * so "/" now serves home.html. Authenticated pages keep redirecting to /login
 * exactly as before, and the landing nav swaps its Login/Register buttons for
 * "Go to Dashboard" when a session already exists (existing /api/me).
 */
app.get('/', sendPage('home.html'));

app.get('/register', sendPage('register.html'));
app.get('/login', sendPage('login.html'));
app.get('/verify-email', async (req, res) => {
  try {
    const user = await currentUser(req);
    if (user && user.emailVerified) {
      return res.redirect(user.qumsSessionPath ? '/dashboard' : '/qums-setup');
    }
  } catch {}
  return sendPage('verify-email.html')(req, res);
});
app.get('/forgot', sendPage('forgot.html'));
app.get('/reset', (req, res) => res.redirect('/login'));

// ---- public information pages (no auth required) ----
app.get('/features', sendPage('features.html'));
app.get('/how-it-works', sendPage('how-it-works.html'));
app.get('/about', sendPage('about.html'));
app.get('/faq', sendPage('faq.html'));
app.get('/privacy', sendPage('privacy.html'));
app.get('/terms', sendPage('terms.html'));
app.get('/contact', (req, res) => {
  res.send(withContactEmail(fs.readFileSync(path.join(PUBLIC_DIR, 'contact.html'), 'utf8')));
});

function withQumsResetControl(html) {
  const script = `
<script>
(() => {
  function setupReset() {
    let btn = document.getElementById('permanentQumsResetBtn');
    if (!btn) {
      btn = document.createElement('button');
      btn.id = 'permanentQumsResetBtn';
      btn.type = 'button';
      btn.textContent = 'Reset / Delete QUMS Connection';
      const resetTarget = document.getElementById('qumsResetSlot') || document.getElementById('setupCard') || document.querySelector('.card') || document.body;
      resetTarget.appendChild(btn);
    }
    btn.onclick = async () => {
      if (!confirm('QUMS connection permanently reset karna hai? Saved QID/password aur session delete ho jayenge.')) return;
      btn.disabled = true; btn.textContent = 'Resetting...';
      try {
        const r = await fetch('/api/qums-reset', { method:'POST', headers:{'Content-Type':'application/json'} });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || 'Reset failed');
        window.location.href = j.redirect || '/qums-setup';
      } catch (e) { alert(e.message || 'QUMS reset failed'); btn.disabled = false; btn.textContent = 'Reset / Delete QUMS Connection'; }
    };
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setupReset); else setupReset();
})();
</script>`;
  return html.includes('</body>') ? html.replace('</body>', script + '</body>') : html + script;
}

app.get('/dashboard', requireAuth, (req, res) => {
  const file = path.join(PUBLIC_DIR, 'index.html');
  res.send(withQumsResetControl(fs.readFileSync(file, 'utf8')));
});
app.get('/qums-setup', requireAuth, (req, res) => {
  const file = path.join(PUBLIC_DIR, 'qums-setup.html');
  res.send(withQumsResetControl(fs.readFileSync(file, 'utf8')));
});

// ---- Telegram setup page (same deep-link flow, same single bot/poller) ----
app.get('/telegram-setup', requireAuth, sendPage('telegram-setup.html'));

// ---- Admin dashboard page (protected by requireAdmin) ----
app.get('/admin', requireAdmin, sendPage('admin.html'));

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// ---- auth APIs (public; rate-limited) ----
/**
 * FIREBASE AUTH INTEGRATION (see src/firebaseAuth.js):
 *   - Browser creates/authenticates the Firebase user (Web SDK) and sends the
 *     ID token — NEVER a raw uid. The server crypto-verifies the token and
 *     reads uid+email from the VERIFIED payload (client email is untrusted).
 *   - The PostgreSQL/JSON app user remains the owner of QUMS credentials,
 *     Telegram link, attendance, schedules. users.firebase_uid maps 1:1.
 *   - Session model unchanged: req.session.userId = application user id.
 *   - LEGACY FALLBACK: users created before Firebase integration still log in
 *     with email+password (bcrypt) — they are migrated to firebaseUid on their
 *     first Firebase login (requires a VERIFIED Firebase email, so only the
 *     real mailbox owner can claim the mapping).
 */

/** Map a verified Firebase token onto the application user (create/link), safely. */
async function resolveAppUserForFirebase(verified, candidatePassword) {
  const { uid, email, emailVerified } = verified;
  if (!email) return { error: 'missing-email' };

  // 1) already mapped? -> done (uid is verified, so this is authoritative)
  const byUid = await db.getUserByFirebaseUid(uid);
  if (byUid) {
    const patch = {};
    if (byUid.email !== email) patch.email = email;
    if (Boolean(byUid.emailVerified) !== Boolean(emailVerified)) patch.emailVerified = Boolean(emailVerified);
    if (Object.keys(patch).length) {
      const updated = await db.updateUser(byUid.id, patch);
      return { user: updated };
    }
    return { user: byUid };
  }

  // 2) unmapped existing app user (pre-Firebase) -> safe migration
  const byEmail = await db.getUserByEmail(email);
  if (byEmail) {
    if (!byEmail.firebaseUid) {
      // ANTI-TAKEOVER GATE: linking a legacy account requires ownership proof —
      // EITHER the legacy bcrypt password (typed on the login form; only the
      // real owner knows it) OR a VERIFIED Firebase email (the verification
      // mail goes to the real mailbox; a self-serve "mark verified" is not
      // possible — tested against the live Identity Toolkit API).
      const bcryptOk =
        candidatePassword &&
        (await bcrypt.compare(String(candidatePassword), byEmail.passwordHash || ''));
      if (!bcryptOk && !emailVerified) {
        return { error: 'link-not-authorized', user: byEmail };
      }
      return {
        user: await db.updateUser(byEmail.id, {
          firebaseUid: uid,
          emailVerified: Boolean(emailVerified),
        }),
      };
    }
    // firebaseUid set but different uid for the same email — stale Firebase
    // user (deleted/recreated). Re-point to the current verified uid.
    return {
      user: await db.updateUser(byEmail.id, {
        firebaseUid: uid,
        emailVerified: Boolean(emailVerified),
      }),
    };
  }

  // 3) brand-new user (bcrypt hash is a random unguessable placeholder —
  //    password authority is Firebase now; legacy hash stays for old users)
  return {
    user: await db.createUser({
      email,
      passwordHash: bcrypt.hashSync(require('crypto').randomBytes(24).toString('hex'), 10),
      firebaseUid: uid,
      emailVerified: Boolean(emailVerified),
    }),
  };
}

/** Firebase token -> session. Shared by /api/register and /api/login.
 *  Returns { user, emailVerified, redirect } or sends the response itself (null). */
async function establishSessionFromIdToken(req, res, idToken, candidatePassword) {
  let verified;
  try {
    verified = await firebaseAuth.verifyIdToken(idToken);
  } catch (err) {
    console.error('[auth] idToken verification failed:', err.code || err.name);
    res.status(401).json({ error: firebaseAuth.friendlyTokenError(err) });
    return null;
  }

  const result = await resolveAppUserForFirebase(verified, candidatePassword);
  if (result.error === 'link-not-authorized') {
    res.status(403).json({
      error:
        'This account needs one-time setup: login with your previous app password, or reset your password and verify your email, then login again.',
      code: 'MIGRATE_PASSWORD',
    });
    return null;
  }
  if (!result || result.error === 'missing-email' || !result.user) {
    res.status(401).json({ error: 'Could not resolve your account. Please try again.' });
    return null;
  }

  if (result.user.isSuspended) {
    res.status(403).json({
      error: 'Your account has been suspended by the administrator.',
      code: 'ACCOUNT_SUSPENDED',
    });
    return null;
  }

  req.session.userId = result.user.id;
  const isVerified = Boolean(result.user.emailVerified);
  const redirect = !isVerified
    ? '/verify-email'
    : (result.user.qumsSessionPath ? '/dashboard' : '/qums-setup');

  return { user: result.user, emailVerified: isVerified, redirect };
}

app.post('/api/register', rateLimit('/api/register'), async (req, res) => {
  try {
    const { email, password, idToken, firebaseUnavailable } = req.body || {};
    const normalizedEmail = firebaseAuth.normalizeEmail(email);
    if (!validEmail(normalizedEmail)) return res.status(400).json({ error: 'Valid email daalo.' });
    // With an ID token the password NEVER leaves the browser (Firebase enforces
    // the 6-char minimum). Local validation applies to the legacy path only.
    if (!idToken && (!password || String(password).length < 6)) {
      return res.status(400).json({ error: 'Password kam se kam 6 characters ka hona chahiye.' });
    }

    // One application email == one application user (case-insensitive).
    const existing = await db.getUserByEmail(normalizedEmail);
    if (existing) {
      return res.status(409).json({ error: 'This email is already registered. Please login.' });
    }

    // Preferred path: Firebase created the account; verify the ID token.
    if (idToken) {
      const outcome = await establishSessionFromIdToken(req, res, idToken);
      if (!outcome) return; // response already sent (verification failure etc.)
      console.log(`[auth] registered (Firebase) -> ${outcome.user.email} (verified: ${outcome.emailVerified})`);
      return res.json({ ok: true, emailVerified: outcome.emailVerified, redirect: outcome.redirect });
    }

    // Fallback ONLY when the Firebase SDK could not load in the browser
    // (offline/CDN blocked) — keeps registration available, same bcrypt model.
    if (firebaseUnavailable === true) {
      const passwordHash = await bcrypt.hash(String(password), 10);
      const user = await db.createUser({ email: normalizedEmail, passwordHash, emailVerified: false });
      req.session.userId = user.id; // auto-login after register
      console.log(`[auth] registered (legacy fallback — Firebase SDK unavailable) -> ${user.email}`);
      return res.json({ ok: true, emailVerified: false, redirect: '/verify-email', warning: 'Registered without Firebase (SDK unavailable).' });
    }

    return res.status(400).json({ error: 'Registration requires Firebase verification. Please retry.' });
  } catch (err) {
    safeServerError(res, err);
  }
});

app.post('/api/login', rateLimit('/api/login'), async (req, res) => {
  try {
    const { email, password, idToken } = req.body || {};

    // Preferred path: Firebase-authenticated ID token (verified server-side).
    // The typed password accompanies the token ONLY as ownership proof for
    // linking a pre-Firebase (unmapped) account — it is never stored.
    if (idToken) {
      const outcome = await establishSessionFromIdToken(req, res, idToken, password);
      if (!outcome) return;
      console.log(`[auth] login (Firebase) -> ${outcome.user.email} (verified: ${outcome.emailVerified})`);
      return res.json({ ok: true, emailVerified: outcome.emailVerified, redirect: outcome.redirect });
    }

    // LEGACY FALLBACK: pre-Firebase users (or when the Firebase SDK could not
    // load in the browser). Same behavior as before: bcrypt -> session.
    const normalizedEmail = firebaseAuth.normalizeEmail(email);
    const user = await db.getUserByEmail(normalizedEmail);
    if (!user || !(await bcrypt.compare(String(password || ''), user.passwordHash))) {
      return res.status(401).json({ error: 'wrong email or password.' });
    }
    if (user.isSuspended) {
      return res.status(403).json({
        error: 'Your account has been suspended by the administrator.',
        code: 'ACCOUNT_SUSPENDED',
      });
    }
    req.session.userId = user.id;
    console.log(`[auth] login (legacy bcrypt fallback) -> ${user.email}`);
    const isVerified = Boolean(user.emailVerified);
    const redirect = !isVerified
      ? '/verify-email'
      : (user.qumsSessionPath ? '/dashboard' : '/qums-setup');
    res.json({ ok: true, emailVerified: isVerified, redirect });
  } catch (err) {
    safeServerError(res, err);
  }
});

/**
 * Check/refresh Firebase ID token verification state.
 * Called by "I've Verified — Check Again" after client reloads the Firebase user.
 */
app.post('/api/auth/verify-token', rateLimit('/api/auth/verify-token'), async (req, res) => {
  try {
    const { idToken } = req.body || {};
    if (!idToken) return res.status(400).json({ error: 'Token missing.' });

    let verified;
    try {
      verified = await firebaseAuth.verifyIdToken(idToken);
    } catch (err) {
      return res.status(401).json({ error: firebaseAuth.friendlyTokenError(err) });
    }

    if (!verified.emailVerified) {
      return res.status(400).json({
        ok: false,
        emailVerified: false,
        error: 'Email is not verified yet. Please check your inbox and click the verification link.',
      });
    }

    const outcome = await resolveAppUserForFirebase(verified);
    if (!outcome || !outcome.user) {
      return res.status(401).json({ error: 'Could not resolve user account.' });
    }

    if (outcome.user.isSuspended) {
      return res.status(403).json({
        error: 'Your account has been suspended by the administrator.',
        code: 'ACCOUNT_SUSPENDED',
      });
    }

    const updatedUser = await db.updateUser(outcome.user.id, { emailVerified: true });
    req.session.userId = outcome.user.id;

    console.log(`[auth] email verified -> ${updatedUser.email}`);
    return res.json({
      ok: true,
      emailVerified: true,
      redirect: updatedUser.qumsSessionPath ? '/dashboard' : '/qums-setup',
    });
  } catch (err) {
    safeServerError(res, err);
  }
});

/** Current user verification status check (used by the verification page). */
app.get('/api/auth/verification-status', async (req, res) => {
  try {
    const user = await currentUser(req);
    if (!user) {
      return res.json({ loggedIn: false, email: '', emailVerified: false });
    }
    return res.json({
      loggedIn: true,
      email: user.email,
      emailVerified: Boolean(user.emailVerified),
      redirect: user.qumsSessionPath ? '/dashboard' : '/qums-setup',
    });
  } catch (err) {
    return res.status(500).json({ error: 'Could not check status' });
  }
});

/**
 * Forgot password — Firebase-managed reset.
 *
 * Flow:
 *   1. Check the email against the APPLICATION database (normalized).
 *   2. Not registered  -> explicit error, NO email is sent (no enumeration by
 *      e-mail, no user creation).
 *   3. Registered      -> client calls Firebase sendPasswordResetEmail() with
 *      continueUrl = <app>/reset. The reset email goes to the USER'S registered
 *      address (never a hardcoded address), and Firebase owns the flow.
 *
 * The legacy mailer token path is retired for /api/forgot — Firebase is the
 * single sender, so no duplicate reset emails are possible. /api/reset still
 * accepts OLD in-flight token links (see below) and mailer.js stays intact.
 */
app.post('/api/forgot', rateLimit('/api/forgot'), async (req, res) => {
  try {
    const normalizedEmail = firebaseAuth.normalizeEmail(req.body?.email);
    if (!validEmail(normalizedEmail)) {
      return res.status(400).json({ ok: false, error: 'Valid email daalo.' });
    }
    const user = await db.getUserByEmail(normalizedEmail);
    if (!user) {
      return res.status(404).json({
        ok: false,
        registered: false,
        error: '❌ Email not registered\n\nThis email is not registered with QUMS Attendance Bot.\nPlease check your email address or create a new account.',
      });
    }
    console.log(`[auth] forgot-password requested (Firebase flow) -> ${user.email}`);
    return res.json({
      ok: true,
      registered: true,
      firebaseLinked: Boolean(user.firebaseUid),
      message: 'Password reset email sent. Please check your inbox.',
    });
  } catch (err) {
    safeServerError(res, err);
  }
});

/**
 * LEGACY reset endpoint — kept ONLY for old in-flight token emails that were
 * sent before the Firebase integration (tokens are still stored/verified).
 * New resets flow through Firebase: sendPasswordResetEmail() -> /reset page
 * (oobCode) -> confirmPasswordReset() on the client. No new tokens are issued.
 */
app.post('/api/reset', rateLimit('/api/reset'), async (req, res) => {
  try {
    const { token, password } = req.body || {};
    if (!token || !password || String(password).length < 6) {
      return res.status(400).json({ error: 'Token + new password (min 6 chars) chahiye.' });
    }
    const user = await db.consumeResetToken(token);
    if (!user) return res.status(400).json({ error: 'Reset link invalid ya expire ho gaya hai.' });
    const passwordHash = await bcrypt.hash(String(password), 10);
    await db.updateUser(user.id, { passwordHash });
    console.log(`[auth] password reset done -> ${user.email}`);
    res.json({ ok: true, redirect: '/login' });
  } catch (err) {
    safeServerError(res, err);
  }
});

// ---- protected data APIs (per-user) ----
app.get('/api/me', requireAuth, async (req, res) => {
  let user = await db.getUserById(req.session.userId);
  if (user && !user.studentName && user.qumsSessionPath && fs.existsSync(user.qumsSessionPath)) {
    try {
      await Promise.race([
        ensureStudentName(user.id),
        new Promise((resolve) => setTimeout(resolve, 2500)),
      ]);
      user = (await db.getUserById(req.session.userId)) || user;
    } catch {}
  }
  const hasSavedCreds = Boolean(user && user.qumsQid && (user.qumsPasswordEncrypted || (await db.getQumsEncryptedPassword(user.id))));
  res.json({
    email: user.email,
    studentName: user.studentName || '',
    qumsYearSem: user.qumsYearSem || '',
    qumsQid: user.qumsQid || '',
    qumsConfigured: Boolean(user.qumsSessionPath && fs.existsSync(user.qumsSessionPath)),
    qumsCredentialsSaved: hasSavedCreds,
    telegramConnected: Boolean(user.telegramChatId),
    telegramConfigured: telegram.isConfigured(),
    isAdmin: isUserAdmin(user),
  });
});

app.get('/api/attendance', requireAuth, async (req, res) => {
  try {
    const runtime = resolveUserRuntime(req.appUser);
    const overrideTotal = Number(req.query.total);
    const subjects = await scrapeAttendance({ sessionPath: runtime.sessionPath });
    const analysis = analyzeAttendance(
      subjects,
      Number.isFinite(overrideTotal) && overrideTotal > 0 ? overrideTotal : undefined
    );
    res.json(analysis);
  } catch (err) {
    res.status(httpStatusFor(err)).json({ error: err.message, hint: err.hint || null, code: err.name });
  }
});

app.get('/api/today', requireAuth, async (req, res) => {
  // Debug aid: shows exactly what the watcher polls for THIS user.
  try {
    const runtime = resolveUserRuntime(req.appUser);
    const periods = await scrapeTodaysAttendance({ sessionPath: runtime.sessionPath });
    res.json({ date: new Date().toISOString(), periods });
  } catch (err) {
    res.status(httpStatusFor(err)).json({ error: err.message, hint: err.hint || null, code: err.name });
  }
});

/** Accurate Telegram-blocker error (token missing vs not-linked confuse na ho). */
async function telegramSendBlockError(userId) {
  const reason = await telegram.sendBlockerReason(userId);
  if (reason === 'not-configured') {
    return Object.assign(new Error('Telegram token set nahi hai (.env: TELEGRAM_BOT_TOKEN) — BotFather ka token daal ke server restart karo.'), { name: 'TelegramNotConfigured' });
  }
  if (reason === 'bot-not-initialized') {
    return Object.assign(new Error('Telegram polling start nahi hua — server restart karo (token .env me hone ke baad).'), { name: 'TelegramNotConfigured' });
  }
  return Object.assign(new Error('Telegram linked nahi hai — pehle dashboard se "Connect Telegram" karo.'), { name: 'TelegramNotLinked' });
}

app.all('/api/trigger-telegram', requireAuth, async (req, res) => {
  try {
    const runtime = resolveUserRuntime(req.appUser);
    const subjects = await scrapeAttendance({ sessionPath: runtime.sessionPath });
    const analysis = analyzeAttendance(subjects);
    const preview = formatAttendanceMessage(analysis);
    const sent = await sendMessage(req.appUser.id, preview);
    if (!sent) throw await telegramSendBlockError(req.appUser.id);
    res.json({ success: true, sentTo: req.appUser.email, preview });
  } catch (err) {
    res.status(httpStatusFor(err)).json({ error: err.message, hint: err.hint || null, code: err.name });
  }
});

// ---- QUMS web login (HEADLESS captcha relay) ----
app.post('/api/qums-login/start', requireAuth, async (req, res) => {
  try {
    const { qid, password, confirmSwitch } = req.body || {};
    const finalQid = String(qid || req.appUser.qumsQid || '').trim();
    const finalPassword = password != null && String(password).trim() !== '' ? String(password) : undefined;

    const result = await qumsLogin.startQumsLogin(
      req.session.userId,
      { qid: finalQid, password: finalPassword, confirmSwitch: Boolean(confirmSwitch) }
    );
    res.json(result); // { ok: true, captchaImage }
  } catch (err) {
    if (err.name === 'IdentityConflictError' || err.code === 'IdentityConflict') {
      return res.status(409).json({
        ok: false,
        identityConflict: true,
        oldQid: err.oldQid,
        newQid: err.newQid,
        error: err.message,
      });
    }
    res.status(httpStatusFor(err)).json({ error: err.message, hint: err.hint || null, code: err.name });
  }
});

app.post('/api/qums-login/submit-captcha', requireAuth, async (req, res) => {
  try {
    const { captchaText, captcha } = req.body || {};
    const text = String(captchaText || captcha || '').trim();
    const result = await qumsLogin.submitQumsCaptcha(req.session.userId, text);
    if (result && result.ok) {
      // Seed baseline marked periods for today
      runBaselineForUser(req.session.userId).catch((e) =>
        console.error('[qums-setup] baseline fetch fail:', e.message)
      );
    }
    res.json(result); // { ok: true, sessionPath, studentName, yearSem } or { ok: false, error, captchaImage }
  } catch (err) {
    res.status(httpStatusFor(err)).json({ error: err.message, hint: err.hint || null, code: err.name });
  }
});

// ---- QUMS reset (permanent reset for req.session.userId only) ----
app.post('/api/qums-reset', requireAuth, async (req, res) => {
  try {
    const user = await db.getUserById(req.session.userId);
    const sp = (user && user.qumsSessionPath) || db.sessionPathFor(req.session.userId);
    if (sp && fs.existsSync(sp)) {
      try { fs.unlinkSync(sp); } catch {}
    }
    await db.updateUser(req.session.userId, {
      qumsQid: '',
      qumsPasswordEncrypted: '',
      qumsSessionPath: '',
      studentName: '',
      qumsYearSem: '',
      qumsSessionStatus: 'disconnected',
    });
    if (db.USE_PG && db.pool) {
      await db.pool.query('UPDATE qums_identities SET is_active=FALSE, updated_at=NOW() WHERE user_id=$1', [req.session.userId]).catch(() => {});
    }
    await clearSessionAlert(req.session.userId);
    res.json({
      ok: true,
      redirect: '/qums-setup',
      message: 'QUMS connection permanently reset. Ab QID/password dobara enter karo.',
    });
  } catch (err) {
    safeServerError(res, err);
  }
});

// ---- QUMS logout (deletes session file for req.session.userId only; retains QID for reconnect) ----
app.post('/api/qums-logout', requireAuth, async (req, res) => {
  try {
    const user = await db.getUserById(req.session.userId);
    const sp = (user && user.qumsSessionPath) || db.sessionPathFor(req.session.userId);
    if (sp && fs.existsSync(sp)) {
      try { fs.unlinkSync(sp); } catch {}
    }
    await db.updateUser(req.session.userId, { qumsSessionPath: '' });
    res.json({
      ok: true,
      message: 'QUMS logout — session delete ho gayi. Reconnect karne ke liye QUMS Setup → "Reconnect QUMS" (sirf captcha).',
    });
  } catch (err) {
    safeServerError(res, err);
  }
});


// ---- Telegram linking (deep-link flow — koi QR nahi) ----
app.get('/api/telegram/status', requireAuth, async (req, res) => {
  const user = await db.getUserById(req.appUser.id);
  const code = await db.telegramLinkCodeFor(req.appUser.id);

  res.json({
    configured: telegram.isConfigured(),
    connected: Boolean(user?.telegramChatId),
    botUsername: telegram.getBotUsername(),
    linkUrl: telegram.deepLink(code),
  });
});

app.post('/api/telegram/unlink', requireAuth, async (req, res) => {
  await db.clearTelegramChatId(req.appUser.id);
  res.json({ ok: true, message: 'Telegram disconnected. Dobara connect karne ke liye "Connect Telegram" dabao.' });
});

// ---- Admin APIs (protected by requireAdmin; returns non-sensitive metadata only) ----
app.get('/api/admin/users', requireAdmin, async (req, res) => {
  try {
    const search = String(req.query.search || '');
    const filter = String(req.query.filter || 'all');
    const page = Number(req.query.page) || 1;
    const limit = Number(req.query.limit) || 25;
    const data = await db.listUsersForAdmin({ search, filter, page, limit });
    res.json(data);
  } catch (err) {
    safeServerError(res, err);
  }
});

app.get('/api/admin/health', requireAdmin, async (req, res) => {
  try {
    const stats = await db.adminStats();
    const dbPing = await db.ping();
    const notifs = await db.notificationStats(30);
    const watcherStatus = typeof getWatcherStatus === 'function' ? getWatcherStatus() : {};
    const assignmentStatus = typeof getAssignmentStatus === 'function' ? getAssignmentStatus() : {};
    const schedulerStatus = typeof getSchedulerStatus === 'function' ? getSchedulerStatus() : {};
    const telegramInfo = {
      configured: telegram.isConfigured(),
      ready: telegram.isReady(),
      username: telegram.getBotUsername(),
    };
    res.json({
      ok: true,
      database: {
        mode: stats.dbMode,
        ping: dbPing,
        ...stats.database,
      },
      telegram: telegramInfo,
      scheduler: schedulerStatus,
      watcher: watcherStatus,
      assignments: assignmentStatus,
      stats: {
        totalUsers: stats.totalUsers,
        newUsers24h: stats.newUsers24h,
        newUsers7d: stats.newUsers7d,
        qumsConnected: stats.qumsConnected,
        sessionExpired: stats.sessionExpired,
        telegramConnected: stats.telegramConnected,
        suspended: stats.suspended,
        notificationsSent: notifs,
      },
      serverTime: new Date().toISOString(),
    });
  } catch (err) {
    safeServerError(res, err);
  }
});

app.post('/api/admin/users/:id/suspend', requireAdmin, async (req, res) => {
  try {
    const targetId = req.params.id;
    const target = await db.getUserById(targetId);
    if (!target) {
      return res.status(404).json({ error: 'User not found.' });
    }
    if (req.appUser && req.appUser.id === target.id) {
      return res.status(400).json({ error: 'Cannot suspend your own admin account.' });
    }
    const isSuspended = req.body && typeof req.body.suspended === 'boolean'
      ? req.body.suspended
      : !target.isSuspended;
    await db.setUserSuspended(target.id, isSuspended);
    console.log(`[admin] user ${target.email} (${target.id}) suspended: ${isSuspended} by ${req.appUser ? req.appUser.email : 'admin'}`);
    res.json({
      ok: true,
      id: target.id,
      isSuspended,
      message: isSuspended ? 'User has been suspended.' : 'User suspension lifted.',
    });
  } catch (err) {
    safeServerError(res, err);
  }
});

async function handleAdminDeleteUser(req, res) {
  try {
    const targetId = req.params.id;
    const target = await db.getUserById(targetId);
    if (!target) {
      return res.status(404).json({ error: 'User not found.' });
    }
    if (req.appUser && req.appUser.id === target.id) {
      return res.status(400).json({ error: 'Cannot delete your own admin account.' });
    }
    const sessionPath = target.qumsSessionPath || db.sessionPathFor(target.id);
    if (sessionPath) {
      try {
        if (fs.existsSync(sessionPath)) fs.unlinkSync(sessionPath);
      } catch (e) {
        console.warn(`[admin] failed to unlink session file for ${target.id}:`, e.message);
      }
    }
    await db.deleteUser(target.id);
    console.log(`[admin] user ${target.email} (${target.id}) deleted by ${req.appUser ? req.appUser.email : 'admin'}`);
    res.json({
      ok: true,
      id: target.id,
      message: `User ${target.email} deleted successfully.`,
    });
  } catch (err) {
    safeServerError(res, err);
  }
}

app.post('/api/admin/users/:id/delete', requireAdmin, handleAdminDeleteUser);
app.delete('/api/admin/users/:id', requireAdmin, handleAdminDeleteUser);

// ---- misc ----
// Health check — simple, secret-free: user counts / telegram state / internals
// PUBLIC endpoint pe leak nahi karte. Render Health Check Path isi ko point karo.
app.get('/health', (req, res) => {
  res.json({ ok: true, status: 'ok', uptimeSeconds: Math.round(process.uptime()), timestamp: new Date().toISOString() });
});

app.use(express.static(PUBLIC_DIR));

// ---- API fallbacks: kabhi bhi HTML API clients tak na jaaye ----
app.use('/api', (req, res) => {
  res.status(404).json({ error: `Unknown API route: ${req.method} ${req.originalUrl}` });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[server] unhandled error:', err.name || 'Error', '-', err.message);
  if (!IS_PROD && err.stack) console.error(err.stack); // stack sirf dev logs me
  if (req.path.startsWith('/api/')) {
    return res.status(500).json({ error: IS_PROD ? 'Server error. Thodi der baad try karo.' : 'Server error: ' + err.message });
  }
  res.status(500).send('Server error');
});

// ---- process-level resilience: scheduler/watcher zinda rahen, chhote errors pe crash nahi ----
process.on('unhandledRejection', (reason) => {
  console.error('[server] unhandledRejection:', reason && reason.message ? `${reason.name || 'Error'}: ${reason.message}` : reason);
});
process.on('uncaughtException', (err) => {
  console.error('[server] uncaughtException:', err.name || 'Error', '-', err.message);
});

// ---- boot ----
if (require.main === module) {
  (async () => {
    try {
      await db.init();
      startScheduler();
      startWatcher();
      telegram.initTelegram();
      // 8:30 IST par server band tha / late start hua -> aaj ka timetable ek baar
      // catch-up bhej do (per-day marker same-day duplicate rokta hai).
      catchUpMorningSchedule().catch((e) => console.error('[server] morning catch-up failed:', e.message));

      app.listen(PORT,() => {
    console.log(`[server] QUMS Attendance Bot (multi-user) running at ${BASE_URL}`);
    console.log(`[server] (listening on 0.0.0.0:${PORT}${IS_PROD ? ', production mode' : ', development mode'})`);
    console.log('[server] Pages: / (home) /features /how-it-works /about /faq /contact /privacy /terms | /register /login /dashboard /qums-setup /telegram-setup /forgot /reset');
    console.log('[server] APIs: /api/attendance | /api/today | /api/trigger-telegram | /health');
    console.log('[server] Scheduler: 8:30 AM IST (today\'s classes) — saare users, missed-run recovery + boot catch-up (daily 9 PM summary removed)');
    console.log('[server] Watcher: per-class alerts, college hours 08:30-17:00 IST + backdated month-register loop');
    console.log('[server] Assignments: new-assignment check (30 min) + deadline reminder 7:00 PM IST');
    if (!telegram.isConfigured()) {
      console.log('[server] Telegram: DISABLED — TELEGRAM_BOT_TOKEN set karo (Render env ya .env) aur restart; bina iske server theek chalega.');
    }
      });
    } catch (err) {
      console.error('[server] database boot failed:', err);
      process.exit(1);
    }
  })();
}

module.exports = app;
