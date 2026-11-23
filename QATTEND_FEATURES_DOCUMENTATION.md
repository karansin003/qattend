# QAttend — Frontend Pages & Complete Feature Documentation

This document maps every frontend page and every feature requested in the audit, strictly distinguishing **Implemented**, **Partially Implemented**, and **Missing** functionality.

---

## 1. Complete Frontend Page Inventory (`public/`)

| Page Route | HTML File | Auth Required | Purpose |
| :--- | :--- | :--- | :--- |
| `/` | `public/home.html` | Public | Landing page, product preview, feature cards, guides links, AdSense Auto-Ads script |
| `/login` | `public/login.html` | Public | Firebase Email/Password sign-in + legacy bcrypt fallback |
| `/register` | `public/register.html` | Public | Firebase account creation + verification email trigger + backend user creation |
| `/verify-email` | `public/verify-email.html` | Soft session | Email verification gate (`Check Again`, `Resend` 60s cooldown, `Logout`) |
| `/forgot` | `public/forgot.html` | Public | DB email check + Firebase `sendPasswordResetEmail` |
| `/dashboard` | `public/index.html` | `requireAuth` | Main Student Dashboard (Old ERP & New ERP views) |
| `/qums-setup` | `public/qums-setup.html` | `requireAuth` | Dual-tab ERP connector (Old ERP CAPTCHA relay & New ERP email login) + QUMS Reset |
| `/telegram-setup` | `public/telegram-setup.html` | `requireAuth` | Telegram deep-link connection, polling status, disconnect |
| `/admin` | `public/admin.html` | `requireAdmin` | Admin Portal: metrics, system health, user table, Excel export, bulk notify, Firebase setup |
| `/features` | `public/features.html` | Public | SEO product features page |
| `/how-it-works` | `public/how-it-works.html` | Public | Technical workflow explanation page |
| `/about` | `public/about.html` | Public | Developer & project background page |
| `/faq` | `public/faq.html` | Public | Frequently asked questions page |
| `/contact` | `public/contact.html` | Public | Interactive support/contact form (`POST /api/contact`) |
| `/privacy`, `/terms` | `public/privacy.html`, `public/terms.html` | Public | Privacy Policy & Terms and Conditions |
| `/attendance-calculator-guide` | `public/attendance-calculator-guide.html` | Public | 75% math explanation + client-side interactive calculator |
| `/qums-troubleshooting` | `public/qums-troubleshooting.html` | Public | QUMS CAPTCHA & session expiry guide |
| `/telegram-guide` | `public/telegram-guide.html` | Public | Telegram commands & alerts guide |
| `/security-and-privacy` | `public/security-and-privacy.html` | Public | Security architecture explanation |

*Shared frontend chrome (`public/site.js`):* Mobile hamburger drawer (`#navToggle`, `#drawer`), active link highlighting, dynamic copyright year (`[data-year]`), and `[data-auth-swap]` (calls `GET /api/me` on public pages to replace Login/Register with "Go to Dashboard" when logged in).

---

## 2. Feature-by-Feature Deep Audit

### 2.1 Landing Page (`public/home.html`) — **Implemented**
- **Backend:** `GET /` serves `home.html`; `site.js` calls `GET /api/me` for `[data-auth-swap]`.
- **Content:** Hero section, static HTML/CSS mock dashboard preview, 8 feature cards, 4-step workflow, FAQ preview, 4 practical guide links, JSON-LD `WebSite` + `SoftwareApplication` schema, empty footer `.ad-slot`, and Google AdSense `<script>`.

### 2.2 Login & Registration (`login.html`, `register.html`, `verify-email.html`, `forgot.html`) — **Implemented**
- **Backend:** `POST /api/register`, `POST /api/login`, `POST /api/auth/verify-token`, `GET /api/auth/verification-status`, `POST /api/forgot`, `POST /api/reset`.
- **DB Tables:** `users`, `resets` (legacy).
- **Missing sub-feature:** **Google Sign-In** is not implemented. `GET /reset` redirects to `/login` (no custom reset password form).

### 2.3 Student Dashboard (`public/index.html`) — **Implemented**
- **Backend:** `/api/me`, `/api/attendance`, `/api/today`, `/api/telegram/status`, `/api/telegram/unlink`, `/api/qums-logout`, `/api/qums-reset`, `/api/new-erp/*`.
- **DB Tables:** `users`, `session_expiry_state`, `new_erp_attendance_cache`, `new_erp_timetable`.
- **Business Logic:**
  - Instant first paint on Old ERP via `localStorage.getItem('qattend_attendance_cache')`.
  - Switches UI layout based on `me.activeErpType` (`'OLD'` vs `'NEW'`).
  - Displays QUMS connection status, Telegram status, Overall Attendance %, Today's classes count, session-expired banner (with 1-Click Reconnect for New ERP), and Admin nav link if `me.isAdmin`.
  - *(Note: On load, `public/index.html` calls `loadMe()` and `loadAttendance(false)` concurrently, so `loadAttendance` may fire before `appMe` is populated even for New ERP users.)*

### 2.4 Admin Dashboard (`public/admin.html`) — **Implemented**
- See `QATTEND_ADMIN_DOCUMENTATION.md` for full details.

### 2.5 Profile Management — **Partially Implemented (Read-Only Cache + Reset)**
- **What exists:** Displays cached `studentName`, `qumsYearSem` / New ERP course, semester, academic year, and QID on `/dashboard`, `/qums-setup`, and Telegram `/status`. `scraper.refreshQumsProfile()` syncs name/yearSem from QUMS on setup and every `6h` (`QUMS_PROFILE_TTL_MS`). `POST /api/qums-reset` disconnects and clears QUMS profile fields.
- **What is missing:** No user-editable profile page, no password change UI for logged-in users, no self-service QAttend account deletion UI.

### 2.6 Attendance Dashboard & Subject-Wise Attendance — **Implemented**
- **Old ERP:** `GET /api/attendance` -> `scrapeAttendance()` -> `analyzeAttendance()` renders summary chips (`Subjects`, `Below 75%`, `OK (>=75%)`, `Overall`, `Period`) and subject table (`Subject`, `Code`, `Attended`, `%`, `Status`, `Guidance`).
- **New ERP:** `GET /api/new-erp/attendance` renders 4 metric cards (`Total Conducted`, `Total Attended`, `Total Absent`, `Overall Percentage`), summary chips, and subject table. Includes `openSubjectDetails(subjectName, courseId, pbsm)` modal (`GET /api/new-erp/subject-attendance`) showing per-lecture date, time, faculty, and status (`Present`, `Absent`, `Not Marked`).

### 2.7 Today's Attendance & Today's Classes — **Implemented**
- **Web Dashboard:** Clicking **"Load today's classes"** calls `GET /api/today`.
  - Old ERP: scrapes `GetTodayAttendance`, enriches room/teacher from `scrapeTimetable()` via `mergeScheduleWithRoom()`, renders list.
  - New ERP: switches to Timetable tab and shows `todayClasses` from `new_erp_timetable` / `scrapeNewErpTimetable()`.
- **Telegram:** `/today` (and keywords `today`, `classes`, `timetable`, `aaj ki class`) returns `formatTodayAttendanceStatus()` with Present/Absent/Not Marked breakdown.
- **Real-time Watcher (`src/watcher.js`):** Polls `scrapeTodaysAttendance` (Old ERP) or `scrapeNewErpSubjectLectures` (New ERP) every `WATCH_INTERVAL_MINUTES` (default 5 min, `.env` sets 2 min) during `08:30–17:00 IST`. Sends Telegram alerts on `unmarked -> present/absent` or status changes (`P -> A`).

### 2.8 Monthly Attendance Register & Backdated Attendance Retrieval — **Implemented (Backend + Telegram)** / **Incomplete (Web UI)**
- **Backend Watcher (`src/watcher.js`):** Runs every `MONTH_REGISTER_INTERVAL_MINUTES` (default 10 min, `.env` sets 5 min) 24/7 using a **3-tier scan plan** (`monthsToScanNow`):
  - **Tier 1:** Current month every cycle.
  - **Tier 2:** Previous month every `MONTH_REGISTER_RECENT_EVERY_CYCLES` cycles (default 2).
  - **Tier 3:** Older months (`2..MONTH_REGISTER_MONTHS_BACK`, default 5) every `MONTH_REGISTER_OLDER_EVERY_HOURS` (default 6h).
  - Compares against `known_attendance` via `monthRegisterDiff()` and ignores any `class_date < monitoring_started_date`.
- **Telegram Date Lookup (`src/telegram.js`):** Students can send `/DD/MM/YY`, `/DD-MM-YYYY`, `yesterday`, or `kal` to retrieve attendance for any calendar date (live `scrapeMonthRegister` + `known_attendance` offline fallback, or `new_erp_attendance_cache` for New ERP).
- **Web Dashboard Gap:** `public/index.html` contains JS handlers for a two-month date-range picker (`#toggleDatePickerBtn`, `#newErpDatePickerBox`) and horizontal date slider (`#sliderCardsWrapper`), **but the corresponding HTML elements are absent from `public/index.html`**, so date-filtered/monthly register viewing is not accessible in the web UI.

### 2.9 Attendance Percentage Calculations (`src/calculator.js` & `src/new-erp-client.js`) — **Implemented**
- **Threshold:** `REQUIRED_PERCENTAGE = 75`.
- **Below 75% (Consecutive classes needed):**
  - Formula: `ceil((0.75 * total - attended) / 0.25)`, clamped to `Math.max(1, needed)` whenever `displayPct < 75` so rounding never tells a student `0` classes are needed.
- **At/Above 75% (Classes safely skippable):**
  - Formula: `floor((attended - 0.75 * total) / 0.75)`, clamped to `>= 0`.
- **Overall %:** Prefers official `st.TotalPercentage` (Old ERP) or `.item_value` / `data-progress` (New ERP); falls back to weighted `(sum(attended) / sum(conducted)) * 100`.
- **Not Marked Policy:** `Not Marked` (`N.M.` / `N`) is **never** counted as `Absent`.
- **Public Interactive Calculator:** `public/attendance-calculator-guide.html` provides a standalone client-side calculator using the exact same formulas.

### 2.10 Timetable — **Implemented**
- **Old ERP:** `GET /api/timetable` scrapes `FillStudentTimeTable` (or jqGrid DOM fallback), normalizes weekdays (`formatNormalizedTimetable`), caches 10 min in memory; `weekly_schedule` caches 7 days for morning Telegram messages (`08:30 AM IST`).
- **New ERP:** `GET /api/new-erp/timetable` scrapes `/Student/Academic` + `GetWeekCalendarStudentData`, caches in `new_erp_timetable`, renders **Today's Schedule** cards and **Weekly View** table in `public/index.html`.

### 2.11 Upcoming Classes — **Missing (No Dedicated Filter)**
- QAttend shows **Today's Classes** (full day) and **Weekly Timetable**, plus sends the **8:30 AM IST Morning Schedule**; there is no "next upcoming class right now" countdown or time-filtered upcoming-class widget.

### 2.12 Assignments — **Partially Implemented**
- **Implemented:**
  - Old ERP scraper (`scrapeAssignments` via `GetStudentAssignment`) and New ERP scraper (`scrapeNewErpAssignments` via `GetMyAssessmentsData` + `GetMyAssignmentsData`).
  - Background watcher & 7:00 PM IST deadline reminder (`src/assignments.js`), persisted in `known_assignments` and `assignments`. Auto-deletes Telegram assignment message when `uploadFlag === 1`.
  - Telegram `/assignments` command works.
- **Gaps / Incomplete:**
  - Automatic Telegram assignment notifications & 7:00 PM reminders are **disabled by default** unless `ENABLE_ASSIGNMENTS=true` (`src/assignments.js` lines 147, 301, 314).
  - `/api/new-erp/assessments` exists in `src/server.js`, **but there is no Assignments tab or UI on `public/index.html`** for either Old ERP or New ERP.

### 2.13 Notifications — **Implemented (Telegram-Only)**
- Delivered exclusively via Telegram Bot (`src/telegram.js`, `src/alerts.js`, `src/watcher.js`, `src/scheduler.js`, `src/assignments.js`, `src/catchup.js`). Logged in `notifications` and deduplicated in `notification_log`. No in-app web notification bell or email notifications exist.

### 2.14 Settings — **Partially Implemented**
- No dedicated `/settings` page exists. Configuration is split across `/qums-setup` (switch Old/New ERP, disconnect/reset QUMS) and `/telegram-setup` (connect/disconnect Telegram).

### 2.15 Missing / Non-Existent Modules
The following modules from Phase 5 **do NOT exist anywhere in QAttend**:
- **Class substitutions** (no scraping or tracking of substitute teachers)
- **Academic sessions** (semester is auto-detected from `1..8` on Old ERP or read from New ERP profile; no multi-session switcher/CRUD)
- **Examination management** (no exam schedule, admit card, or seating scraping)
- **Results** (no marks/CGPA/SGPA/transcript scraping)
- **Fees** (no fee ledger/receipt/due scraping)
- **Circulars** (no university notice/circular scraping)
- **Grievances** (no student grievance submission or ERP grievance integration; only `/contact` exists)

