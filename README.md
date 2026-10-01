# QAttend --- QUMS Attendance & Assignment Tracker

> **Never miss an attendance update or assignment deadline again.**

QAttend is a full-stack student utility that connects with **Quantum
University Management System (QUMS)** to monitor attendance and
assignments, store student data securely, and send timely updates
through **Telegram**.

## ✨ Features

### 🎓 QUMS Integration

-   Secure QUMS login flow with manual CAPTCHA support.
-   Fetches the student's actual **name, QID/RegID and Year/Semester**
    from QUMS.
-   QUMS is the source of truth for academic identity.
-   Reconnect flow for expired QUMS sessions.
-   QUMS password is not permanently stored.

### 📊 Automatic Attendance Monitoring

-   Automatic attendance monitoring during configured college hours.
-   Detects meaningful attendance transitions such as `N → P`, `N → A`,
    `P → A`, and `A → P`.
-   Handles delayed/backdated teacher updates.
-   Telegram notifications show the **actual class date**, not the
    detection date.
-   Attendance before a user's monitoring start date never generates a
    new notification.
-   Persistent PostgreSQL deduplication prevents duplicate alerts.
-   Reconnect/session-expiry recovery compares saved state with fresh
    QUMS data.

### ⏰ Scheduled Jobs

-   **8:30 AM IST:** Morning attendance/class notification.
-   **Every 5 minutes:** Attendance watcher.
-   **Every 10 minutes:** Month-register synchronization.
-   **Every 30 minutes:** Assignment checking.
-   **7:00 PM IST:** Assignment deadline reminder when the real deadline
    is today.
-   The old 9 PM attendance summary has been removed.

### 📚 Assignment Tracking

-   Detects genuinely new assignments from QUMS.
-   Sends subject, assignment title, last date and QUMS link.
-   Sends one deadline reminder for an assignment due that day.
-   Persistent deduplication prevents repeated notifications.

### 🤖 Telegram Bot

Provides attendance updates, assignment notifications, deadline
reminders, QUMS session-expiry alerts and reconnect notifications.

### 👥 Multi-User Architecture

-   Multiple students supported.
-   Firebase authentication.
-   Individual QUMS identities.
-   Individual Telegram connections.
-   Per-user attendance and assignment history.
-   Per-user notification deduplication.

## 🏗️ Architecture

``` text
Student → QAttend (Node.js/Express) → Supabase PostgreSQL
                    │
                    ├──────────────→ QUMS
                    │
                    └──────────────→ Telegram Bot
```

## 🛠️ Tech Stack

-   **Frontend:** HTML, CSS, JavaScript
-   **Backend:** Node.js, Express.js
-   **Database:** PostgreSQL / Supabase
-   **Authentication:** Firebase Authentication
-   **Automation:** Playwright
-   **Notifications:** Telegram Bot API
-   **Deployment:** GitHub + Render + Supabase

## 📁 Project Structure

``` text
qattend/
├── src/
│   ├── server.js
│   ├── db.js
│   └── ...
├── public/
│   └── ...
├── package.json
├── package-lock.json
├── .gitignore
└── README.md
```

## 🔐 Environment Variables

Configure secrets through `.env` locally or Render Environment
Variables.

``` env
APP_BASE_URL=https://qattend.onrender.com
DATABASE_URL=postgresql://...
NODE_ENV=production

SESSION_SECRET=...
ENCRYPTION_KEY=...

TELEGRAM_BOT_TOKEN=...
TELEGRAM_BOT_USERNAME=...

QUMS_LOGIN_URL=https://qums.quantumuniversity.edu.in/
QUMS_DASHBOARD_URL=https://qums.quantumuniversity.edu.in/Web_StudentAcademic/Cyborg_S_Dashboard
QUMS_TIMETABLE_URL=https://qums.quantumuniversity.edu.in/Web_StudentAcademic/Cyborg_StudentTimeTable?id=Time%20Table

WATCH_INTERVAL_MINUTES=5
MONTH_REGISTER_INTERVAL_MINUTES=10
```

**Never commit passwords, bot tokens, session secrets, encryption keys,
or database credentials to GitHub.**

## 🚀 Local Development

``` bash
git clone https://github.com/karansin003/qattend.git
cd qattend
npm install
npx playwright install chromium
npm start
```

## 🌐 Production

**QAttend:** https://qattend.onrender.com

Production flow:

``` text
User → Render → QAttend → Supabase PostgreSQL
                         ├→ QUMS
                         └→ Telegram
```

## 🗄️ Database

Main persistent data categories:

``` text
users
attendance
assignments
notification_log
```

-   **users:** Firebase identity, QID/RegID, QUMS student name,
    Year/Semester, Telegram connection and monitoring state.
-   **attendance:** class-level attendance state and history.
-   **assignments:** QUMS assignment information and synchronization
    state.
-   **notification_log:** notification history and deduplication data.

## 🔄 Attendance Logic

QAttend uses the monitoring start date as an eligibility boundary:

``` text
Monitoring Start Date
        │
        ├── Class Date BEFORE start date → Never notify
        │
        └── Class Date ON/AFTER start date → Eligible
```

Example:

``` text
Monitoring starts: 1 Oct 2026

30 Sep: P → A
→ No notification

1 Oct: P → A
→ Notification sent
```

Delayed update example:

``` text
Class Date:       1 Oct
Teacher marks:    2 Oct
Detection Date:   2 Oct

Telegram:
Class Date: 1 October 2026
```

## 🔔 Notification Flow

``` text
QUMS
  ↓
Attendance / Assignment Change
  ↓
QAttend Watcher
  ↓
Validate User + Date + State
  ↓
Persistent Deduplication
  ↓
Telegram Bot
  ↓
Student Notification
```

## 🔥 Firebase Authentication

Firebase provides registration, login, forgot-password and
password-reset flows.

The Firebase display name is **not** the source of truth for academic
identity. Student name and academic information come from QUMS.

## 🛡️ Security

-   QUMS passwords are not permanently stored.
-   Secrets are kept in environment variables.
-   Database credentials are never committed to Git.
-   Telegram credentials are protected.
-   Firebase private credentials are never exposed to the client.
-   User records are isolated by internal user identity.
-   Notification deduplication is persisted in PostgreSQL.

## 📌 Production Notes

Render background monitoring depends on the hosting environment
remaining active. Free hosting instances may sleep when inactive, which
can affect background timers and browser sessions.

Only one production Telegram polling process should consume updates for
the bot token.

## 🧪 Health Check

``` text
https://qattend.onrender.com/health
```

## 📈 Future Improvements

-   Admin dashboard
-   System health dashboard
-   Attendance analytics
-   Subject-wise attendance trends
-   Low-attendance alerts
-   Better monitoring observability
-   Background job queue
-   Persistent browser/session storage
-   Automated database cleanup/archiving

## 👨‍💻 Author

**Karan Kumar**

B.Tech Computer Science & Engineering\
Specialization: Artificial Intelligence & Machine Learning

## ⭐ Project Goal

> **Students should not have to repeatedly check QUMS just to know
> whether their attendance or assignments changed.**

QAttend automates that workflow by connecting QUMS, PostgreSQL,
Firebase, and Telegram into one student-focused platform.

## 📄 License

Add the project's chosen license before publishing the repository
publicly.
