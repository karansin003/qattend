# QAttend — Complete API & Route Documentation

All HTTP routes are defined in `src/server.js`. Static assets are served from `public/` via `express.static(PUBLIC_DIR, { maxAge: IS_PROD ? '1d' : 0, etag: true })`. Any unmatched `/api/*` request returns `404 { error: "Unknown API route: <METHOD> <URL>" }` so API clients never receive HTML.

---

## 1. Middleware & Rate Limiting (`src/server.js`)

| Middleware | Scope | Behavior |
| :--- | :--- | :--- |
| `express.urlencoded({ extended: false })` | Global | Form body parsing |
| `express.json()` | Global | JSON body parsing |
| `express-session` + `FileStore` | Global | Cookie `connect.sid`, 90d TTL, `httpOnly`, `sameSite: 'lax'`, `secure: IS_PROD` |
| `requireAuth` | Protected pages & APIs | Checks `req.session.userId` → `401 AUTH_REQUIRED` (API) / `302 /login` (page); `user.isSuspended` → clears session, `403 ACCOUNT_SUSPENDED`; `!user.emailVerified` → `403 EMAIL_VERIFICATION_REQUIRED` / `302 /verify-email` |
| `requireAdmin` | `/admin`, `/api/admin/*` | Same checks as `requireAuth` + `isUserAdmin(user)` (`user.isAdmin \|\| ADMIN_EMAILS`) → `403 ADMIN_REQUIRED` |
| `rateLimit(route)` | Auth & contact POSTs | In-memory IP+route sliding window (`15 min`): `/api/login` (`20`), `/api/register` (`10`), `/api/forgot` (`5`), `/api/reset` (`10`), `/api/auth/verify-token` (`30`), `/api/contact` (`10`) |

### Error Status Mapping (`httpStatusFor(err)`)
- `ConcurrentLoginError` → `429`
- `QumsSetupRequired` → `403`
- `SessionExpiredError`, `NoSessionError`, `NewErpSessionExpiredError`, `SessionConflictError`, `SessionExclusivityError`, `NoPendingLogin`, `TelegramNotLinked` → `409`
- `NewErpAuthError` → `401`
- `QumsCredsMissing`, `QumsCredsRequired` → `400`
- `ScrapeError`, `NewErpPortalError` → `502`
- Default → `500`

---

## 2. HTML Page Routes

| Method | Path | Middleware | File Served / Behavior |
| :--- | :--- | :--- | :--- |
| `GET` | `/` | Public | `public/home.html` |
| `GET` | `/register`, `/login`, `/forgot` | Public | `public/register.html`, `public/login.html`, `public/forgot.html` |
| `GET` | `/verify-email` | Public | Redirects to `/dashboard` or `/qums-setup` if already verified, else `public/verify-email.html` |
| `GET` | `/reset` | Public | Redirects `302` to `/login` (no `reset.html` exists) |
| `GET` | `/features`, `/how-it-works`, `/about`, `/faq`, `/privacy`, `/terms` | Public | Corresponding static `.html` files in `public/` |
| `GET` | `/contact` | Public | `public/contact.html` with `withContactEmail()` placeholder injection |
| `GET` | `/attendance-calculator-guide`, `/guides/attendance-calculator` | Public | `public/attendance-calculator-guide.html` |
| `GET` | `/qums-troubleshooting`, `/guides/qums-troubleshooting` | Public | `public/qums-troubleshooting.html` |
| `GET` | `/telegram-guide`, `/guides/telegram-guide` | Public | `public/telegram-guide.html` |
| `GET` | `/security-and-privacy`, `/guides/security-and-privacy` | Public | `public/security-and-privacy.html` |
| `GET` | `/dashboard` | `requireAuth` | `public/index.html` + `withQumsResetControl()` injected script |
| `GET` | `/qums-setup` | `requireAuth` | `public/qums-setup.html` + `withQumsResetControl()` injected script |
| `GET` | `/telegram-setup` | `requireAuth` | `public/telegram-setup.html` |
| `GET` | `/admin` | `requireAdmin` | `public/admin.html` |
| `GET` | `/logout` | Public | Destroys Express session (`req.session.destroy`) → `302 /login` |

---

## 3. Public & Authentication APIs

### `POST /api/register`
- **Auth / Limit:** Public, `rateLimit('/api/register')` (10 / 15m).
- **Body:** `{ email, idToken }` (Firebase path) OR `{ email, password, firebaseUnavailable: true }` (fallback).
- **Behavior:** Validates email, rejects existing email (`409`). Verifies `idToken` via `firebaseAuth.verifyIdToken()`, creates user in `users`, sets `req.session.userId`.
- **Response (`200`):** `{ ok: true, emailVerified: boolean, redirect: '/verify-email' | '/qums-setup' | '/dashboard' }`.

### `POST /api/login`
- **Auth / Limit:** Public, `rateLimit('/api/login')` (20 / 15m).
- **Body:** `{ email, idToken, password? }` (Firebase path) OR `{ email, password }` (legacy bcrypt fallback).
- **Behavior:** Verifies ID token and resolves/links `users` row (enforces bcrypt or `emailVerified` proof before linking an unmapped legacy row, else `403 MIGRATE_PASSWORD`). Blocks suspended accounts (`403 ACCOUNT_SUSPENDED`). Sets `req.session.userId`.
- **Response (`200`):** `{ ok: true, emailVerified: boolean, redirect }`.

### `POST /api/auth/verify-token`
- **Auth / Limit:** Public, `rateLimit('/api/auth/verify-token')` (30 / 15m).
- **Body:** `{ idToken }`.
- **Behavior:** Verifies JWT; requires `verified.emailVerified === true` (else `400`). Marks `users.email_verified = TRUE` and sets `req.session.userId`.
- **Response (`200`):** `{ ok: true, emailVerified: true, redirect }`.

### `GET /api/auth/verification-status`
- **Auth:** Public (reads `currentUser(req)`).
- **Response (`200`):** `{ loggedIn, email, emailVerified, redirect? }`.

### `POST /api/forgot`
- **Auth / Limit:** Public, `rateLimit('/api/forgot')` (5 / 15m).
- **Body:** `{ email }`.
- **Behavior:** Checks if email exists in `users` (`404` if unregistered). Does not send email directly; frontend calls Firebase `sendPasswordResetEmail()` on `200`.
- **Response (`200`):** `{ ok: true, registered: true, firebaseLinked: boolean, message }`.

### `POST /api/reset` *(Legacy)*
- **Auth / Limit:** Public, `rateLimit('/api/reset')` (10 / 15m).
- **Body:** `{ token, password }`.
- **Behavior:** Consumes legacy SHA-256 token from `resets` table and updates bcrypt `password_hash`.

### `POST /api/contact`
- **Auth / Limit:** Public, `rateLimit('/api/contact')` (10 / 15m).
- **Body:** `{ name, email, subject?, message, category? }`.
- **Behavior:** Validates `name >= 2`, valid `email`, `message >= 10`. Logs message and forwards via Resend (`src/mailer.js`) if `RESEND_API_KEY` is configured.
- **Response (`200`):** `{ ok: true, message }`.

### `GET /health`
- **Auth:** Public (secret-free for Render health checks).
- **Response (`200`):** `{ ok: true, status: 'ok', uptimeSeconds, timestamp }`.

---

## 4. Protected Student & Old ERP APIs (`requireAuth`)

### `GET /api/me`
- **Behavior:** Restores session files on disk if missing (`ensureSessionOnDisk`, `ensureNewErpSessionOnDisk`), checks expiry state (`session_expiry_state`), triggers background `ensureStudentName` if `studentName` is empty, returns non-secret user profile & ERP/Telegram/Admin status.
- **Response (`200`):** `{ email, studentName, qumsYearSem, qumsQid, qumsConfigured, qumsSessionStatus, qumsCredentialsSaved, activeErpType, newErpConfigured, newErpEmail, newErpStudentName, newErpQid, newErpAcademicYear, newErpSemester, newErpCourse, newErpSessionStatus, newErpCredentialsSaved, telegramConnected, telegramConfigured, isAdmin }`.
  *(Audit Note: `src/server.js` lines 809–832 apply hardcoded fallback strings when New ERP fields are empty/malformed.)*

### `GET /api/attendance`
- **Query:** `?fresh=1` (or `refresh=1` / `force=1`), `?total=<number>` (override fallback total classes).
- **Cache:** In-memory `attendanceCache` (`2 min` TTL per `userId`, bypassed when `forceFresh` or `overrideTotal`).
- **Behavior:** Calls `scraper.scrapeAttendance()` → `calculator.analyzeAttendance()`. Clears stale expiry on success; marks `qums_session_status = 'expired'` + triggers `maybeNotifySessionExpired` on `SessionExpiredError`.
- **Response (`200`):** `{ generatedAt, requiredPercentage: 75, totalClassesAssumed, subjects[], overall, period, summary, _cached?, _cachedAt? }`.

### `GET /api/today`
- **Query:** `?fresh=1` (or `refresh=1` / `force=1`).
- **Behavior:**
  - If `activeErpType === 'NEW'`: Reads `db.getNewErpTimetable()` or scrapes `newErpClient.scrapeNewErpTimetable()`, filters to current IST weekday.
  - If `OLD`: Uses `todayCache` (`2 min` TTL) or calls `scrapeTodaysAttendance()` + enriches rooms/teachers from `scrapeTimetable()` via `mergeScheduleWithRoom()`.
- **Response (`200`):** `{ date, periods: [{ period, duration, subject, subjectCode, employee, room, attendance?, status?, key? }], _cached? }`.

### `GET /api/timetable`
- **Query:** `?fresh=1` (or `refresh=1` / `force=1`).
- **Cache:** `timetableCache` (`10 min` TTL).
- **Behavior:** Scrapes Old ERP timetable (`scrapeTimetable`), formats via `formatNormalizedTimetable()`. Falls back to stale cache with `_stale: true` if portal is unreachable.
- **Response (`200`):** `{ success: true, updatedAt, hasData, timetable: { days: [{ day, classes, periods }] } }`.

### `ALL /api/trigger-telegram`
- **Behavior:** Scrapes Old ERP attendance, formats report (`formatAttendanceMessage`), sends immediately to user's Telegram chat (`sendMessage`).
- **Response (`200`):** `{ success: true, sentTo, preview }`.

### `POST /api/qums-login/start`
- **Body:** `{ qid?, password?, confirmSwitch? }`.
- **Behavior:** Calls `qumsLogin.startQumsLogin()`. Returns `409 { identityConflict: true, oldQid, newQid }` if switching QIDs without `confirmSwitch`, or `409` if blocked by New ERP active session, or `429` if concurrent login limit reached.
- **Response (`200`):** `{ ok: true, captchaImage }` (base64 PNG data URL).

### `POST /api/qums-login/submit-captcha`
- **Body:** `{ captchaText }` (or `{ captcha }`).
- **Behavior:** Calls `qumsLogin.submitQumsCaptcha(userId, text, console, { source: 'web' })`. On success, invalidates caches and triggers `runBaselineForUser`.
- **Response (`200`):** `{ ok: true, sessionPath, studentName, yearSem }` or `{ ok: false, code, error, captchaImage }`.

### `POST /api/qums-reset`
- **Behavior:** Invalidates caches, unlinks Old ERP session file on disk, releases all active ERP registry locks, clears `qumsQid`, `qumsPasswordEncrypted`, `qumsSessionPath`, `studentName`, `qumsYearSem`, sets `qumsSessionStatus: 'disconnected'`, deactivates `qums_identities`, clears session expiry alerts.
- **Response (`200`):** `{ ok: true, redirect: '/qums-setup', message }`.

### `POST /api/qums-logout`
- **Behavior:** Invalidates caches, deletes Old ERP session file on disk, releases ERP registry lock, sets `qumsSessionPath: ''`, `qumsSessionStatus: 'disconnected'`. Retains `qumsQid` & `qumsPasswordEncrypted` for CAPTCHA-only reconnect.
- **Response (`200`):** `{ ok: true, message }`.

---

## 5. Protected New ERP & ERP Switch APIs (`requireAuth`)

| Method | Path | Rate Limit | Purpose & Behavior |
| :--- | :--- | :--- | :--- |
| `POST` | `/api/new-erp/login` | `rateLimit('/api/login')` | Body: `{ email, password, logoutOtherSessions }`. Enforces `checkSessionEligibility(..., 'NEW')`. Calls `newErpClient.loginNewErp()`. Saves session file + encrypted `newErpSessionData` + encrypted `newErpPasswordEncrypted` + profile fields, acquires `'NEW'` session lock. Returns `409 PORTAL_ACTIVE_SESSION_CONFLICT { canLogoutAll: true }` if portal reports another active session. |
| `POST` | `/api/new-erp/disconnect` | — | Deletes New ERP session file, clears `newErpSessionPath`/`newErpSessionData`, sets `newErpSessionStatus: 'disconnected'`, `activeErpType: 'OLD'`, releases registry lock. |
| `POST` | `/api/erp/switch` | — | Body: `{ targetErp: 'OLD' \| 'NEW' }`. Releases current registry locks and updates `users.active_erp_type`. |
| `GET` | `/api/new-erp/timetable` | — | Query: `?fresh=1`. Serves from `new_erp_timetable` unless `fresh=1`; scrapes `/Student/Academic`, updates DB, falls back to stale cache on expiry/conflict while marking session expired and notifying Telegram. |
| `GET` | `/api/new-erp/attendance` | — | Query: `?fresh=1&startDate=YYYY-MM-DD&endDate=YYYY-MM-DD`. Serves from `new_erp_attendance_cache` when unfiltered & not fresh; scrapes `/Student/Academic/StudentAttendance` + lecture logs; updates profile cache; falls back to stale cache on error. |
| `GET` | `/api/new-erp/subject-attendance` | — | Query: `?courseId=...&pbsm=...&startDate=...&endDate=...`. Calls `scrapeNewErpSubjectLectures()`. |
| `GET` | `/api/new-erp/assessments` | — | Calls `scrapeNewErpAssignments()` (fetches `GetMyAssessmentsData` + `GetMyAssignmentsData`). |
| `POST` | `/api/new-erp/reconnect` | — | Re-authenticates New ERP using `req.body.password` or decrypted `newErpPasswordEncrypted` with `logoutOtherSessions: true`. Updates session, clears alerts, notifies Telegram. |

---

## 6. Protected Telegram APIs (`requireAuth`)

| Method | Path | Purpose & Response |
| :--- | :--- | :--- |
| `GET` | `/api/telegram/status` | Generates/fetches `telegramLinkCode` and returns `{ configured, connected, botUsername, linkUrl }`. |
| `POST` | `/api/telegram/unlink` | Clears `users.telegram_chat_id` and returns `{ ok: true, message }`. |

---

## 7. Protected Admin APIs (`requireAdmin`)

| Method | Path | Purpose & Behavior |
| :--- | :--- | :--- |
| `GET` | `/api/admin/users` | Query: `search`, `filter`, `qumsFilter`, `telegramFilter`, `reconnectFilter`, `statusFilter`, `page` (`1`), `limit` (`25`, clamped `5..100`). Returns `{ total, allTotal, page, pages, perPage, users }` using `safeAdminUser()` (no secrets/hashes). |
| `GET` | `/api/admin/users/all-ids` | Query: `search`, `filter`. Returns `{ ok: true, count, userIds }`. |
| `GET` | `/api/admin/export/excel` | Same 6 filter params as `/api/admin/users`. Generates 2-sheet `.xlsx` workbook (`Users`, `Summary & Metrics`) via `XLSX` and streams binary download. |
| `GET` | `/api/admin/health` | Returns DB ping/mode, Telegram state, `scheduler`, `watcher`, `assignments` statuses, `firebaseAdmin.configured`, and user/reconnect/notification stats. |
| `POST` | `/api/admin/users/:id/suspend` | Body: `{ suspended?: boolean }`. Blocks self-suspension (`400`). Sets `is_suspended`. |
| `POST` / `DELETE` | `/api/admin/users/:id/delete` & `/api/admin/users/:id` | Blocks self-deletion (`400`). Releases ERP sessions, unlinks session/dedupe files, deletes from Firebase Auth/Firestore/RTDB (`firebaseAuth.deleteFirebaseUser`), deletes all rows across all PostgreSQL tables (`db.deleteUser`). |
| `POST` | `/api/admin/firebase-credentials` | Body: `{ serviceAccountJson }`. Parses raw or base64 JSON, stores in `system_settings` (`firebase_service_account_key`), hot-reloads `firebase-admin`. |
| `POST` | `/api/admin/firebase-users/delete` | Body: `{ email?, uid? }`. Directly deletes a user from Firebase Auth/Firestore/RTDB. |
| `POST` | `/api/admin/users/bulk-reconnect-notify` | Body: `{ userIds: string[] }` (max `1000`). Dispatches Telegram expiry/reconnect prompts at `100ms` pacing; returns `{ ok, sent[], skipped[], failed[], totalRequested }`. |

