/**
 * Web-based QUMS login (multi-user) — HEADLESS captcha relay.
 *
 * Koi visible browser window nahi khulti — deployment-safe (VPS pe bhi chalta
 * hai jahan display nahi hota). Captcha image dashboard pe dikhti hai:
 *   1. POST /api/qums-login/start
 *      -> headless Chromium login page kholta hai, QID+password auto-fill
 *         (RECONNECT: DB se decrypt karke — user ko dobara nahi poochha jaata;
 *          FIRST-TIME: frontend se aaye creds use + success pe encrypted save),
 *         captcha ka screenshot (base64) return karta hai (browser alive rehta hai)
 *   2. POST /api/qums-login/submit-captcha { captchaText }
 *      -> captcha fill + Login click + URL-change wait; success pe session
 *         data/qums-sessions/<userId>.json me save + browser dispose.
 *         Galat captcha -> page reload + FRESH captcha image return (retry).
 *
 * Pending login 5 min me auto-expires (browser close).
 */
require('dotenv').config();
const { chromium } = require('playwright');
const db = require('./db');
const { encryptSecret, decryptSecret } = require('./crypto');
const {
  isLoginLikeUrl,
  findLoginForm,
  autofillCredentials,
  locateCaptchaInput,
  clickLoginButton,
  captureCaptchaImage,
} = require('./login');

const LOGIN_URL =
  process.env.QUMS_LOGIN_URL || 'https://qums.quantumuniversity.edu.in/';
const PENDING_TTL_MS = 5 * 60 * 1000; // 5 min to solve the captcha

class ConcurrentLoginError extends Error {
  constructor(message = 'Another QUMS reconnect or login is already in progress. Please wait a moment and try again.') {
    super(message);
    this.name = 'ConcurrentLoginError';
    this.code = 'CONCURRENT_LOGIN_LIMIT';
    this.hint = 'Only 1 active QUMS login or reconnect browser session is permitted at a time. Please wait a moment and retry.';
  }
}

/** userId -> { browser, context, page, frame, startedAt, timer } */
const pending = new Map();
let activeLaunchingUserId = null;

function isConcurrentBrowserActive(userId) {
  if (activeLaunchingUserId && activeLaunchingUserId !== userId) {
    return true;
  }
  for (const [id] of pending) {
    if (id !== userId) {
      return true;
    }
  }
  return false;
}

async function disposePending(userId) {
  const p = pending.get(userId);
  if (!p) return;
  pending.delete(userId);
  if (p.timer) clearTimeout(p.timer);
  // Wipe the in-memory credential copy immediately (never persisted anywhere).
  p.password = '';
  try {
    if (p.page && !p.page.isClosed()) await p.page.close().catch(() => {});
  } catch {}
  try {
    if (p.context) await p.context.close().catch(() => {});
  } catch {}
  try {
    if (p.browser) await p.browser.close().catch(() => {});
  } catch {}
}

// Navigation strategy for the QUMS portal:
//   - The portal keeps long-running network requests open after the document
//     arrives, and from some networks the response can be slow to start —
//     'domcontentloaded' held page.goto for the FULL 60s timeout in that case.
//   - 'commit' resolves as soon as the response starts arriving; we then wait
//     explicitly for the login-form inputs the captcha flow actually needs.
const LOGIN_NAV_TIMEOUT_MS = 45000; // bounded, not "huge"
const LOGIN_FORM_WAIT_MS = 20000; // form may render late / inside an iframe

/**
 * Navigate to the QUMS login page and wait until the login form is REALLY
 * usable (a frame with both a text input and a password input — the same
 * condition findLoginForm requires). Returns the login frame, or throws a
 * user-friendly error (no 60s hangs, no confusing downstream failures).
 */
async function gotoLoginPage(page) {
  try {
    await page.goto(LOGIN_URL, {
      waitUntil: 'commit', // resolve at response start — don't wait for full DOM
      timeout: LOGIN_NAV_TIMEOUT_MS,
    });
  } catch (err) {
    const e = new Error(
      `QUMS portal tak navigation fail hua (${String(err.message || '').split('\n')[0]}).`
    );
    e.name = 'ScrapeError'; // server maps this to HTTP 502 + shows the hint
    e.hint = 'Portal down hai ya network se reachable nahi — thodi der baad retry karo.';
    throw e;
  }

  // Bounded poll: findLoginForm needs text+password inputs in SOME frame
  // (the portal may render the form inside an iframe that loads a bit later).
  const deadline = Date.now() + LOGIN_FORM_WAIT_MS;
  while (Date.now() < deadline) {
    const frame = await findLoginForm(page);
    try {
      const [textCount, passCount] = await Promise.all([
        frame.locator('input[type="text"]').count(),
        frame.locator('input[type="password"]').count(),
      ]);
      if (textCount > 0 && passCount > 0) return frame;
    } catch {
      /* frame detached mid-check — retry */
    }
    await page.waitForTimeout(500);
  }

  const e = new Error('QUMS login form load nahi hua (page khula par form nahi mila).');
  e.name = 'ScrapeError';
  e.hint = 'Portal slow hai ya markup badal gaya hai — thodi der baad retry karo.';
  throw e;
}

async function openLoginFormPage() {
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-extensions',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-breakpad',
      '--disable-component-extensions-with-background-pages',
      '--disable-default-apps',
      '--disable-ipc-flooding-protection',
      '--disable-renderer-backgrounding',
      '--mute-audio',
    ],
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1, // 1x saves 4x RAM and GPU compared to 2x
  });
  // Abort non-essential network requests (fonts, media) to cut bandwidth and speed up page load
  await context.route('**/*', (route) => {
    const type = route.request().resourceType();
    if (type === 'font' || type === 'media') {
      return route.abort();
    }
    return route.continue();
  });
  const page = await context.newPage();
  try {
    const frame = await gotoLoginPage(page); // commit + explicit form wait
    return { browser, context, page, frame };
  } catch (err) {
    await browser.close().catch(() => {});
    throw err;
  }
}

async function captureCaptchaFor(pendingLogin) {
  const image = await captureCaptchaImage(pendingLogin.page, pendingLogin.frame);
  pendingLogin.captchaImage = image;
  return image;
}

/**
 * Step 1: login page kholo (HEADLESS — koi visible window nahi), creds
 * auto-fill karo, captcha ka screenshot (base64) return karo.
 *
 * credsOverride ({ qid, password }) sirf FIRST-TIME setup ke liye — frontend
 * inputs se aata hai. RECONNECT me credsOverride NAHI do: DB se decrypt karke
 * auto-fill hota hai, user ko QID/password dobara nahi poochhe jaate.
 */
async function startQumsLogin(userId, credsInput, log = console) {
  const user = await db.getUserById(userId);
  let qid = String((credsInput && credsInput.qid) || (user && user.qumsQid) || '').trim();
  let password = credsInput && credsInput.password ? String(credsInput.password) : '';

  // If password was not passed, use saved encrypted password from DB
  if (!password && user) {
    const savedEncrypted = user.qumsPasswordEncrypted || (await db.getQumsEncryptedPassword(userId));
    if (savedEncrypted) {
      password = decryptSecret(savedEncrypted) || '';
    }
  }

  const confirmSwitch = Boolean(credsInput && credsInput.confirmSwitch);
  if (!qid || !password) {
    const e = new Error('Please enter your QUMS QID and password.');
    e.name = 'QumsCredsRequired';
    e.hint = 'Enter your QID and password once. They will remain securely saved until you reset or delete your connection.';
    throw e;
  }

  // Detect identity change: if current active QID is different, require confirmation
  if (user && user.qumsQid && user.qumsQid !== qid && !confirmSwitch) {
    const err = new Error(`A different QUMS student ID was detected (old: ${user.qumsQid}, new: ${qid}). Explicit confirmation required before switching active QUMS identity.`);
    err.name = 'IdentityConflictError';
    err.code = 'IdentityConflict';
    err.oldQid = user.qumsQid;
    err.newQid = qid;
    throw err;
  }

  if (isConcurrentBrowserActive(userId)) {
    log.log(`[qums-login] Concurrent login rejected for user ${userId}: another browser session is active.`);
    throw new ConcurrentLoginError();
  }

  // Fast path: if browser & page are already active for this user, reuse them via page reload (~1s vs ~6s)
  const existing = pending.get(userId);
  if (existing && existing.page && !existing.page.isClosed()) {
    try {
      log.log(`[qums-login] Reusing existing browser page for user ${userId} to refresh captcha...`);
      await existing.page.reload({ waitUntil: 'commit', timeout: 15000 });
      const frame = await gotoLoginPage(existing.page);
      await autofillCredentials(frame, qid, password);
      existing.frame = frame;
      existing.qid = qid;
      existing.password = password;
      existing.confirmSwitch = confirmSwitch;
      const captchaImage = await captureCaptchaFor(existing);
      if (existing.timer) clearTimeout(existing.timer);
      existing.timer = setTimeout(() => {
        log.log(`[qums-login] pending login timeout for user ${userId} — browser close.`);
        disposePending(userId);
      }, PENDING_TTL_MS);
      return { ok: true, captchaImage };
    } catch (reloadErr) {
      log.log(`[qums-login] page reload failed (${reloadErr.message}), falling back to fresh browser...`);
      await disposePending(userId);
    }
  }

  activeLaunchingUserId = userId;
  try {
    await disposePending(userId); // koi purana pending ho to clean
    const { browser, context, page, frame } = await openLoginFormPage();
    try {
      await autofillCredentials(frame, qid, password);
      // qid/password sirf IN-MEMORY pending object me (captcha-retry ke liye).
      const pendingLogin = {
        browser,
        context,
        page,
        frame,
        startedAt: Date.now(),
        qid,
        password,
        confirmSwitch,
      };
      const captchaImage = await captureCaptchaFor(pendingLogin);
      pendingLogin.timer = setTimeout(() => {
        log.log(`[qums-login] pending login timeout for user ${userId} — browser close.`);
        disposePending(userId);
      }, PENDING_TTL_MS);
      pending.set(userId, pendingLogin);
      return { ok: true, captchaImage };
    } catch (err) {
      await browser.close().catch(() => {});
      throw err;
    }
  } finally {
    if (activeLaunchingUserId === userId) {
      activeLaunchingUserId = null;
    }
  }
}

/** Step 2: submit the captcha; success -> per-user session file + DB update. */
async function submitQumsCaptcha(userId, captchaText, log = console) {
  const p = pending.get(userId);
  if (!p) {
    const e = new Error('No pending QUMS login — captcha dobara generate karo.');
    e.name = 'NoPendingLogin';
    e.hint = 'Captcha 5 min me expire ho jata hai. Start Login dobara dabao.';
    throw e;
  }

  const captchaInput = await locateCaptchaInput(p.frame);
  await captchaInput.fill(String(captchaText || '').trim());
  await clickLoginButton(p.frame);

  try {
    await p.page.waitForURL((url) => !isLoginLikeUrl(url.toString()), { timeout: 30000 });
  } catch {
    // login fail (galat captcha / timeout) — fresh login page + FRESH captcha
    await p.browser.close().catch(() => {});
    activeLaunchingUserId = userId;
    let fresh;
    try {
      fresh = await openLoginFormPage();
    } finally {
      if (activeLaunchingUserId === userId) activeLaunchingUserId = null;
    }
    const { browser, context, page, frame } = fresh;
    await autofillCredentials(frame, p.qid, p.password);
    const newPending = {
      browser,
      context,
      page,
      frame,
      startedAt: Date.now(),
      qid: p.qid,
      password: p.password,
      confirmSwitch: p.confirmSwitch,
    };
    const captchaImage = await captureCaptchaFor(newPending);
    newPending.timer = setTimeout(() => {
      log.log(`[qums-login] pending login timeout for user ${userId} — browser close.`);
      disposePending(userId);
    }, PENDING_TTL_MS);
    pending.set(userId, newPending);
    return {
      ok: false,
      error: 'Captcha galat lagii ya login nahi hua — nayi captcha le lo, dobara try karo.',
      captchaImage,
    };
  }

  await p.page.waitForTimeout(2000); // post-login JS settle
  const sessionPath = db.sessionPathFor(userId);
  await p.context.storageState({ path: sessionPath });
  const pendingPassword = p.password;
  await disposePending(userId); // also wipes the in-memory password

  const user = await db.getUserById(userId);
  const isDifferentQid = Boolean(user && user.qumsQid && user.qumsQid !== p.qid);
  const isFirstTime = !user || (!user.monitoringStartedDate && !user.monitoringStartedAt) || isDifferentQid;

  // Persist QID + session path + encrypted password
  await completeQumsSetup(userId, p.qid, {
    password: pendingPassword,
    confirmSwitch: p.confirmSwitch,
  });
  log.log(`[qums-login] QUMS session saved for user ${userId} -> ${sessionPath}`);

  // QUMS is the source of truth for identity: fetch the displayed name and the
  // current Year/Sem right after a successful login/reconnect (cache refresh).
  let profile = { studentName: '', yearSem: '' };
  try {
    profile = await require('./scraper').fetchQumsProfile(sessionPath, log);
    const patch = {};
    if (profile.studentName) patch.studentName = profile.studentName;
    if (profile.yearSem) patch.qumsYearSem = profile.yearSem;
    if (Object.keys(patch).length) await db.updateUser(userId, patch);
    await db.touchUserSync(userId, { profile: true, error: '' });
    await db.clearSessionExpiry(userId);
    log.log(`[qums-login] profile synced from QUMS (user ${userId}, yearSem=${profile.yearSem || 'unknown'}).`);
  } catch (err) {
    // Name/YearSem are a cache: a lookup failure must never fail the login.
    log.log(`[qums-login] profile fetch skipped: ${err.name || 'Error'}: ${err.message}`);
  }

  // Baseline vs Reconnect catch-up:
  try {
    const catchup = require('./catchup');
    if (isFirstTime) {
      log.log(`[qums-login] initializing silent baseline for user ${userId} (QID ${p.qid})...`);
      await catchup.initializeSilentBaseline(userId, sessionPath, log);
    } else {
      log.log(`[qums-login] running reconnect catch-up for user ${userId} (QID ${p.qid})...`);
      await catchup.runReconnectCatchup(userId, sessionPath, log);
    }
  } catch (err) {
    log.log(`[qums-login] baseline/catch-up deferred: ${err.message}`);
  }

  return { ok: true, sessionPath, studentName: profile.studentName || '', yearSem: profile.yearSem || '' };
}

/**
 * Persist the QID + session path + encrypted password for the user.
 */
async function completeQumsSetup(userId, qid, { password, confirmSwitch = false } = {}) {
  const user = await db.getUserById(userId);
  const isDifferentQid = Boolean(user && user.qumsQid && user.qumsQid !== qid);
  const isFirstTime = !user || (!user.monitoringStartedDate && !user.monitoringStartedAt) || isDifferentQid;

  const patch = {
    qumsQid: String(qid || '').trim(),
    qumsSessionPath: db.sessionPathFor(userId),
    qumsSessionStatus: 'active',
  };

  if (password) {
    try {
      patch.qumsPasswordEncrypted = encryptSecret(password);
    } catch (err) {
      console.error('[qums-login] password encryption failed:', err.message);
    }
  }

  if (isFirstTime) {
    patch.monitoringStartedDate = db.getIstDateString();
    patch.monitoringStartedAt = new Date().toISOString();
  }

  await db.updateUser(userId, patch);
  await db.switchQumsIdentity(userId, qid, {
    monitoringStartedDate: patch.monitoringStartedDate || (user && user.monitoringStartedDate) || db.getIstDateString(),
  });
  return db.getUserById(userId);
}

function hasPendingLogin(userId) {
  return pending.has(userId);
}

module.exports = {
  ConcurrentLoginError,
  startQumsLogin,
  submitQumsCaptcha,
  completeQumsSetup,
  hasPendingLogin,
  disposePending,
  isConcurrentBrowserActive,
};
