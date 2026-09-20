# QUMS Attendance Bot 📊

Multi-user QUMS (Quantum University) attendance tracker:
**apna login/register** + forgot-password, live attendance dashboard (QUMS-style
navy/amber theme), aur **Telegram alerts** (bot: [@qums_attendance_bot](https://t.me/qums_attendance_bot))
— **subah 8:30 AM aaj ki classes**, teacher mark karte hi **per-class update**
(teacher + subject + date + present/absent), backdated marks ka month-register
watcher, aur **raat 9 PM full summary** — sab har registered user ke apne Telegram
chat pe.

> **v4 — Telegram channel:** register → ek-baar QUMS captcha setup (web se, bina
> CLI) → dashboard se "Connect Telegram" (deep-link, EK click) → done. Har user
> ka QUMS password AES-256-GCM encrypted store hota hai. (Purana WhatsApp
> QR-flow poora hata diya gaya hai.)

## Stack

| Piece          | Tech                                        |
| -------------- | ------------------------------------------- |
| Backend        | Node.js + Express + express-session (90-din cookie, file store) |
| Database       | JSON file store (`data/db.json`) — bcrypt password hashes + AES-256-GCM QUMS passwords |
| Scraping       | Playwright (portal ke apne AJAX APIs + web captcha relay) |
| WhatsApp       | ~~whatsapp-web.js~~ hata diya — ab **Telegram** neeche dekho |
| Telegram       | node-telegram-bot-api (polling mode, koi webhook URL nahi) — EK bot [@qums_attendance_bot](https://t.me/qums_attendance_bot), har user apne dashboard se deep-link connect karta hai |
| Scheduler      | node-cron (8:30 AM schedule + 9 PM summary, IST) |
| Watcher        | per-class real-time alerts (08:30–17:00 IST polling) |
| Dashboard      | Plain HTML/CSS/JS (QUMS-style theme, no framework) |

## Project structure

```
attend_tracker/
├── package.json
├── .env.example           # template (real values sirf .env me — never commit)
├── .gitignore
├── src/
│   ├── server.js          # Express: auth + pages + per-user APIs + boot
│   ├── db.js              # JSON store (users, reset tokens) — data/db.json
│   ├── crypto.js          # AES-256-GCM encrypt/decrypt (QUMS passwords at rest)
│   ├── credentials.js     # user -> decrypted QUMS creds + session path (+ .env fallback)
│   ├── qums-login-web.js  # web captcha relay (headless browser per pending login)
│   ├── login.js           # shared form helpers (headless web captcha relay ke liye)
│   ├── scraper.js         # portal APIs: attendance + today's periods + month register (+ timetable)
│   ├── calculator.js      # 75% math (exact counts, estimation fallback)
│   ├── telegram.js        # Telegram bot + deep-link linking + sendMessage(userId)
│   ├── messages.js        # Message builders (update, morning schedule, summary)
│   ├── scheduler.js       # 8:30 AM morning schedule + 9 PM summary (sab users)
│   ├── watcher.js         # per-class alerts + backdated month-register alerts (per-user dedupe)
│   ├── alerts.js          # session-expiry Telegram alerts (12h cooldown)
│   ├── debug-dump.js      # (debug) portal DOM/JS dump
│   └── debug-session-probe.js # (debug) session zinda hai ya nahi
├── public/                # style.css + index (dashboard), login, register,
│   forgot, reset, qums-setup pages
├── test/parser.test.js    # unit tests
└── data/                  # git-ignored: db.json, qums sessions, watcher state
```

## Pura flow (users ke liye)

1. **Register** — `/register`: email + app password. (Alerts Telegram pe aayenge —
   number ki zaroorat nahi.)
2. **QUMS Setup** — `/qums-setup`: QID + QUMS password → **captcha image web
   page pe dikhega** → type → submit → QUMS session save (encrypted).
   Session expire ho jaye to Telegram ⚠️ alert + wahi page dobara.
3. **Connect Telegram (EK click)** — dashboard ke banner ka
   **"Connect Telegram"** button dabao → `https://t.me/qums_attendance_bot?start=<code>`
   khulega → Telegram me **"Start"** dabao → turant `✅ Connected` reply.
   (Deep-link auto-start — koi code typing nahi. Backup: `/link <code>` command.)
4. **Dashboard** — `/dashboard`: live attendance, exact attended/total, 75% guidance.

Roz automatically (IST):
- **8:30 AM** — 🌅 aaj ki classes (time, subject, **Room**, teacher — timetable se)
- **Mark hote hi** — 📌 per-class alert (teacher ne present/absent mark kiya)
- **Backdated/evening marks** — 🗓️ month-register loop (har 10 min, 24x7) pakadta hai
- **9:00 PM** — 🌙 pura summary + 75% guidance

## Setup (developer/admin)

**Prereqs:** Node.js 18+ (tested on Node 24), npm.

```bash
npm install
npx playwright install chromium

cp .env.example .env
# .env me bharo:
#  ENCRYPTION_KEY=   node -e "console.log(require('crypto').randomBytes(24).toString('base64'))"
#  SESSION_SECRET=   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
#  APP_BASE_URL=     public URL (forgot-password reset links ke liye)
#  RESEND_API_KEY=   resend.com API key (forgot-password emails — RECOMMENDED)
#  (optional) SMTP_* — email fallback jab RESEND_API_KEY na ho; bina dono ke
#                     reset link server console me print hota hai

npm start                 # http://localhost:3000
```

Telegram ke liye `.env` me **`TELEGRAM_BOT_TOKEN=`** daalo (BotFather se token
le ke) + `TELEGRAM_BOT_USERNAME=qums_attendance_bot` — bas. Polling mode hai,
koi public webhook URL nahi chahiye. Users dashboard ke deep-link se khud
connect karte hain (har user ka apna chat).

## Feature: Real-time per-class Telegram alerts 📌

Jaise hi koi teacher QUMS pe kisi period ka attendance mark kare, turant ek chhota
Telegram message jaata hai:

```
📌 Attendance Update
Subject: Robotic Industry 4.0 (MT3015)
Period: P2 (09:55-10:50)
Status: ✅ Present  /  ❌ Absent
Teacher: ANKUR JAIN
```

**Kaise kaam karta hai** (`src/watcher.js`): QUMS pe webhook/push nahi hai, isliye
watcher **"Today's Attendance" API ko poll** karta hai — ye **near-real-time**
monitoring hai (webhook nahi, polling): har `WATCH_INTERVAL_MINUTES` (default
2 min), sirf **college hours (08:30–17:00 IST)** me. Period jab tak "N.M." (Not
Marked) hai ignore hota hai; jaise hi P/A/Presence-type value aati hai aur wo
pehli baar dikha hai, ek message bhej deta hai. Duplicate protection: **per-user**
state file `data/notified_periods/<userId>.json` me
`{ "2026-09-11": ["P2-CS30201:present", ...] }` store hota hai (event key =
period + subjectCode + **status**) — ek period pe sirf ek hi message kabhi
jaayega (send se *pehle* state mark hoti hai, fail hone pe rollback — crash pe
bhi duplicate nahi hoga).

**User isolation (15A–15K):** har user ka QUMS attendance USKE apne session se
fetch hota hai aur update SIRF uske apne Telegram `chatId` pe jaata hai
(`users.telegramChatId`, deep-link se linked). Koi global/hardcoded chatId nahi
hai; user A ka notification state user B ko kabhi suppress nahi karta (alag
per-user state files). `npm test` is isolation ko automated multi-user tests
(Tests A–D: per-user delivery + dedupe + restart persistence) se verify karta hai.

Commands:

```bash
node src/watcher.js --test           # 3 simulated cycles, DRY-RUN (no real send)
node src/watcher.js --test --send    # simulation + REAL Telegram send
node src/watcher.js --now            # ek real cycle abhi (hours check ke saath)
node src/watcher.js --now --force    # ek real cycle abhi, hours check bypass
node src/scraper.js --today          # aaj ke periods ka raw JSON (debug)
node test/multiuser.test.js          # multi-user Telegram isolation tests (A–D)
```

Server chalte hue dashboard ke saath watcher bhi armed hota hai. Debugging ke liye
browser me `http://localhost:3000/api/today` kholo — dikh jayega watcher ko is waqt
kya data mil raha hai (aur kya "N.M." se P/A me badla).

## Feature: Timetable room numbers 🏠

Timetable cell `"Subject(CODE) (ROOM),TEACHER"` ka room ab reliably parse hota hai
(`parseTimetableCell` — step-by-step: teacher = last comma ke baad, saare paren
groups me pehla = code, baaki join = room — `"(E-202)(B)"` → `E-202B`).

**8:30 AM morning message** ab timetable se banta hai — room ke saath:

```
🌅 Aaj ki Classes — Mon, 15 Sep 2026

1. 🕐 09:00 - 09:55 — Design and Analysis of Algorithm (CS35303)
    Room: A-004 • RAJ KUMAR
```

(Timetable scrape fail ho to fallback: attendance-rows message bina room.)

## Feature: Month Register — backdated attendance alerts 🗓️

Teachers kabhi-kabhi **pichhle dinon** ka attendance der se mark karte hain. Uske
liye month register ka ek doosra loop hai (`src/watcher.js` + `src/scraper.js`):

- Har `MONTH_REGISTER_INTERVAL_MINUTES` (default 10 min, 24x7) me current month ka
  **Month Register API** call hota hai: `POST /Web_StudentAcademic/GetMonthRegister
  { RegID, Month }` — UI click ki zaroorat nahi (reverse-engineered; live-UI
  inspection: `node src/debug-inspect-month-register.js`).
- Response ek matrix hai: rows = subjects (`"CS35303 (Design and ... (S))"`),
  columns = day `1..31`, values = `P` / `A` / `N` (not marked); `"P,P"` = us din
  2 lectures. Naye (backdated) marked records -> Telegram alert:

  ```
  📌 Attendance Update
  BHANU PARTAP ne 12 Sep 2026 ko Scala for Data Science (CS35365) ka attendance mark kiya
  Status: ❌ Absent
  ```

- **Teacher ka naam Month Register me nahi hota** — timetable se cross-match hota
  hai (`getTimetableForDate(date)` = us date ke weekday ki row + subject code se
  teacher). Cross-match sirf tab hota hai jab koi naya record mile (browser
  launch bachane ke liye); timetable na mile to teacher ke bina alert jaata hai.
- Dedupe: db `known_attendance` (per-user, `data/db.json` me) — naye records hi
  alert hote hain, send se PEHLE mark + fail pe rollback. **Pehli cycle BOOTSTRAP
  hoti hai**: poora current month silently seed hota hai (alert-storm nahi).
- Dashboard ke Present/Absent/Diff Lecture buttons sirf **legend** hain (readonly,
  no onclick) — koi filter toggle nahi.
- Timetable ab live jqGrid layout bhi parse karta hai (period headers alag
  `ui-jqgrid-htable` table me, day cell doosre column me — portal ka "Thrusday"
  typo included). Note: "Academic → Time Table" wala menu-flow is portal me nahi
  hai; direct timetable URL valid session se reliably khulta hai.

Commands:

```bash
node src/watcher.js --month-test          # simulated backdated flow, DRY-RUN
node src/watcher.js --month-test --send   # simulation + REAL Telegram send
node src/watcher.js --month-now           # ek real month-register pass abhi
node src/watcher.js --month-now --dry     # wahi, bina send (pehli baar bootstrap seed hoga)
node src/scraper.js --month 9             # September ka register raw JSON (debug)
node src/scraper.js --month 9 --timetable # register + timetable + aaj ki periods
```

## Task 1-3 details (latest): merged schedule + weekly cache + instant watcher

**1. Merged morning schedule** — subject + teacher **"Today's Attendance"** API se
aate hain (QUMS marking ka source — sabse reliable), aur **room sirf Timetable**
se. `scraper.getTodaysScheduleWithRoom(userId)` dono ko merge karta hai
(match: subjectCode, fallback period; na mile to room `N/A`).

**2. Weekly schedule cache (7-day TTL)** — har merge ke baad result
`data/db.json` ke `weeklySchedule` me aaj ke `dayOfWeek` ke against upsert hota
hai (PK: userId + dayOfWeek + period). Morning message **cache-first** hai:
fresh cache (<=7 din) ho to live scrape SKIP, warna live merge + upsert. Isse
pehla hafte har din live scrape hota hai (cache build), baad me fast response +
har 7 din auto-refresh. Dashboard pe **"🔄 Refresh my schedule (force)"** button
se cache force-refresh hota hai (`POST /api/schedule/refresh`).

**3. Instant watcher start** — QUMS setup complete hote hi (captcha submit ok)
server turant **baseline fetch** chalata hai (`watcher.runBaselineForUser`):
aaj ke ALREADY-MARKED periods ko fast-loop dedupe state me seed kar deta hai
(N.M. skip). Isse already-marked periods ka alert-storm nahi hota, aur
**baaki bache periods pe teacher mark kare to alert USI DIN se aata hai** —
agla watcher cycle (5 min ke andar) naye user ko automatically include karta hai.

## How the 75% math works

The scraper calls the portal's own AJAX API (`GetYearSemWiseAttendance`) with your
session cookies — the same call the dashboard's "Show" button makes. The response
contains **exact** `TotalLecture` / `TotalPresent` / `TotalAbsent` per subject, so
no estimation is needed (`ATTENDANCE_TOTAL_CLASSES` is only a fallback).

- **Below 75%** → consecutive classes needed to reach 75%:
  `needed = ceil((0.75 × total − attended) / 0.25)`
- **At/above 75%** → classes you can miss and still stay ≥ 75%:
  `canSkip = floor((attended − 0.75 × total) / 0.75)`
- Overall % is the lecture-weighted average across subjects; the portal's own
  overall figure and date range are also shown when available.

## Troubleshooting

| Problem | Fix |
| --- | --- |
| `QUMS session expired` (dashboard/API pe) | **Dashboard → QUMS Setup → "Reconnect QUMS"** — sirf captcha solve karo (QID/password DB se auto-fill, dobara nahi maangte) — session refresh ho jayega. **Server restart ki zaroorat nahi**. Session ki umra portal decide karta hai (kuch ghante se ek din tak). Telegram pe ⚠️ expiry alert bhi aata hai. |
| Session-expiry ka Telegram alert | Watcher/cron ko expired session mile to tumhare Telegram pe ⚠️ alert aata hai (12h cooldown; sirf tab jab Telegram connected ho). `node src/debug-session-probe.js` se kabhi bhi session health check karo. |
| `session_state.json missing` / 409 from the API | QUMS Setup se dobara login (captcha ek baar). Multi-user watcher/scheduler apne per-user sessions (`data/qums-sessions/`) use karte hain. |
| `RegID nahi mila` / weird data | Portal markup changed. Run `node src/debug-dump.js` (writes `debug-qums-dom.txt` + `debug-qums-js.txt` — personal data, don't commit) and inspect/update the regexes in `src/scraper.js`. |
| Wrong semester's data | Set `QUMS_CURRENT_YEARSEM` in `.env` (e.g. `5`). Normally auto-detected. |
| Attendance parses 0 rows | Run `node test/parser.test.js` to validate logic against simulated DOM; the live API path needs a valid session. |
| Telegram token invalid / polling errors | Server log me `[telegram] polling error: 401 ...` dikhe to token galat hai — BotFather se naya token le ke `.env` update + restart. `npm run telegram-test` se token verify karo. |

## Known limitations (read this!)

1. **Real-time watcher needs an always-on server.** Polling sirf tab kaam karti hai
   jab `npm start` process chal raha ho. Free hosting (Render/Railway free tier)
   ~15 min inactivity pe sleep kar jaata hai → watcher ke polls aur 9 PM cron dono
   miss ho sakte hain. Fix: paid tier
   (disk ke saath) ya apna laptop/Raspberry Pi 24/7 on rakho.
2. **Attendance aur timetable ka parsing portal ke apne APIs pe based hai**
   (`GetYearSemWiseAttendance`, `GetTodayAttendance`) jo tumhare session cookies se
   call hote hain. Agar QUMS in endpoints/fields badle to scrape fail hoga — tab
   `node src/debug-dump.js` chala kar naya contract nikalna hoga (Troubleshooting
   table dekho).
3. **Watcher dedupe state per-user file-based hai** (`data/notified_periods/<userId>.json`).
   Agar ye files delete ho jaayein (ya free hosting pe disk persist na ho) to koi
   marked period ka message dobara ja sakta hai jo already notify ho chuka tha.
4. **QUMS session expiry per-user hai** — portal ka server-side session kuch ghanton
   me khatam ho jata hai (captcha automation possible nahi). Expire hone pe us user
   ko Telegram ⚠️ alert jaata hai aur wo `/qums-setup` dobara kar leta hai.
5. **Ek Telegram bot = sab users** — sab notifications EK bot (@qums_attendance_bot)
   se jaate hain, par HAR USER APNE KHUD ke chat pe (apna deep-link connect).
   User disconnect kare to sirf uske alerts band — baaki users par asar nahi.

## Deployment (Render Web Service — production)

Live URL: **https://attendence-tracker-d7c4.onrender.com**

### 1. Service settings (Render Dashboard)

| Setting | Value |
| --- | --- |
| Type | Web Service |
| Runtime | Node |
| Build Command | `npm install && npx playwright install --with-deps chromium` |
| Start Command | `npm start` |
| Health Check Path | `/health` |

- `PORT` **manually set mat karo** — Render khud inject karta hai (server `process.env.PORT` listen karta hai; fallback 10000).
- QUMS scraping/headless captcha ke liye Chromium build command me install hota hai (Playwright). Render free tier RAM limit se zyada use ho sakta hai — dekho "Known limitations".

### 2. Environment Variables (Render Dashboard → Service → Environment)

**Secrets kabhi GitHub me na daalo — sirf Render Environment me:**

```
APP_BASE_URL=https://attendence-tracker-d7c4.onrender.com
NODE_ENV=production
ENCRYPTION_KEY=<tumhara AES key — dekho .env.example>
SESSION_SECRET=<tumhara session secret — dekho .env.example>
TELEGRAM_BOT_TOKEN=<Render secret — BotFather ka token>
TELEGRAM_BOT_USERNAME=qums_attendance_bot
# Recommended (warna production me password-reset email deliver nahi hoga):
RESEND_API_KEY=<resend.com → API Keys → Create API Key>
# RESEND_FROM=QUMS Attendance Bot <noreply@yourdomain.com>   # verified domain chahiye
# SMTP fallback (sirf tab jab RESEND_API_KEY na ho):
# SMTP_HOST=smtp.gmail.com
# SMTP_PORT=587
# SMTP_USER=<email>
# SMTP_PASS=<app password>
# SMTP_FROM=<email>
# Optional tuning:
# WATCH_INTERVAL_MINUTES=5
# MONTH_REGISTER_INTERVAL_MINUTES=10
```

- `APP_BASE_URL` isse hi production reset links bante hain:
  `https://attendence-tracker-d7c4.onrender.com/reset?token=...`
- **`QUMS_QID` / `QUMS_PASSWORD` Render pe set MAT karo** — ye purana single-user
  fallback hai. Multi-user flow me har user apna QID/password `/qums-setup` se
  khud connect karta hai (DB me encrypted). Kisi ka personal QUMS account
  production fallback nahi hona chahiye.
- Fallback order (`src/server.js`): `APP_BASE_URL` → `RENDER_EXTERNAL_URL` (Render
  khud set karta hai) → `http://localhost:<PORT>` (sirf local dev). Trailing `/`
  normalize hota hai, isliye `//reset` bug possible hi nahi.
- `NODE_ENV=production` secure cookies (HTTPS-only) on karta hai. Bhool bhi jao to
  Render ka auto `RENDER=true` env var prod-detect kar leta hai.

### 3. Password reset configuration

- Forgot-password par token banta hai (SHA-256 hashed DB me, 1 hour expiry, single-use).
- Reset link: `${APP_BASE_URL}/reset?token=<TOKEN>` — email provider configured ho to email jaata hai.
- **Email delivery (`src/mailer.js`) — priority order:**
  1. **Resend (recommended)**: `.env` me `RESEND_API_KEY` (resend.com → API Keys →
     "Create API Key"). Free tier me default from (`onboarding@resend.dev`) se mail
     sirf APNE khud ke Resend-account email pe jaata hai; production ke liye Resend
     dashboard → Domains me apna domain verify karke `RESEND_FROM=QUMS Attendance
     Bot <noreply@yourdomain.com>` set karo.
  2. **SMTP fallback** (sirf jab `RESEND_API_KEY` na ho): e.g. Gmail —
     `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=587`, `SMTP_USER`/`SMTP_PASS` =
     **Gmail App Password** (normal password nahi chalega,
     https://myaccount.google.com/apppasswords se banao).
  3. **Local dev console**: bina dono ke link console me print hota hai (sirf
     non-production; production logs me token/link KABHI print nahi hota).
- Reset page `/reset?token=...` token pre-fill karke `/api/reset` ko POST karta hai.

### 4. Health endpoint

`GET /health` → `{ "ok": true, "status": "ok", uptimeSeconds, timestamp }`
— koi secrets/user counts nahi. Render Health Check Path isi ko point karo.

### 5. Render ephemeral filesystem (IMPORTANT limitation)

Render Web Service ka disk **ephemeral** hai — har deploy/restart pe `data/` reset
ho jata hai. Is project ka runtime data JSON files me hai:

| File/dir | Data | Deploy pe |
| --- | --- | --- |
| `data/db.json` | users, password hashes, QUMS encrypted passwords, known attendance | **LOST** (re-register/re-setup) |
| `data/app-sessions/` | login sessions | LOST (sab logout) |
| `data/qums-sessions/` | QUMS portal sessions | LOST (QUMS Setup dobara) |
| `data/notified_periods/` | watcher dedupe state | LOST (duplicate alerts possible) |
| `data/session_alert_state.json` | alert cooldown | LOST (cosmetic) |

**Minimal reliable fix (migration ke bina):** Render Dashboard → Service →
**Disks** → Persistent Disk add karo, Mount Path = `/opt/render/project/src/data`
(project ke `data/` folder pe). Ye disk deploy ke beech survive karta hai —
saara JSON data wahi rehta hai. Uske bina JSON-file storage temporary hai —
ye documented limitation hai (full DB migration is deliberately out of scope).

## Deployment (VPS guide — headless-safe hai)

Login/captcha flow ab **poora headless** hai (captcha web dashboard pe solve hota
hai, koi browser window nahi khulti) — isliye remote server pe bhi chalta hai.

**Best option: VPS (DigitalOcean / Hetzner / Linode / AWS Lightsail)**
- ~$5-6/month ka basic droplet (1-2 GB RAM) kaafi hai shuru me
- Ubuntu 22.04 + Node.js 18+ install, project clone karo
- `npx playwright install-deps chromium` (system dependencies)
- `pm2` se background process + crash auto-restart:
  ```bash
  npm install -g pm2
  pm2 start src/server.js --name qums-bot
  pm2 save
  pm2 startup   # server reboot pe bhi auto-start
  pm2 logs qums-bot   # live logs
  ```
- Domain chahiye to Nginx reverse-proxy (optional — IP:port se bhi chal jaata hai)

**Render/Railway free tier kyun risky hai:** inactivity pe sleep (watcher/scheduler
miss), aur Playwright + Chromium ko 500MB-1GB+ RAM chahiye — free tier limit se
zyada ho sakta hai.

**Deploy ke baad checklist:**
- [ ] `.env` production values ke saath set hai (VPS) ya Render env vars set hain (Render)
- [ ] `APP_BASE_URL` production URL hai — reset link `localhost` NAHI dikhata
- [ ] `data/` folder persist ho raha hai (VPS normal filesystem — automatic; Render pe Persistent Disk)
- [ ] Telegram bot server se reachable (polling mode — usually koi issue nahi)
- [ ] QUMS Setup → "Reconnect QUMS" web captcha server pe bhi chal raha hai
- [ ] `/health` 200 `{ok:true}` return kar raha hai

## Security notes

- App login password **bcrypt-hashed**, QUMS password **AES-256-GCM encrypted**
  (`ENCRYPTION_KEY`) — plain text kabhi store/log nahi hota.
- Session cookie: `httpOnly`, `SameSite=Lax`, 90 din, file store (restart-safe),
  production me `secure` (HTTPS-only) + `trust proxy` (Render reverse proxy).
- Forgot-password: SHA-256 hashed single-use token, 1 hour expiry. SMTP optional
  local dev ke liye (bina iske link dev console me); **production me reset
  link/token logs me print NAHI hota** — SMTP hi delivery channel hai.
- Auth endpoints (`/api/register|login|forgot|reset`) pe minimal in-memory rate
  limiting (15 min window: login 20, register 10, forgot 5, reset 10 req/IP).
- Error handling: production me 500 responses generic hote hain (stack traces /
  internal messages leak nahi hote); `unhandledRejection`/`uncaughtException`
  logged hote hain, server crash nahi hota.
- CORS: koi cross-origin API nahi — frontend same-origin hai (relative `/api/...`
  fetches), isliye `Access-Control-Allow-Origin: *` ki zaroorat hi nahi.
- `.env`, `data/` (db.json + QUMS sessions + watcher state), `session_state.json`,
  debug dumps (`debug-*.txt/json`) — sab git-ignored.
- CSRF: same-site cookie + JSON-only APIs. Multi-user deploy pe HTTPS zaroor
  (`NODE_ENV=production` + reverse proxy).
- Bot sirf **apne registered users** ke apne QUMS accounts ka data scrape karta hai
  (unki di hui credentials se). Responsible use + university policy follow karo.

## License

Copyright © 2026 Karan Kumar.

This project is publicly available for viewing and educational reference.
Unauthorized copying, redistribution, or presenting this project as your own work is not permitted.