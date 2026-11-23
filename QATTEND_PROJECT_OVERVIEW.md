# QAttend — Project Overview

> **Audit Scope:** Complete reverse-engineering and technical blueprint of the existing **QAttend** codebase for **Quantum University (QID)**, intended as a reference specification for building an independent university attendance and ERP platform (**GUeAttend** for Graphic Era University / GUeID).
>
> **Accuracy Guarantee:** All statements below reflect the actual implementation inspected in `src/`, `public/`, `scripts/`, and configuration files. Non-existent, partial, or placeholder features are explicitly marked.

---

## 1. Executive Summary

**QAttend** (`package.json`: `"name": "qums-attendance-bot"`) is a multi-user, full-stack Node.js web application and Telegram automation service built for **Quantum University** students. It connects to Quantum University's ERP portals (**QUMS**), monitors attendance and assignments in the background, calculates 75% eligibility margins, and sends real-time and scheduled notifications to each student's linked Telegram chat.

### Core Capabilities
1. **Multi-User Web Application:** Student registration/login (Firebase Auth + Express sessions), onboarding for university ERP connection, interactive dashboard, and an Admin Portal.
2. **Dual Quantum University ERP Integration:**
   - **Old ERP (`https://qums.quantumuniversity.edu.in/`):** Uses QID + password + manual 6-character CAPTCHA relayed via headless Playwright Chromium.
   - **New ERP (`https://my.quantumuniversity.edu.in/`):** Uses registered email + password (no CAPTCHA), with portal active-session conflict detection and one-click "Logout All Sessions" recovery.
   - **Session Exclusivity:** Enforced centrally (`src/erp-session-registry.js` + `active_erp_sessions`) so one QUMS account has at most one active ERP integration (`OLD` or `NEW`) at a time.
3. **Automated Monitoring & Telegram Bot:**
   - **08:15 AM IST:** Schedule pre-warm cache (`src/scheduler.js`).
   - **08:30 AM IST:** Morning class timetable sent to Telegram with room and faculty (`src/scheduler.js`), plus missed-run recovery and boot catch-up until 11:00 AM IST.
   - **College Hours (08:30–17:00 IST, every 2–5 min):** Fast Today's Attendance watcher (`src/watcher.js`).
   - **24/7 Tiered Backdated Watcher (every 5–10 min):** Month-register differential scanner covering current month every cycle, previous month every `N` cycles, and older months every `H` hours (`src/watcher.js`).
   - **Assignments & Deadline Reminders:** Background polling (`src/assignments.js`, gated by `ENABLE_ASSIGNMENTS=true`) + 7:00 PM IST deadline reminder.
   - **Interactive Telegram Bot:** `/start`, `/attendance`, `/today`, `/assignments`, `/status`, `/reconnect`, `/DD/MM/YY` date lookup, `/help`, and `/admin` management panel.

---

## 2. Technology Stack

| Layer | Technology | Version / Library (`package.json`) | Notes |
| :--- | :--- | :--- | :--- |
| **Runtime** | Node.js | `>=18` | CommonJS modules |
| **Web Framework** | Express.js | `express ^4.19.2` | Server-rendered static HTML + JSON REST APIs |
| **Frontend** | Vanilla HTML5, CSS3, ES Modules | — | No React/Vue/bundler; Firebase Web SDK v10.12.2 via `gstatic.com` ESM CDN |
| **Sessions** | `express-session` + `session-file-store` | `^1.18.0` / `^1.5.0` | Cookie-based `connect.sid` stored on disk in `data/app-sessions/` (90-day TTL) |
| **Database** | Supabase PostgreSQL (`pg`) | `pg ^8.23.0` | Direct `Pool` via `DATABASE_URL`; JSON file fallback (`data/db.json`) when `DATABASE_URL` is unset |
| **Authentication** | Firebase Auth + `bcryptjs` | Web SDK `10.12.2`, `firebase-admin ^14.5.0`, `bcryptjs ^2.4.3` | Pure-Node RS256 ID token verification (`src/firebaseAuth.js`); Admin SDK used for user deletion |
| **ERP Automation** | Playwright (Chromium) | `playwright ^1.45.0` | `playwrightRequest` API contexts (Old ERP data) + headless Chromium (CAPTCHAs, timetable fallback, New ERP) |
| **Scheduling** | `node-cron` + `setInterval` | `^3.0.3` | Cron for 8:15/8:30 AM & 7:00 PM IST; intervals for watchers |
| **Bot Channel** | Telegram Bot API | `node-telegram-bot-api ^0.66.0` | Long-polling mode with PID lock (`data/telegram-polling.lock`) |
| **Exports** | SheetJS | `xlsx ^0.18.5` | Admin `.xlsx` user & metrics export |
| **Email (Legacy)** | Resend | `resend ^6.28.1` | Password resets moved to Firebase; `src/mailer.js` retained for `/api/contact` forwarding |
| **Hosting** | Render + Supabase | — | Deployed at `https://qattend.onrender.com` |

---

## 3. Repository Structure

```text
qattend/
├── package.json                  # Dependencies & npm scripts (start, scrape, test, telegram-test, cron)
├── .env.example                  # Documented environment variable template
├── README.md                     # High-level project overview
├── FIREBASE_SETUP.md             # Firebase setup guide (partially superseded by firebase-admin additions)
├── session_state.json            # Legacy CLI root Playwright session file
├── data/
│   ├── app-sessions/             # Express FileStore session JSON files
│   ├── qums-sessions/            # Old ERP Playwright storageState (<userId>.json)
│   ├── new-erp-sessions/         # New ERP Playwright storageState (<userId>.json)
│   ├── notified_periods/         # Per-user fast-loop today attendance dedupe (<userId>.json)
│   ├── db.json                   # Local JSON DB fallback (when DATABASE_URL is unset)
│   ├── month_register_tier_state.json
│   └── morning_schedule_state.json
├── public/
│   ├── home.html                 # Public landing page (/) + AdSense script
│   ├── login.html                # Login (/login)
│   ├── register.html             # Registration (/register)
│   ├── verify-email.html         # Email verification gate (/verify-email)
│   ├── forgot.html               # Password reset trigger (/forgot)
│   ├── index.html                # Student dashboard (/dashboard)
│   ├── qums-setup.html           # Old & New ERP connection UI (/qums-setup)
│   ├── telegram-setup.html       # Telegram deep-link UI (/telegram-setup)
│   ├── admin.html                # Web Admin Portal (/admin)
│   ├── features.html, how-it-works.html, about.html, faq.html, contact.html
│   ├── attendance-calculator-guide.html, qums-troubleshooting.html
│   ├── telegram-guide.html, security-and-privacy.html, privacy.html, terms.html
│   ├── firebase-config.js        # Public Firebase Web SDK config
│   ├── site.js                   # Shared mobile drawer, active nav, auth-swap (/api/me)
│   ├── style.css                 # Shared responsive stylesheet
│   ├── robots.txt, sitemap.xml, ads.txt, google8e16ee4aea8f0348.html
├── src/
│   ├── server.js                 # Express app, auth middleware, routes, caches, boot sequence
│   ├── db.js                     # Dual-mode DB layer (PostgreSQL + JSON fallback)
│   ├── migrations.js             # 22 idempotent PostgreSQL migrations + 1 opt-in migration
│   ├── firebaseAuth.js           # Public-key JWT verifier + Firebase Admin SDK wrapper
│   ├── crypto.js                 # AES-256-GCM encryptSecret / decryptSecret via scrypt
│   ├── credentials.js            # Per-user Old ERP session runtime resolver
│   ├── erp-session-registry.js   # Mutual exclusivity between OLD and NEW ERP per identity
│   ├── login.js                  # Old ERP Playwright form/CAPTCHA DOM helpers
│   ├── qums-login-web.js         # Headless Chromium CAPTCHA relay + pending session pool
│   ├── scraper.js                # Old ERP API + Playwright scrapers and parsers
│   ├── new-erp-client.js         # New ERP Playwright login, attendance, timetable, assessments
│   ├── calculator.js             # 75% attendance analyzer (needed / canSkip)
│   ├── catchup.js                # Silent first-run baseline & reconnect catch-up diffing
│   ├── watcher.js                # Fast today loop + tiered month-register loop
│   ├── scheduler.js              # 08:15 prewarm + 08:30 morning schedule + boot catch-up
│   ├── assignments.js            # Assignment polling + 7:00 PM IST deadline reminders
│   ├── alerts.js                 # Session-expiry/conflict Telegram alerts & auto-cleanup
│   ├── messages.js               # Telegram message formatters
│   ├── telegram.js               # Telegram Bot poller, commands, CAPTCHA reconnect, auto-delete
│   ├── telegram-admin.js         # Interactive Telegram /admin panel & broadcast tool
│   ├── mailer.js                 # Legacy Resend wrapper (used for /api/contact)
│   └── debug-*.js                # 10 diagnostic & reverse-engineering scripts
├── scripts/                      # 4 maintenance/diagnostic scripts (cleanup, verify, whatsapp-diag)
└── test/                         # 26 Node test scripts
```

---

## 4. Feature Implementation Status Matrix

| Feature / Area | Status | Evidence / Notes |
| :--- | :--- | :--- |
| Public Landing & Info/SEO Pages | **Implemented** | `public/home.html`, 11 info/guide/legal HTML pages, `robots.txt`, `sitemap.xml` |
| Email Registration & Verification | **Implemented** | Firebase Web SDK (`register.html`, `verify-email.html`) + `POST /api/register`, `/api/auth/verify-token` |
| Login & Legacy Migration | **Implemented** | `login.html` + `POST /api/login` + bcrypt-to-Firebase ownership gate |
| Password Reset | **Implemented** | `forgot.html` + `POST /api/forgot` + Firebase `sendPasswordResetEmail` (Note: `GET /reset` redirects to `/login`) |
| Google Sign-In | **Missing** | No `GoogleAuthProvider` or OAuth popup/redirect exists anywhere |
| Old ERP QID + CAPTCHA Relay | **Implemented** | `src/qums-login-web.js`, `src/login.js`, `public/qums-setup.html` |
| New ERP Email Login & Conflict Logout | **Implemented** | `src/new-erp-client.js`, `/api/new-erp/login`, `/api/new-erp/reconnect` |
| ERP Mutual Exclusivity (`OLD` vs `NEW`) | **Implemented** | `src/erp-session-registry.js`, `active_erp_sessions` table |
| Student Dashboard & Overall/Subject % | **Implemented** | `public/index.html`, `/api/attendance`, `/api/new-erp/attendance`, `src/calculator.js` |
| Today's Classes & Weekly Timetable | **Implemented** | `/api/today`, `/api/timetable`, `/api/new-erp/timetable`, `weekly_schedule`, `new_erp_timetable` |
| Date-Specific / Backdated Attendance Lookup | **Implemented (Telegram)** / **Missing (Web UI)** | Telegram `/DD/MM/YY` & `yesterday` work; web dashboard date-range picker JS in `index.html` lacks DOM buttons |
| Real-Time & Backdated Watcher Alerts | **Implemented** | `src/watcher.js` (`runWatcherPass`, `runMonthRegisterPass`) + `notification_log` dedupe |
| Morning 8:30 AM IST Schedule & Pre-warm | **Implemented** | `src/scheduler.js` (`08:15` pre-warm, `08:30` send, boot catch-up) |
| Assignment Tracking & 7 PM Reminders | **Partially Implemented** | Backend scraper/watcher implemented (`src/assignments.js`, `new-erp-client.js`), but Telegram alerts are disabled unless `ENABLE_ASSIGNMENTS=true` and there is **no Web Dashboard Assignments UI** |
| Telegram Deep-Link, Commands & Auto-Delete | **Implemented** | `src/telegram.js`, `scheduled_message_deletions` table |
| Telegram CAPTCHA & 1-Click Reconnect | **Implemented** | `src/telegram.js` (`QUMS_RECONNECT_WAITING_CAPTCHA`, `new_erp_1click_reconnect`) |
| Web Admin Dashboard & Excel Export | **Implemented** | `public/admin.html`, `/api/admin/*`, `xlsx` export |
| Telegram `/admin` Interactive Panel | **Partially Implemented** | `src/telegram-admin.js` (some single-user detail buttons like `adm:user_msg` / `adm:user_release_session` have no callback handler) |
| Google AdSense | **Partially Implemented** | `ads.txt`, `robots.txt`, Auto-Ads script in `home.html` only; `.ad-slot` containers across 14 pages are empty placeholders |
| Academic Sessions / Exams / Results / Fees / Circulars / Grievances / Substitutions / Profile Edit / Settings Page | **Missing** | Not implemented in QAttend; no endpoints, scrapers, UI pages, or DB tables exist for these modules |

---

## 5. Key Architectural Considerations for GUeAttend

When building **GUeAttend** independently for **Graphic Era University (GUeID)**:
1. **Replace ERP Integrations:** `src/login.js`, `src/qums-login-web.js`, `src/scraper.js`, and `src/new-erp-client.js` are tightly coupled to Quantum University's ASP.NET Cyborg portal (`qums.quantumuniversity.edu.in`) and New ERP (`my.quantumuniversity.edu.in`). GUeAttend must implement dedicated clients/parsers for Graphic Era University's portal and **GUeID** validation.
2. **Independent Credentials & Infrastructure:** Create a separate Firebase project, separate Supabase PostgreSQL database, separate Telegram Bot token/username, separate `ENCRYPTION_KEY`/`SESSION_SECRET`, and separate hosting service.
3. **Fix Observed QAttend Gaps in GUeAttend:**
   - Decide whether university passwords should truly never be stored (requiring manual password entry on reconnect) or explicitly disclosed as AES-256-GCM encrypted with per-record random salts.
   - Add Supabase RLS policies if using Supabase client SDKs, or keep strict server-side `userId` scoping.
   - Replace `innerHTML` usage in frontend templates with safe DOM construction (`textContent`) to eliminate XSS surface.
   - Add CSRF tokens for state-changing POST endpoints and convert `/logout` to POST.
   - Clean up hardcoded fallback student strings and contact emails found in `src/server.js`, `src/telegram.js`, and `public/qums-setup.html`.

