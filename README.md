# QUMS Attendance Tracker 🤖📊

A full-stack attendance tracking system for **Quantum University Management System (QUMS)** that automatically monitors attendance, calculates attendance requirements, sends Telegram notifications, and provides a responsive web dashboard.

## 🌐 Live Demo

> Replace this URL with your current Render URL if it has changed.

**Live App:** https://attendence-tracker-9nkf.onrender.com

---

## ✨ Overview

QUMS Attendance Tracker makes university attendance management simple and automated.

Instead of repeatedly logging into QUMS and checking attendance manually, users can connect their QUMS account once and let the application monitor attendance in the background.

### Main Features

- 📊 Live attendance dashboard
- 🎯 75% attendance requirement calculator
- 📱 Telegram notifications
- ⚡ Per-class attendance alerts
- 🌙 Daily attendance summary
- 🗓️ Backdated attendance detection
- 🏫 Timetable and room information
- 👥 Multi-user support
- 🔐 Encrypted QUMS credentials
- 📱 Responsive mobile UI

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

A daily attendance check can run around:

```text
8:30 AM
```

## 🌙 Daily Summary

A daily summary can be generated around:

```text
9:00 PM
```

It can include:

- Current attendance
- Subjects below 75%
- Subjects near 75%
- Attendance changes
- Important warnings

---

# 🗓️ Backdated Attendance Detection

QUMS can sometimes update attendance for an earlier class after the class has already happened.

The tracker can:

1. Check the QUMS month register
2. Compare previously known attendance
3. Detect newly added attendance
4. Identify the related subject/date
5. Send the appropriate Telegram notification

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

- Attendance parser
- Attendance calculator
- Timetable handling
- Watcher logic
- Telegram integration
- Mailer
- Scheduler
- Cache
- Month-register monitoring
- Multi-user isolation
- Restart persistence

Expected result:

```text
ALL TESTS PASSED
ALL MULTI-USER ISOLATION TESTS PASSED
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
[telegram] polling armed (@qums_attendance_bot)
```

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
