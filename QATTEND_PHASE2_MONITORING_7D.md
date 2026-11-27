# QAttend — Phase 2 Production Egress Monitoring Ledger (7-Day Protocol)

**Deployment Commit:** `24ab53a2bbec91244e8c148bb66a87c1aa93eb8d`  
**Branch:** `main`  
**Production Hosting:** Render (`https://qattend.onrender.com`)  
**Database:** Supabase PostgreSQL 15.8 (Shared Pooler / PgBouncer Port 6543)  
**Phase 2 Go-Live Timestamp:** `2026-11-23T13:05:30+05:30` (IST) / `2026-11-23T07:35:30Z` (UTC)  
**T0 Phase 2 Baseline Snapshot:** `2026-11-23T13:16:20+05:30` (IST) / `2026-11-23T07:46:20Z` (UTC)  
**Phase 1 Comparative Benchmark:** **355.228 MB/day** (Average across 17–20 Nov 2026)  
**Monitoring Duration:** 7 Calendar Days (23 November 2026 – 30 November 2026)  
**Status:** **ACTIVE PRODUCTION MONITORING FREEZE**

---

## 1. Monitoring Invariants & Operational Rules

1. **Strict Production Freeze:** Zero application code changes, zero database schema mutations, zero database record writes (except regular bot watcher operations), and zero environment variable changes.
2. **Phase 3 Hold:** Do not begin Phase 3 development or introduce additional optimizations during this 7-day monitoring window.
3. **Preservation of PostgreSQL Telemetry:** `pg_stat_statements_reset()` must **NEVER** be executed. All metrics must remain cumulative from the original database postmaster start time (`2026-09-27T19:17:20.032Z`).
4. **Strict Data Separation:** Explicitly segregate:
   - **Metered Measurements:** Actual billing-grade metrics from Supabase Usage (Shared Pooler Egress for QAttend project).
   - **Database Statistics:** Exact call counts, rows, and execution times from `pg_stat_statements`.
   - **Estimates / Projections:** Mathematical extrapolations clearly labeled as estimates.
   - **Unavailable Data:** In-progress billing periods clearly marked as pending rollup.
5. **Attribution Isolation:** Monitor Shared Pooler Egress for the **QAttend project only**; do not conflate with organization-wide usage.

---

## 2. Monitored Query IDs & T0 Phase 2 Baseline Telemetry

Captured atomically at **23 November 2026, 13:16:20 IST (`2026-11-23T07:46:20Z`)**:

| Target Category | Query ID (`queryid`) | SQL Signature Snippet | T0 Calls | T0 Rows | T0 Mean Exec Time | Expected Phase 2 Trajectory |
| :--- | :--- | :--- | :---: | :---: | :---: | :--- |
| **Individual Session State** | `-1183520529616293624` | `SELECT * FROM session_expiry_state WHERE user_id=$1` | $737,909$ | $736,264$ | $0.0309\text{ ms}$ | **$0.0\text{ calls/day}$** in watcher loop |
| **Batch Session State** | `-8990317778325448719` | `SELECT * FROM session_expiry_state` | $2$ | $167$ | $0.1099\text{ ms}$ | $\le 480\text{ calls/day}$ (60s cache TTL) |
| **Single-User Read** | `-6335404696379550646` | `SELECT * FROM users WHERE id=$1 LIMIT $2` | $210,835$ | $210,835$ | $0.0588\text{ ms}$ | **$0.0\text{ calls/day}$** in watcher loop (30s cache TTL) |
| **Optimized allUsers** | `-4832096866375465887` | `SELECT id, email, password_hash, ... CASE WHEN qums_session_data...` | $1,795$ | $353,418$ | $6.9468\text{ ms}$ | Stable cadence ($\sim 480\text{ calls/day}$) |
| **Old allUsers (Query A)** | `7569354379956355443` | `SELECT * FROM users ORDER BY created_at` | $9,188$ | $185,560$ | $0.6869\text{ ms}$ | **EXTINCT ($0.0\text{ calls/day}$)** |
| **Old allUsers (Query B)** | `5592152788053615507` | `SELECT * FROM users ORDER BY created_at` | $1,903$ | $321,434$ | $5.4151\text{ ms}$ | **EXTINCT ($0.0\text{ calls/day}$)** |
| **Known Attendance** | `4027250241884555484` | `SELECT records FROM known_attendance WHERE user_id=$1` | $135,480$ | $134,864$ | $1.1548\text{ ms}$ | Proportional to active users ($\sim 63$) |
| **Touch User Sync** | `4643820012833550049` | `UPDATE users SET attendance_last_checked_at=NOW()...` | $130,132$ | $130,132$ | $0.3672\text{ ms}$ | Proportional to active users ($\sim 63$) |

---

## 3. Seven-Day Production Checkpoint Schedule

| Checkpoint | Measurement Window | Target Timestamp (UTC) | Target Timestamp (IST) | Supabase Daily Egress | Shared Pooler % | Individual SES Delta | Batch SES Calls | Old allUsers Delta | Reconnect / ERP Check | Render Status | Report Status |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **T0 Baseline** | Phase 2 Go-Live | `2026-11-23T07:46:20Z` | 23 Nov 2026, 13:16 IST | Partial (In Progress) | 100% | 0 | 2 | 0 | PASSED | HTTP 200 | **COMPLETED** |
| **Day 1** | 24 Nov 00:00–23:59 UTC | `2026-11-24T23:59:59Z` | 25 Nov 2026, 05:29 IST | Scheduled | Scheduled | Scheduled | Scheduled | Scheduled | Scheduled | Scheduled | **PENDING** |
| **Day 2** | 25 Nov 00:00–23:59 UTC | `2026-11-25T23:59:59Z` | 26 Nov 2026, 05:29 IST | Scheduled | Scheduled | Scheduled | Scheduled | Scheduled | Scheduled | Scheduled | **PENDING** |
| **Day 3** | 26 Nov 00:00–23:59 UTC | `2026-11-26T23:59:59Z` | 27 Nov 2026, 05:29 IST | Scheduled | Scheduled | Scheduled | Scheduled | Scheduled | Scheduled | Scheduled | **PENDING** |
| **Day 4** | 27 Nov 00:00–23:59 UTC | `2026-11-27T23:59:59Z` | 28 Nov 2026, 05:29 IST | Scheduled | Scheduled | Scheduled | Scheduled | Scheduled | Scheduled | Scheduled | **PENDING** |
| **Day 5** | 28 Nov 00:00–23:59 UTC | `2026-11-28T23:59:59Z` | 29 Nov 2026, 05:29 IST | Scheduled | Scheduled | Scheduled | Scheduled | Scheduled | Scheduled | Scheduled | **PENDING** |
| **Day 6** | 29 Nov 00:00–23:59 UTC | `2026-11-29T23:59:59Z` | 30 Nov 2026, 05:29 IST | Scheduled | Scheduled | Scheduled | Scheduled | Scheduled | Scheduled | Scheduled | **PENDING** |
| **Day 7 (Final)** | 30 Nov 00:00–23:59 UTC | `2026-11-30T23:59:59Z` | 01 Dec 2026, 05:29 IST | Scheduled | Scheduled | Scheduled | Scheduled | Scheduled | Scheduled | Scheduled | **PENDING** |

---

## 4. Benchmark Comparison Methodology

For each measured day $d \in \{1, 2, \dots, 7\}$:

1. **Absolute Delta vs. Phase 1 Average:**
   $$\Delta E_d = E_d - 355.228\text{ MB}$$
2. **Percentage Change vs. Phase 1 Average:**
   $$\% \text{ Delta} = \left(\frac{E_d - 355.228}{355.228}\right) \times 100\%$$
3. **Percentage Savings vs. Pre-Optimization Baseline (633.621 MB/day on 16 Nov):**
   $$\% \text{ Net Savings} = \left(\frac{633.621 - E_d}{633.621}\right) \times 100\%$$
4. **Cumulative 7-Day Phase 2 Average:**
   $$\overline{E}_{\text{Phase 2}} = \frac{1}{N} \sum_{i=1}^N E_i$$

---

## 5. Verification Protocols for Daily Audits

### 5.1 ERP Scrape Exclusion Protocol
* Query `users` and `session_expiry_state` where `s.expired_at IS NOT NULL AND s.resolved_at IS NULL`.
* Assert that `MAX(u.attendance_last_checked_at)` for this cohort remains $\le \text{Deployment Timestamp}$ (`2026-11-23T07:26:11.062Z`).
* Assert that active users (`s.expired_at IS NULL OR s.resolved_at IS NOT NULL`) continue updating at current time $t$.

### 5.2 Reconnect & Catchup Notification Deduplication Protocol
* Query `notification_log` for records where `type = 'qums_reconnected'` or `type = 'attendance_catchup'`.
* Assert that every catch-up entry adheres to composite deduplication keys:
  `attendance_catchup:{userId}:{date}:{subjectCode}:{oldStatus}->{newStatus}`
* Confirm that no duplicate alerts are dispatched to Telegram.

### 5.3 Render Infrastructure Health Protocol
* Query `GET https://qattend.onrender.com/health`.
* Verify `ok === true`, `status === 'ok'`, and track `uptimeSeconds`.
* Monitor memory consumption and ensure zero unhandled rejections or container crash restarts.

---

## 6. Daily Ledger & Snapshot Log

*(To be populated exclusively with measured readings at each daily checkpoint. Future rows remain pending without fabrication).*

| Date | Total Egress (MB) | Shared Pooler (MB) | Pooler % | Indiv SES Calls (Delta) | Batch SES Calls (Delta) | Users $id=$1 Calls (Delta) | Active Users Scraped | Expired Users Scraped | Duplicate Alerts | Render Uptime / Restarts | Verdict |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **23 Nov (T0)** | *In progress* | *In progress* | 100% | 0 | 2 | 0 | 63 | **0** | **0** | 567s / 0 restarts | **PASS** |
| **24 Nov (D1)** | — | — | — | — | — | — | — | — | — | — | *Pending* |
| **25 Nov (D2)** | — | — | — | — | — | — | — | — | — | — | *Pending* |
| **26 Nov (D3)** | — | — | — | — | — | — | — | — | — | — | *Pending* |
| **27 Nov (D4)** | — | — | — | — | — | — | — | — | — | — | *Pending* |
| **28 Nov (D5)** | — | — | — | — | — | — | — | — | — | — | *Pending* |
| **29 Nov (D6)** | — | — | — | — | — | — | — | — | — | — | *Pending* |
| **30 Nov (D7)** | — | — | — | — | — | — | — | — | — | — | *Pending* |
