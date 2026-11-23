# QAttend — Deployment, Infrastructure & SEO/AdSense Guide

This document describes how QAttend is configured, started, monitored, and deployed in development and production, plus its SEO and Google AdSense setup.

---

## 1. Hosting & Infrastructure Overview

- **Application Host:** **Render** (`https://qattend.onrender.com`, detected via `process.env.RENDER` and `process.env.RENDER_EXTERNAL_URL`).
  - No `render.yaml`, `Dockerfile`, or `.github/workflows` exist in the repository; deployment relies on Render's dashboard Git integration and `package.json` scripts (`npm install` + `npx playwright install chromium` + `npm start`).
- **Database Host:** **Supabase PostgreSQL** connected via `DATABASE_URL` (`pg` Pool, TLS enabled).
- **Auth Provider:** **Firebase Authentication** (`qums-forgot-password-test`).
- **Bot Platform:** **Telegram Bot API** (long polling via `node-telegram-bot-api`).
- **Email Provider (Optional/Legacy):** **Resend** (`RESEND_API_KEY`) for `/api/contact` forwarding.

---

## 2. Startup & Runtime Architecture (`src/server.js`)

When `npm start` (`node src/server.js`) executes:
1. **`await db.init()`:** Connects `pg.Pool` (if `DATABASE_URL` is set) and runs idempotent migrations `001`–`022` in `src/migrations.js` (plus `900` if `DROP_QUMS_PASSWORD_COLUMN=1`). Note: `IMPORT_JSON_DATA=1` is required to import `data/db.json` into an empty Postgres DB.
2. **`startScheduler()`:** Arms `node-cron` jobs in `Asia/Kolkata`:
   - `08:15 AM IST` (`MORNING_PREWARM_CRON`): Cache pre-warm.
   - `08:30 AM IST` (`MORNING_CRON`, `recoverMissedExecutions: true`): Morning timetable push.
3. **`startWatcher()`:** Arms background monitoring loops:
   - Fast Today's Attendance (`setInterval` every `WATCH_INTERVAL_MINUTES`, active `08:30–17:00 IST`).
   - Tiered Month-Register Backdated loop (`setInterval` every `MONTH_REGISTER_INTERVAL_MINUTES`, 24/7).
   - Assignment watcher (`ASSIGNMENT_INTERVAL_MINUTES` poll + `0 19 * * *` 7:00 PM IST deadline cron; sends only if `ENABLE_ASSIGNMENTS=true`).
4. **`telegram.initTelegram()`:** Acquires `data/telegram-polling.lock`, starts Telegram polling (unless `TELEGRAM_POLLING=off`), and runs `restoreScheduledDeletions()` from `scheduled_message_deletions`.
5. **`catchUpMorningSchedule()`:** If server booted between `08:30` and `MORNING_LATE_SKIP_HOUR` (`11:00 IST`), sends missed morning schedules (deduped per user/day).
6. **`app.listen(PORT)`:** Listens on `process.env.PORT || 10000`.
7. **Resilience Handlers:** `process.on('unhandledRejection')` and `process.on('uncaughtException')` log errors without crashing the event loop.

---

## 3. Environment Variables Reference (Names Only)

### Core Server & Security
| Variable | Required | Default / Notes |
| :--- | :--- | :--- |
| `PORT` | Optional | `10000` in `server.js` (`.env.example` sets `3000`; Render injects `PORT`) |
| `NODE_ENV` | Recommended | `'production'` enables secure cookies and generic 500 error messages |
| `RENDER` | Auto (Render) | Sets `IS_PROD = true` automatically on Render |
| `APP_BASE_URL` | Recommended | Public HTTPS URL for Telegram inline buttons (falls back to `RENDER_EXTERNAL_URL` or `http://localhost:<PORT>`) |
| `RENDER_EXTERNAL_URL` | Auto (Render) | Fallback base URL |
| `SESSION_SECRET` | **Required (Prod)** | Express session signing secret |
| `ENCRYPTION_KEY` | **Required** | Secret passed to `scryptSync` for AES-256-GCM encryption of ERP passwords & session data |

### Database
| Variable | Required | Default / Notes |
| :--- | :--- | :--- |
| `DATABASE_URL` | **Required (Prod)** | Supabase PostgreSQL URI; if unset, uses `data/db.json` |
| `DATABASE_SSL` | Optional | `'disable'` \| `'verify'` \| auto |
| `PG_POOL_MAX` | Optional | `5` |
| `DB_FILE` | Optional | Custom JSON store path (tests) |
| `IMPORT_JSON_DATA` | Optional | `'1'` to import `data/db.json` into empty PG DB |
| `DROP_QUMS_PASSWORD_COLUMN` | Optional | `'1'` to run destructive migration `900` |

### Firebase & Admin
| Variable | Required | Default / Notes |
| :--- | :--- | :--- |
| `FIREBASE_PROJECT_ID` | Optional | `'qums-forgot-password-test'` |
| `FIREBASE_SERVICE_ACCOUNT_KEY` / `FIREBASE_SERVICE_ACCOUNT` / `FIREBASE_ADMIN_CREDENTIALS` | Optional | Service Account JSON (raw, base64, or path) for Admin SDK user deletion |
| `FIREBASE_CLIENT_EMAIL` + `FIREBASE_PRIVATE_KEY` | Optional | Alternative Admin SDK credentials |
| `GOOGLE_APPLICATION_CREDENTIALS` | Optional | Path to service account JSON |
| `ADMIN_EMAILS` | Recommended | Comma-separated admin emails |

### University ERP & Playwright
| Variable | Required | Default / Notes |
| :--- | :--- | :--- |
| `QUMS_LOGIN_URL` | Optional | `https://qums.quantumuniversity.edu.in/` |
| `QUMS_DASHBOARD_URL` | Optional | `.../Web_StudentAcademic/Cyborg_S_Dashboard` |
| `QUMS_TIMETABLE_URL` | Optional | `.../Web_StudentAcademic/Cyborg_StudentTimeTable?id=Time%20Table` |
| `QUMS_ASSIGNMENT_URL` | Optional | `.../Web_StudentAcademic/Cyborg_StudentAssignment?id=Assignment` |
| `QUMS_CURRENT_YEARSEM` | Optional | Fallback Year/Sem (`1..8`) if auto-probe fails |
| `QUMS_PROFILE_TTL_MS` | Optional | `21600000` (6 hours) |
| `NEW_ERP_BASE_URL` | Optional | `https://my.quantumuniversity.edu.in` |
| `MAX_CONCURRENT_PENDING` | Optional | `15` (max concurrent Chromium CAPTCHA sessions) |
| `MAX_CONCURRENT_LAUNCHES` | Optional | `6` |
| `QUMS_QID` / `QUMS_PASSWORD` | CLI Only | Single-user CLI fallback (`npm run scrape`) |

### Telegram & Schedulers
| Variable | Required | Default / Notes |
| :--- | :--- | :--- |
| `TELEGRAM_BOT_TOKEN` | Recommended | BotFather token (disabled if omitted) |
| `TELEGRAM_BOT_USERNAME` | Recommended | `'qums_attendance_bot'` |
| `TELEGRAM_POLLING` | Optional | `'off'` / `'false'` / `'0'` for send-only workers |
| `TELEGRAM_POLLING_LOCK` | Optional | Lockfile path (`data/telegram-polling.lock`) |
| `WATCH_INTERVAL_MINUTES` | Optional | `5` (`.env.example`: `2`) |
| `WATCHER_CONCURRENCY` | Optional | `2` (defined in `watcher.js`, though `runWatcherPass` iterates sequentially) |
| `MONTH_REGISTER_INTERVAL_MINUTES` | Optional | `10` (`.env.example`: `5`) |
| `MONTH_REGISTER_MONTHS_BACK` | Optional | `5` (`0..11`) |
| `MONTH_REGISTER_RECENT_EVERY_CYCLES` | Optional | `2` |
| `MONTH_REGISTER_OLDER_EVERY_HOURS` | Optional | `6` |
| `MONTH_REGISTER_TIER_STATE_FILE` | Optional | `data/month_register_tier_state.json` |
| `ASSIGNMENT_INTERVAL_MINUTES` | Optional | `30` |
| `ENABLE_ASSIGNMENTS` | Optional | `'true'` to enable Telegram assignment alerts & 7 PM reminders (disabled by default) |
| `MORNING_CRON` | Optional | `'30 8 * * *'` |
| `MORNING_PREWARM_CRON` | Optional | `'15 8 * * *'` (`'off'` to disable) |
| `MORNING_LATE_SKIP_HOUR` | Optional | `11` |
| `MORNING_STATE_FILE` | Optional | `data/morning_schedule_state.json` |
| `SESSION_ALERT_COOLDOWN_MS` | Optional | `43200000` (12 hours) |
| `RECONNECT_DELETE_DELAY_MS` | Optional | `60000` (1 min) |

### Contact & Legacy Email
| Variable | Required | Default / Notes |
| :--- | :--- | :--- |
| `CONTACT_EMAIL` | Optional | Displayed on `/contact` & target for `/api/contact` |
| `RESEND_API_KEY` | Optional | Enables forwarding `/api/contact` emails via Resend |
| `RESEND_FROM` | Optional | Sender address for Resend |

---

## 4. Production vs Development Differences & Operational Caveats

1. **Render Free Tier Sleep:** Free web services spin down after inactivity, stopping `node-cron` and `setInterval` watchers and clearing ephemeral disk (`data/app-sessions/`). QAttend mitigates ERP session loss by storing encrypted `qums_session_data` and `new_erp_session_data` in Supabase and restoring them to disk on demand (`ensureSessionOnDisk`). However, **Express web sessions (`FileStore`) are not in Postgres**, so server restarts/redeploys on ephemeral disks log web users out.
2. **Single Telegram Poller Rule:** Only ONE instance may poll `getUpdates` for `TELEGRAM_BOT_TOKEN` at a time (otherwise Telegram returns `409 Conflict`).
3. **Monitoring & Logging:** Uses `console.log` / `console.error` stdout/stderr streams (captured by Render logs) + `GET /health` + `GET /api/admin/health`. No external APM (Sentry/Datadog) is integrated.

---

## 5. Google AdSense & SEO Implementation Audit

| Component | Status | Actual Implementation Details |
| :--- | :--- | :--- |
| **`public/ads.txt`** | **Implemented** | Contains `google.com, pub-6097963574439559, DIRECT, f08c47fec0942fa0` |
| **AdSense Script** | **Implemented (Home Only)** | `public/home.html` loads `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-6097963574439559` in `<head>`. Not included on other pages. |
| **Responsive Ad Units** | **Placeholder Only** | 14 HTML pages (`home.html`, `index.html`, `telegram-setup.html`, and all 11 info/guide/legal pages) contain `<aside class="ad-slot"><div class="ad-slot-body" data-ad-slot="qattend-footer"></div></aside>` styled responsively in `public/style.css` (lines 1970–2108), **with no `<ins class="adsbygoogle">` tags inside**. |
| **`public/robots.txt`** | **Implemented** | Explicitly allows `Mediapartners-Google` and `Google-Display-Ads-Bot`; allows `/` for `*`; disallows `/api/`, `/dashboard`, `/qums-setup`, `/telegram-setup`, `/admin`, `/logout`, `/reset`; declares `Sitemap: https://qattend.onrender.com/sitemap.xml`. |
| **`public/sitemap.xml`** | **Implemented** | Lists 12 public URLs (`/`, `/features`, `/how-it-works`, `/about`, `/faq`, `/contact`, `/attendance-calculator-guide`, `/qums-troubleshooting`, `/telegram-guide`, `/security-and-privacy`, `/privacy`, `/terms`). |
| **Site Verification** | **Implemented** | `public/google8e16ee4aea8f0348.html` + meta tags in `home.html` and `index.html`. |
| **SEO Meta & JSON-LD** | **Implemented** | All 12 public pages have `<meta name="description">`, OpenGraph (`og:title`, `og:description`, `og:type`, `og:site_name`), `<link rel="canonical">`, and JSON-LD structured data on main content pages. Auth/app pages (`login`, `register`, `verify-email`, `dashboard`, `qums-setup`, `telegram-setup`, `admin`) set `<meta name="robots" content="noindex" />`. |
| **Privacy & Terms** | **Implemented** | Comprehensive `public/privacy.html` and `public/terms.html` linked from footers and `sitemap.xml`. |

