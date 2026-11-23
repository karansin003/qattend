# QAttend — Security Audit Report

> **Scope:** Security review of the actual QAttend codebase (`src/`, `public/`, configuration). No secrets, tokens, keys, or personal student records are disclosed.

---

## 1. Executive Summary of Security Controls & Findings

| Area | Control Implemented | Audit Finding / Risk Level |
| :--- | :--- | :--- |
| **App Passwords** | Firebase Auth (client-side) + `bcryptjs` (cost `10`) fallback | **Low Risk** — Legacy migration properly gated against takeover |
| **ERP Credentials at Rest** | AES-256-GCM (`src/crypto.js`) | **Medium Risk** — Documentation claims QUMS passwords aren't stored, yet `qums-login-web.js` stores `qums_password_encrypted`; static `scrypt` salt used |
| **Session Security** | `express-session` (`httpOnly`, `sameSite: 'lax'`, `secure: IS_PROD`) | **Medium Risk** — Insecure hardcoded `SESSION_SECRET` fallback if env missing; FileStore on ephemeral disk |
| **SQL Injection** | Parameterized `$1..$n` queries in `src/db.js`; `WRITABLE_USER_COLUMNS` whitelist | **Low Risk** — Safe against SQL injection |
| **XSS Protection** | `textContent` used in many places (`site.js`, `render()`, `loadUsers()`) | **Medium/High Risk** — `innerHTML` used with portal/user data in `index.html`, `admin.html`, `qums-setup.html` without escaping |
| **CSRF Protection** | `sameSite: 'lax'` cookie only | **Medium Risk** — No CSRF tokens; `GET /logout` & `ALL /api/trigger-telegram` accept GET requests for state-changing/actionable ops |
| **Rate Limiting** | In-memory IP+route limiter on 6 auth/contact endpoints | **Medium Risk** — Resets on restart, unauthenticated `rateHits` not shared across workers; Playwright endpoints (`/api/qums-login/*`, `/api/new-erp/login` partially) & `/api/attendance` unthrottled |
| **CAPTCHA Handling** | Manual human relay (`src/qums-login-web.js`), 5-attempt cap in Telegram | **Low Risk** — No bypass/solver; pending browser TTL = 3 min |
| **Database RLS** | None (`pg` direct Pool connection) | **Info / Medium Risk** — Multi-tenancy relies 100% on Node query filters; DB role has full table access |
| **TLS Verification** | `ignoreHTTPSErrors: true` (New ERP), `rejectUnauthorized: false` (PG) | **Medium Risk** — Vulnerable to MITM on New ERP Playwright calls and remote PG if DNS/network compromised |
| **HTTP Headers & CORS** | `app.disable('x-powered-by')`; no CORS headers (same-origin) | **Low/Medium Risk** — No `helmet`, CSP, `X-Frame-Options`, or `X-Content-Type-Options` headers |
| **Data Exposure / Hygiene** | `safeAdminUser()` strips secrets; `safeServerError()` hides stacks in prod | **Medium Risk** — Hardcoded fallback student QID/name in `server.js`, `telegram.js`, `qums-setup.html`; Firebase Admin JSON stored unencrypted in `system_settings` |

---

## 2. Detailed Audit Findings

### 2.1 Password Hashing & Account Auth
- **Firebase Auth (`src/firebaseAuth.js`):** Verifies RS256 signatures against Google's X.509 certificates, enforcing `aud`, `iss`, `exp`, `iat` (`±300s`), `sub`, and `email`.
- **Anti-Takeover Gate (`src/server.js:411-429`):** Linking a pre-Firebase legacy user requires either a valid `bcrypt.compare` against `users.password_hash` **or** `verified.emailVerified === true`. An attacker cannot create an unverified Firebase account for an existing user's email and hijack their QUMS/Telegram data.
- **Legacy Registration Fallback (`POST /api/register`):** Uses `bcryptjs` with salt rounds `10`. However, when `firebaseUnavailable: true`, `emailVerified` is set to `false` and the user has no Firebase account to verify with.

### 2.2 University ERP Password & Session Storage (`src/crypto.js`, `src/qums-login-web.js`, `src/new-erp-client.js`)
- **Encryption Scheme (`src/crypto.js`):**
  - Uses `aes-256-gcm` with a random 12-byte IV per encryption and 16-byte auth tag (`base64(iv + tag + ciphertext)`).
  - **Finding 1 (Static Salt):** Key derivation calls `crypto.scryptSync(secret, 'qums-attendance-bot-v1', 32)` with a hardcoded static salt. If `ENCRYPTION_KEY` is weak, dictionary attacks are easier across deployments.
  - **Finding 2 (Doc vs Code Discrepancy):** `README.md`, `src/credentials.js`, and `src/db.js` state QUMS passwords are never stored, yet `src/qums-login-web.js:542-548` (`completeQumsSetup`) encrypts and stores `qums_password_encrypted`, and `startQumsLogin` / `startTelegramCaptchaReconnect` decrypts it for CAPTCHA-only reconnects. Similarly, `new_erp_password_encrypted` is stored for 1-Click Reconnect.
  - **Finding 3 (Session File Persistence):** Playwright `storageState` (containing university auth cookies) is written both to local disk (`0600` mode in `data/qums-sessions/` and `data/new-erp-sessions/`) and encrypted via `encryptSecret` into `users.qums_session_data` / `users.new_erp_session_data` (falling back to plaintext JSON if `encryptSecret` throws!).

### 2.3 API Authentication & Session Security (`src/server.js`)
- **Cookie Flags:** `httpOnly: true`, `sameSite: 'lax'`, `secure: IS_PROD`, `trust proxy: 1`.
- **Finding 4 (Insecure Fallback Secret):** `SESSION_SECRET` defaults to `'dev-only-insecure-secret-change-me'` (`server.js:47`). Although a warning is logged in `IS_PROD`, the server still boots with a known secret if `SESSION_SECRET` is omitted.
- **Finding 5 (Incomplete Logout):** `GET /logout` destroys the Express session (`req.session.destroy`), but does **not** sign out the browser's Firebase Auth session (except on `verify-email.html`). Also, `GET /logout` is vulnerable to CSRF logout via `<img src="/logout">`.
- **Finding 6 (Privilege Escalation Guard):** `requireAdmin` validates `isSuspended`, `emailVerified`, and `isUserAdmin(user)` server-side on every `/admin` and `/api/admin/*` request. Self-suspension and self-deletion are explicitly blocked (`400`).

### 2.4 SQL Injection Protection (`src/db.js`)
- All PostgreSQL queries use parameterized placeholders (`$1`, `$2`, ...).
- `updateUser(id, patch)` maps keys exclusively through `WRITABLE_USER_COLUMNS` (`src/db.js:946-984`), preventing arbitrary column injection.
- `recordUserReconnect` interpolates `colToInc` from a strict ternary (`'reconnect_count_telegram'` vs `'reconnect_count_web'`), which is safe.

### 2.5 Cross-Site Scripting (XSS)
- **Safe Patterns:** `public/site.js`, Old ERP table `render()` (`index.html:410-444`), and Admin table `loadUsers()` (`admin.html:897-1116`) use `document.createElement` + `textContent`.
- **Finding 7 (`innerHTML` Injection Surfaces):**
  - `public/index.html`: `openSubjectDetails` (lines 875–880), `openDateLecturesModal` (lines 1122–1127), New ERP subject table (lines 1230–1237), and timetable cards/rows (lines 1312–1338) interpolate `subjectName`, `facultyName`, `classroom`, `lectureTime`, and `guidanceText` directly into `innerHTML`. If an external university portal field contains HTML/JS, it executes in the student's browser.
  - `public/admin.html`: `openConfirmModal` (line 1240) and `openResultsModal` (lines 1264–1266) inject `u.studentName`, `u.email`, and error strings into `innerHTML`.
  - `public/qums-setup.html`: Line 376–380 injects `data.oldQid` / `data.newQid` into `innerHTML`.

### 2.6 CSRF Protection
- `sameSite: 'lax'` protects standard POST requests from cross-site form submissions in modern browsers.
- **Finding 8:** No anti-CSRF token header/body validation is implemented. `GET /logout` and `app.all('/api/trigger-telegram')` perform actions on `GET`, bypassing `sameSite: 'lax'` top-level navigation protections.

### 2.7 Rate Limiting & Resource Exhaustion
- **Finding 9 (Auth Limiter Limits):** `rateHits` (`server.js:223`) is IP-based and in-memory (resets on restart).
- **Finding 10 (Unthrottled Playwright Triggers):** `POST /api/qums-login/start` and `POST /api/qums-login/submit-captcha` lack per-user/IP rate limiting (relying only on the global `MAX_CONCURRENT_PENDING = 15` browser cap), allowing one user or many users to exhaust server RAM on Render by launching Chromium instances. `/api/new-erp/login` uses `rateLimit('/api/login')`, whereas `/api/new-erp/reconnect` has no rate limit.

### 2.8 TLS, CORS & Security Headers
- **Finding 11 (TLS Bypass):** `src/new-erp-client.js` passes `ignoreHTTPSErrors: true` to all Playwright `newContext()` calls. `src/db.js` uses `rejectUnauthorized: false` for remote PostgreSQL connections by default.
- **Finding 12 (Missing Security Headers):** `src/server.js` disables `x-powered-by`, but sets no `Content-Security-Policy`, `X-Content-Type-Options: nosniff`, `X-Frame-Options`, `Referrer-Policy`, or `Strict-Transport-Security`.
- **CORS:** No `Access-Control-Allow-Origin` headers are set, so browsers enforce strict same-origin policy on API routes.

### 2.9 Sensitive Data & Secret Handling
- **`.gitignore`:** Properly excludes `.env`, `.env.*`, `*.pem`, `data/*`, `session_state.json`, `debug-*.txt`, and `test/fixtures/`.
- **Finding 13 (Hardcoded Fallback Student & Email Strings):**
  - `src/server.js` (`/api/me`, lines 809–832), `src/telegram.js` (`/status` line 1418, `/attendance` line 1586), and `public/qums-setup.html` (line 765) contain hardcoded fallback student name, QID, and course values when New ERP profile fields are missing/malformed.
  - `src/server.js` (`withContactEmail`, `/api/contact`) and `public/contact.html` contain a hardcoded developer Gmail address fallback.
- **Finding 14 (Unencrypted Service Account in DB):** `POST /api/admin/firebase-credentials` stores the raw Firebase Admin Service Account private key JSON plaintext in `system_settings.value` rather than encrypting it via `encryptSecret()`.
- **Logging Discipline:** Auth, scraper, and Telegram logs intentionally avoid printing passwords, session cookies, `TELEGRAM_BOT_TOKEN`, or `chatId` values.

