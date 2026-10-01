# QAttend 🎓🔔

**QAttend — Track. Alert. Stay Updated.**

A full-stack, multi-user attendance and assignment monitoring system for the
**Quantum University Management System (QUMS)**. Each user connects their own
QUMS account; QAttend monitors attendance (including *backdated* Month Register
changes), tracks assignments, sends user-specific Telegram notifications, and
provides a responsive web dashboard plus a public website.

## 🌐 Live Demo

> Replace this URL with your current Render URL if it has changed.

**Live App:** https://attendence-tracker-9nkf.onrender.com

---

## ✨ Overview

QAttend makes university attendance management simple and automated.

Instead of repeatedly logging into QUMS and checking attendance manually, users
connect their QUMS account once and let QAttend monitor everything in the
background — with complete per-user isolation.

### Main Features

- 📊 Live attendance dashboard
- 🎯 75% attendance requirement calculator
- 📱 Telegram notifications (per-user, English)
- ⚡ Per-class attendance alerts
- 🔔 Backdated Month Register monitoring (new **and** changed records)
- 📚 Assignment monitoring + 7:00 PM IST deadline reminder
- 🔐 Manual-captcha QUMS login / one-tap **Reconnect QUMS** when a session expires
- 🏫 Timetable and room information
- 🌅 8:30 AM IST "Today's Classes" alert
- 🌙 Manual attendance summary (no automatic nightly summary)
- 👥 Strict multi-user isolation (own QUMS session, own dedupe state, own chat)
- 🔐 Encrypted QUMS credentials (AES-256-GCM)
- 📱 Responsive mobile UI + small, non-intrusive ad slot

---

# 🚀 Features

## 📊 Attendance Dashboard

The dashboard displays subject-wise attendance:

- Subject name
- Subject code
- Total classes
- Attended classes
- Absent classes
- Current attendance percentage
- Classes required to reach 75%
- Classes that can be missed while maintaining 75%

### 75% Attendance Formula

```text
Attendance % = (Attended Classes / Total Classes) × 100
```

If attendance is below 75%, the application calculates the number of consecutive classes required to reach 75%.

---

# 📱 Telegram Integration

Users can connect their Telegram account directly from the dashboard.

### Connection Flow

```text
Register/Login
      ↓
Connect QUMS
      ↓
Connect Telegram
      ↓
Open Telegram Bot
      ↓
/start <unique-link-code>
      ↓
Telegram Account Connected
```

One Telegram bot can serve multiple users while keeping each user's notifications isolated.

---

# ⚡ Real-Time Attendance Alerts

The system continuously checks for attendance changes.

When a new attendance update is detected, Telegram can notify the user with:

- Subject
- Attendance status
- Current percentage
- Updated attended/total classes
- Attendance impact

Example:

```text
📚 Attendance Update

Subject: Advanced Machine Learning
Status: PRESENT

Attendance:
8 / 10 = 80%

✅ Attendance is above 75%
```

Deduplication logic helps prevent repeated notifications for the same event.

---

# ⏰ Automated Notifications

## 🌅 Morning Schedule

Today's classes (time + room + teacher) are sent every day at:

```text
8:30 AM IST (cron `30 8 * * *`, timezone `Asia/Kolkata`)
```

Reliability rules:

- The server log prints the exact delivery time, e.g.
  `[scheduler] morning schedule 2026-09-24 08:30:05 IST — 1/1 user(s) pending`.
- If the process was asleep/stalled during the 8:30 minute, the missed run fires as
  soon as it resumes (`recoverMissedExecutions: true`).
- A pre-warm run at 08:15 IST builds today's timetable cache first, so the 8:30 message
  goes out immediately even when the cache is cold (a live scrape could otherwise delay
  the message by minutes).
- If the server was not running at 8:30 at all, it catches up on boot (08:30–11:00 IST).
- After 11:00 IST a late/recovered run is skipped, so a stale timetable is never sent.
- Exactly one message per user per day (`data/morning_schedule_state.json` marker), so a
  restart or a duplicate instance cannot send it twice. A failed send is not marked, so
  it retries on the next run.
- Manual trigger (`--now --morning` or the dashboard button) always sends — it ignores
  the once-per-day marker.

Optional overrides:

```env
MORNING_CRON=30 8 * * *        # change the delivery time (validated cron, IST)
MORNING_LATE_SKIP_HOUR=11      # late/catch-up runs after this IST hour are skipped
MORNING_PREWARM_CRON=off       # disable the 08:15 cache pre-warm
```

## 🌙 Daily Summary

The 9 PM summary is **manual** now (dashboard → "Send Attendance Summary").
No automatic 9 PM cron is armed.

---

# 👤 Student name (verified live)

The student's display name comes from QUMS — never from the email, a hardcoded
value or a manually typed dashboard field.

```text
POST /Web_StudentAcademic/GetStudentDetailOnRegID
form: { RegID }
-> { state: "[{ RegID, StudentID, EnrollmentNo, StudentName, ... }]" }
```

Verified live: the name field is **`StudentName`** (e.g. `"KARAN KUMAR"`).

Endpoints that do **not** provide the name (checked live, so nothing is assumed):

| Endpoint | Live result |
| -------- | ----------- |
| `GetStudentTileData` (POST `RegID`) | only `AttendPer, DueAmount, CreditAmount, CompanyVisit, placeStudent, ObtainMarks, Totalmarks, Result, CGPA, BackCount, FeeSession` — **no name field** |
| `GET /Account/Cyborg_StudentMenu` | HTML page (no student-name field) |

Storage and flow:

```text
QUMS (StudentName)
   ↓  ensureStudentName() / fetchStudentName()   [2 requests, light path]
users.student_name  (PostgreSQL or data/db.json — per user)
   ↓
Dashboard greeting  "Hello Karan Kumar 👋"
   ↓
Telegram connect    "✅ Connected! / Hello Karan Kumar 👋"
```

- After a successful QUMS setup/reconnect the name is captured automatically.
- Accounts created **before** name capture get a lazy **background backfill**
  when they open the dashboard (`/api/me`) and when they link Telegram — the
  fetch never blocks a response and never throws.
- Emails stay internal (authentication, database, password reset, server logs)
  and are never shown as the visible identity in the dashboard or Telegram.

---

# 🗓️ Backdated Attendance Detection

QUMS teachers can update attendance for a class that already happened — e.g. a
class on **22 September** marked **Absent** may later be changed to **Present**.
QAttend detects that historical change.

## Verified QUMS Month Register API

The Month Register UI (month dropdown + **View** button) calls:

```text
POST /Web_StudentAcademic/GetMonthRegister
form: { RegID, Month }        # Month = 1..12
-> { state: "<json rows>", data: "<json summary>" }
```

Response structure (re-verified against the live portal):

```jsonc
// state — one row per SUBJECT, day-of-month columns:
[{ "Subject": "CS35303 (Design and Analysis of Algorithm (S))",
   "1": "P", "2": "P", "3": "N", ..., "30": "N" }, ...]
// data — totals only: [{ "Total":"90","Present":"81","Absent":"9","Percet":"90.00 %" }]
```

| Cell value | Meaning |
| ---------- | ------- |
| `P` | present |
| `A` | absent |
| `N` | not marked (never notified) |
| `P,P` / `P,A` | TWO lectures for that subject on that day (per-lecture status preserved) |

There is **no teacher column** in this API — a teacher is only shown when it is
cross-matched from the user's own timetable, never invented.

QAttend calls this endpoint with the user's own authenticated session
(`data/qums-sessions/<userId>.json`), never by scraping the rendered table.

## What gets detected

1. New **Present** record → alert
2. New **Absent** record → alert
3. `Absent → Present` → alert
4. `Present → Absent` → alert
5. A change inside a two-lecture cell (`P,P → P,A`) → alert with per-lecture detail
6. Same record, same status → **no alert** (dedupe)

Examples:

```text
📌 Attendance Update            ← new record

Subject: Design and Analysis of Algorithm
Code: CS35303
Class Date: 22 September 2026
Status: ✅ Present

QUMS attendance was updated for a previous class.
```

```text
📌 Attendance Updated           ← status changed

Subject: Design and Analysis of Algorithm
Code: CS35303
Class Date: 22 September 2026
Previous Status: ❌ Absent
Current Status: ✅ Present

QUMS attendance was updated for a previous class.
```

The message always shows the **actual class date**, never the detection date.

## Deduplication

- Record identity: `YYYY-MM-DD-SUBJECTCODE` (deterministic fingerprint from the
  real portal fields; the detection timestamp is never part of the identity).
  Two lectures of the same subject/day share one record and keep both lecture
  statuses (`lectures[]` + `statusRaw` such as `"P,A"`), so nothing collides and
  `distinct keys == records` (verified live: 83 records → 83 keys).
- The **last known status** is stored per user in `known_attendance`
  (JSONB in PostgreSQL, or `data/db.json`). A status change replaces that entry,
  so the same transition can never alert twice.
- State is marked **before** the send; on a send failure the previous state is
  restored so the next cycle retries exactly once.
- Legacy per-lecture keys (`date-CODE#1`) are migrated, and legacy entries
  written before status tracking are silently refreshed — an upgrade never
  produces a backlog alert storm.

## First-scan (baseline) behaviour

The **first** successful scan for a user seeds the whole month **silently**
(no alerts). Every new or changed record after that alerts once.
A user who reconnects QUMS also gets an immediate baseline so reconnecting can
never spam old records.

## Historical month coverage (tiered, nothing silently missed)

```env
MONTH_REGISTER_INTERVAL_MINUTES=5      # loop cadence (tier clock)
MONTH_REGISTER_MONTHS_BACK=5           # total previous months monitored
MONTH_REGISTER_RECENT_EVERY_CYCLES=2   # previous month every 2nd cycle
MONTH_REGISTER_OLDER_EVERY_HOURS=6     # months 2..5 every 6 hours
```

| Tier | Months | Cadence with the defaults |
| ---- | ------ | ------------------------- |
| 1 | current | every 5 min |
| 2 | previous | every 10 min |
| 3 | 2..5 back (full semester) | every 6 h (a full sweep always includes tier 1+2) |

Months are fetched **sequentially** with a small delay — never in parallel — so
the portal is not hammered. A failure in one month is skipped; a session expiry
aborts the scan and notifies only that user. The tier clock lives in
`data/month_register_tier_state.json`; per-user attendance state never does.

---

# 🔐 QUMS Session Expiry & Reconnect

QUMS sessions expire server-side. QAttend detects this (login-page detection on
every scrape) and reacts per user:

```text
QUMS session expires
        ↓
QAttend detects SessionExpiredError
        ↓
Telegram alert with an inline button: [🔐 Reconnect QUMS]
        ↓
/qums-setup?reconnect=1  (captcha is generated automatically)
        ↓
USER solves the captcha manually   ← never automated, never stored
        ↓
Playwright storage state replaces data/qums-sessions/<userId>.json
        ↓
Telegram confirmation: ✅ QUMS Reconnected
        ↓
Monitoring resumes on the next watcher pass
```

- The captcha is **always** solved by the user; QAttend never bypasses,
  auto-solves or stores it.
- No password, session cookie or token is ever sent through Telegram.
- The alert cooldown is **per user** (12 h): one user's expired session can
  never suppress another user's alert.
- Only the expired user's session file is replaced — sessions are never shared.
- One expired user never stops the scheduler: other users are processed normally.

---

# 📚 Assignment Monitoring

Verified QUMS endpoint (same AJAX call the Assignment page makes):

```text
POST /Web_StudentAcademic/GetStudentAssignment
form: { RegID }
-> { state: "<assignment rows>", state2: "<study-material rows>" }
```

Rows are normalized from real fields: `AssignmentDetailID` (unique id when
present), `ASSIGNMENT`/`ASSIGNMENTSUBJECT` (title), `CLASSSUBJECT` (subject),
`EMPLOYEENAME` (faculty), `DATEFROM`, `DATETO` (deadline), `Assignmenttype`.

**Live observation (important):** the dated grid lives in `state`. For the
account audited on 2026-09-27, `state` returned **0 rows** while `state2`
returned **83 study-material rows** (`AssignmentDetailID, Subject,
AssignmentExt, Marks, Keywords, References, EMPLOYEENAME, ASSIGNMENTSUBJECT,
CLASSSUBJECT` — note: **no `DATETO`/`DATEFROM`**). Those rows are classified as
`Study Material`, which is not an assignable type and carries no deadline, so
QAttend sends **no** new-assignment notification and **no** reminder for them
(verified: 0 notifications, 0 reminders from live data). Nothing is guessed from
a missing deadline — a dated `state` row with `Assignmenttype: Assignment` does
notify exactly once.

- A new assignment alerts once, per user:
  `📚 New Assignment / Subject / Assignment / Last Date / 🔗 Open QUMS`.
- Dedupe uses the QUMS assignment id, or a stable fingerprint of the real
  fields when QUMS provides no id (`new:<id|fingerprint>` in `known_assignments`).
- Deadline reminder: at **19:00 IST** (`0 19 * * *`, `Asia/Kolkata`) exactly one
  reminder per assignment **whose real QUMS deadline is today**. There are no
  previous-day reminders and deadlines are never guessed.

```env
ASSIGNMENT_INTERVAL_MINUTES=30   # new-assignment polling interval
```

> Note: on a user's *first* assignment scan, assignments that already exist in
> QUMS are reported once (so the user sees what is pending) and are then
> deduplicated forever. Nothing is re-sent afterwards.

---

# 🏫 Timetable & Room Information

The application can read timetable information from QUMS and, where available, display:

- Subject
- Class timing
- Day
- Faculty
- Room number

---

# 👥 Multi-User Architecture

Each user has isolated application data:

```text
User ID
Email
Password
QUMS Credentials
QUMS Session
Telegram Link
Telegram Chat ID
Attendance Data
Notification State
Schedule
```

### Architecture

```text
                    ┌───────────────┐
                    │   Web App     │
                    └───────┬───────┘
                            │
              ┌─────────────┼─────────────┐
              ↓             ↓             ↓
           User A         User B        User C
              │             │             │
          QUMS A         QUMS B        QUMS C
              │             │             │
        Telegram A     Telegram B    Telegram C
```

---

# 🔐 Security

### QUMS Password Encryption

QUMS passwords are encrypted using:

```text
AES-256-GCM
```

The encryption key is supplied through environment variables.

### Authentication

The application supports:

- Registration
- Login
- Logout
- Password reset
- Session-based authentication

### Password Reset

Reset tokens are:

- Hashed before storage
- Time limited
- Single use

### Secrets

Never commit the real `.env` file.

Example:

```env
DATABASE_URL=
SESSION_SECRET=
ENCRYPTION_KEY=
TELEGRAM_BOT_TOKEN=
RESEND_API_KEY=
```

---

# 🛠️ Tech Stack

| Category | Technology |
|---|---|
| Backend | Node.js |
| Framework | Express.js |
| Browser Automation | Playwright |
| Database | PostgreSQL on Render / Local JSON fallback |
| Authentication | Express Session |
| Scheduling | node-cron |
| Notifications | Telegram Bot API |
| Email | Resend / SMTP |
| Frontend | HTML, CSS, JavaScript |
| Deployment | Render |
| Version Control | Git + GitHub |

---

# 📁 Project Structure

```text
attend_tracker/
│
├── public/
│   ├── index.html
│   ├── login.html
│   ├── register.html
│   ├── forgot.html
│   ├── reset.html
│   ├── qums-setup.html
│   └── style.css
│
├── src/
│   ├── server.js
│   ├── db.js
│   ├── scraper.js
│   ├── telegram.js
│   ├── mailer.js
│   ├── scheduler.js
│   ├── watcher.js
│   └── ...
│
├── tests/
│   └── ...
│
├── .env.example
├── .gitignore
├── package.json
└── README.md
```

---

# 🔄 Application Flow

```text
                 ┌──────────────┐
                 │    User      │
                 └──────┬───────┘
                        ↓
                ┌──────────────┐
                │ Register /   │
                │    Login     │
                └──────┬───────┘
                       ↓
                ┌──────────────┐
                │ Connect QUMS │
                └──────┬───────┘
                       ↓
                ┌──────────────┐
                │ Fetch QUMS   │
                │ Attendance   │
                └──────┬───────┘
                       ↓
                ┌──────────────┐
                │ Calculate    │
                │ Attendance   │
                └──────┬───────┘
                       ↓
             ┌─────────┴─────────┐
             ↓                   ↓
       Web Dashboard         Telegram Bot
             ↓                   ↓
       User sees data       User gets alerts
```

---

# 🌐 Public website

QAttend ships a complete public site (consistent header, footer, typography,
cards, buttons, responsive navigation, loading/error states):

| Route            | Page             | Access      |
| ---------------- | ---------------- | ----------- |
| `/`              | Home             | public      |
| `/features`      | Features         | public      |
| `/how-it-works`  | How It Works     | public      |
| `/about`         | About            | public      |
| `/faq`           | FAQ              | public      |
| `/contact`       | Contact          | public      |
| `/privacy`       | Privacy Policy   | public      |
| `/terms`         | Terms & Conditions | public    |
| `/register`      | Register         | public      |
| `/login`         | Login            | public      |
| `/forgot`, `/reset` | Password reset | public     |
| `/dashboard`     | Dashboard (Quick Actions) | login required |
| `/qums-setup`    | QUMS Setup / Reconnect | login required |
| `/telegram-setup` | Telegram Setup  | login required |

The dashboard greets the user with their **QUMS student name**
(`Hello Karan Kumar 👋`) — student emails stay internal to authentication and
are never shown in the dashboard or Telegram.

The mobile menu contains only **Dashboard / QUMS Setup / Telegram / Logout**
(no dangling Schedule/Profile/Help entries).

---

# 💻 Local Setup

## 1. Clone

```bash
git clone https://github.com/karansin003/Attendence_tracker.git
cd Attendence_tracker
```

## 2. Install

```bash
npm install
```

## 3. Environment

```bash
cp .env.example .env
```

Configure your required variables:

```env
NODE_ENV=development
PORT=3000
APP_BASE_URL=http://localhost:3000

DATABASE_URL=

SESSION_SECRET=your_session_secret
ENCRYPTION_KEY=your_encryption_key

TELEGRAM_BOT_TOKEN=your_telegram_bot_token
TELEGRAM_BOT_USERNAME=qums_attendance_bot
# TELEGRAM_POLLING=off        # send-only instance (no getUpdates -> no 409)

# Monitoring cadence
WATCH_INTERVAL_MINUTES=2          # today's attendance loop
MONTH_REGISTER_INTERVAL_MINUTES=5 # backdated Month Register loop
MONTH_REGISTER_MONTHS_BACK=1      # current + previous month
ASSIGNMENT_INTERVAL_MINUTES=30    # new-assignment check

# Optional: real support address for the public Contact page
# CONTACT_EMAIL=support@example.com

RESEND_API_KEY=your_resend_api_key
RESEND_FROM=onboarding@resend.dev
```

Never commit real credentials.

## 4. Run

```bash
npm start
```

Development mode:

```bash
npm run dev
```

Open:

```text
http://localhost:3000
```

---

# 🧪 Testing

Run:

```bash
npm test
```

The test suite covers important components including:

- Attendance parser + calculator
- Timetable handling
- Watcher logic (per-class alerts + dedupe across restarts)
- Month-register / backdated attendance: baseline, new Present, new Absent,
  `Absent → Present`, `Present → Absent`, duplicate prevention, month-by-month
  scanning, legacy-state migration, multi-user isolation
- Assignment new-record detection, duplicate prevention, 7:00 PM deadline
  reminder, multi-user isolation
- QUMS session-expiry alerts, per-user cooldown, Reconnect button URL,
  "QUMS Reconnected" copy, expired-user isolation
- Telegram `/start` deep-link handling (single handler, duplicate prevention)
- 8:30 AM morning schedule reliability
- Firebase auth
- Dashboard/mobile-menu/ad-slot markup + production environment checks

Expected result:

```text
ALL TESTS PASSED
ALL MULTI-USER ISOLATION TESTS PASSED
ALL FIREBASE AUTH TESTS PASSED
ALL TELEGRAM /start TESTS PASSED
ALL MORNING SCHEDULE TESTS PASSED
ALL BACKDATED ATTENDANCE TESTS PASSED
ALL ASSIGNMENT TESTS PASSED
ALL SESSION RECONNECT TESTS PASSED
ALL UI / PRODUCTION TESTS PASSED
```

---

# 🤖 Telegram Testing

Check the bot:

```text
https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getMe
```

Check webhook status:

```text
https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getWebhookInfo
```

For polling mode, the application should use polling rather than a Telegram webhook.

Expected server log:

```text
[telegram] polling armed (@qums_attendance_bot) — ONE /start handler + /link + /status (pid 12345)
```

This line must appear exactly once per process. Only ONE poller may consume the
bot token: the server keeps a pid lock at `data/telegram-polling.lock`, so a
second process on the same machine logs `polling SKIPPED` and only sends (no
`getUpdates`). On every other host/instance set `TELEGRAM_POLLING=off`. Duplicate
pollers make Telegram deliver the same update to both, which shows up as multiple
replies to a single `/start` (and `409 Conflict` polling errors).

Expected `/start` replies (each exactly once):

- plain `/start` → welcome + "Connect Telegram" line (no other message)
- valid deep-link (`/start <code>`) → `✅ Connected!` + the QUMS student name
- same valid deep-link again → `✅ Already Connected!` (never "invalid")
- unknown/expired code → `❌ This connection link is invalid or expired.`

Never publish the actual bot token.

---

# ☁️ Render Deployment

Recommended configuration:

```text
Build Command:
npm install

Start Command:
npm start
```

Production environment variables include:

```env
NODE_ENV=production
APP_BASE_URL=https://YOUR-RENDER-URL

DATABASE_URL=YOUR_RENDER_POSTGRES_INTERNAL_DATABASE_URL

SESSION_SECRET=YOUR_SESSION_SECRET
ENCRYPTION_KEY=YOUR_ENCRYPTION_KEY

TELEGRAM_BOT_TOKEN=YOUR_TELEGRAM_TOKEN
TELEGRAM_BOT_USERNAME=qums_attendance_bot

RESEND_API_KEY=YOUR_RESEND_API_KEY
RESEND_FROM=onboarding@resend.dev
```

For production, PostgreSQL is recommended for persistent application data.

---

# ⚠️ Production Notes

Render service filesystems can be ephemeral. Do not rely on local runtime files for permanent data.

Use PostgreSQL for persistent application data and Render Environment Variables for secrets.

Telegram polling should normally run on only one active application instance. Multiple replicas using the same bot token can cause polling conflicts.

## Known limitations on an ephemeral filesystem (Render)

Most application data is in PostgreSQL when `DATABASE_URL` is set
(users, attendance state, assignment state, weekly schedule). Two things still
live on the local filesystem:

1. **QUMS session files** — `data/qums-sessions/<userId>.json`
2. **Express app sessions** — `data/app-sessions/*.json` (file store)

On Render these are lost when the service restarts/redeploys or when the disk
is recycled. The consequences and the safe behaviour are:

- After a restart, a user may need to press **🔐 Reconnect QUMS** once
  (captcha only). QAttend detects the missing/expired session and tells the user
  exactly that — it never pretends the session is still valid.
- Users have to log in to the web dashboard again after an app-session wipe.
- To remove limitation 1 completely, persist `data/` on a Render Disk, or store
  the Playwright storage state in PostgreSQL (not implemented — it is a
  credential-bearing artifact and needs a deliberate security review first).

Nothing else is assumed to be permanent: no fake session extension, no
in-memory-only "permanent" state.

## Advertisement slot

Every public page and the dashboard render one small, responsive
`.ad-slot` container near the footer:

```html
<aside class="ad-slot" aria-label="Advertisement">
  <span class="ad-slot-label">Advertisement</span>
  <div class="ad-slot-body" data-ad-slot="qattend-footer">
    Ad space — reserved for a future approved ad unit
  </div>
</aside>
```

- It is a **placeholder only**: no ad-network script, no publisher id, no
  `ads.txt`, and no fake creative that pretends to be a real ad.
- It never overlays content, never opens a popup and never delays the page.
- To go live later, paste the approved provider's snippet inside
  `[data-ad-slot]`; the responsive layout stays unchanged.

## Telegram duplicate-polling (409 Conflict)

The bot polls with `getUpdates`, so **only one poller may run at a time**.

- Within one host, `data/telegram-polling.lock` (pid-based) guarantees a single
  poller; the second process automatically becomes send-only.
- Set `TELEGRAM_POLLING=off` on any worker/instance that must not receive
  updates (it can still send).
- Keep exactly **one Render instance** running for the web service. Two
  instances with the same token produce `409 Conflict: another instance is
  calling getUpdates` and duplicate `/start` replies. QAttend logs that
  conflict loudly instead of hiding it.

---

# 📱 Responsive Design

The dashboard is designed for desktop and mobile.

### Desktop

```text
┌─────────────────────────────────────────┐
│              Navigation                 │
├─────────────────────────────────────────┤
│       Attendance Summary Cards          │
├─────────────────────────────────────────┤
│            Attendance Table             │
├─────────────────────────────────────────┤
│   Quick Actions / Telegram / QUMS       │
└─────────────────────────────────────────┘
```

### Mobile

```text
┌─────────────────────┐
│ ☰   QUMS Attendance │
├─────────────────────┤
│   Summary Cards     │
├─────────────────────┤
│ Attendance Table →  │
├─────────────────────┤
│ Quick Actions       │
├─────────────────────┤
│ Telegram Status     │
├─────────────────────┤
│ QUMS Status         │
└─────────────────────┘
```

---

# 🎯 Why This Project?

Students often need to manually check QUMS attendance multiple times a day.

This project automates that process by combining:

```text
QUMS
  +
Playwright
  +
Attendance Logic
  +
PostgreSQL
  +
Telegram
  +
Scheduler
  +
Responsive Dashboard
```

---

# 📌 Key Highlights

- ✅ Multi-user attendance tracking
- ✅ QUMS automation
- ✅ Subject-wise attendance
- ✅ 75% attendance calculation
- ✅ Telegram integration
- ✅ Real-time attendance alerts
- ✅ Daily scheduled notifications
- ✅ Backdated attendance detection
- ✅ Timetable/room integration
- ✅ Secure QUMS credential encryption
- ✅ Password reset system
- ✅ PostgreSQL support
- ✅ Responsive UI
- ✅ Automated testing
- ✅ Render deployment support

---

# 🧑‍💻 Author

**Karan Kumar**

B.Tech CSE (AI/ML)  
Quantum University

GitHub:  
https://github.com/karansin003

---

# 📄 License & Ownership

Copyright © 2026 Karan Kumar.

This project is publicly available for viewing and educational reference.

Unauthorized copying, redistribution, or presenting this project as your own work is not permitted.

The repository being public means its source code can be viewed and downloaded. This notice communicates the author's ownership and usage expectations; it does not technically prevent copying.

---

# ⭐ Project Status

**Status: Active Development 🚀**

The project is continuously improved with new features, bug fixes, UI improvements, automation, and performance updates.
