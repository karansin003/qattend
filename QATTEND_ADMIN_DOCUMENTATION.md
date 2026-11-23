# QAttend — Admin Panel & Administrative Controls

QAttend provides **two administrative interfaces** sharing the same PostgreSQL/JSON backend:
1. **Web Admin Portal:** `GET /admin` (`public/admin.html` + `/api/admin/*` in `src/server.js`).
2. **Telegram Admin Panel:** `/admin` command (`src/telegram-admin.js`).

---

## 1. Admin Authentication & Permission Enforcement

### 1.1 Web Admin (`src/server.js`)
- **`isUserAdmin(user)` (lines 148–153):** Returns `true` if `user.isAdmin === true` **OR** `user.email.toLowerCase()` is included in the comma-separated `process.env.ADMIN_EMAILS` environment variable.
- **`requireAdmin` middleware (lines 155–195):**
  1. Verifies `req.session.userId` resolves to an existing `users` row (`401` / `/login` if missing).
  2. Rejects suspended admins (`user.isSuspended` → clears session, `403 ACCOUNT_SUSPENDED`).
  3. Rejects unverified admins (`!user.emailVerified` → `403 EMAIL_VERIFICATION_REQUIRED` / `/verify-email`).
  4. Enforces `isUserAdmin(user)` (`403 ADMIN_REQUIRED` for APIs, `403 Forbidden` HTML for `/admin`).
- **Admin Role Assignment:** There is **no UI or API endpoint** to promote/demote admins (`setUserAdmin` exists in `src/db.js:1048`, but is not wired to any route). Admin status is granted via `ADMIN_EMAILS` env var or directly setting `users.is_admin = TRUE` in Supabase.

### 1.2 Telegram Admin (`src/telegram-admin.js`)
- **`isChatAdmin(chatId)` (lines 60–67):** Looks up the user owning `chatId` via `db.getUserByTelegramChatId(chatId)` and checks `user.isAdmin || ADMIN_EMAILS.includes(user.email.toLowerCase())`.
- Enforced on `/admin` command, every `adm:*` callback query, and admin broadcast text input (`handleAdminMessageText`).

---

## 2. Web Admin Portal Features (`public/admin.html` & `src/server.js`)

### 2.1 Analytics & Metrics Cards (`GET /api/admin/health` & `db.adminStats()`)
Displays 8 clickable metric cards (5 double as quick filters):
- `Total Users`, `QUMS Connected`, `Session Expired`, `Telegram Linked`, `Reconnected via Telegram`, `Reconnected via Webpage`, `Suspended Users`, `Notifications Sent` (30-day & total counts from `notifications`).
- Also computes `newUsers24h`, `newUsers7d`, `newErpConnected`, `oldErpConnected`, and `admins` in `db.adminStats()`.

### 2.2 System Health Monitoring (`GET /api/admin/health`)
Displays live health cards for:
1. **Database:** Live `SELECT 1` latency (`db.ping()`) and mode (`postgres` vs `json`).
2. **Telegram Bot:** `configured`, `ready`, `@username` (`POLLING` vs `SEND-ONLY` vs `DISABLED`).
3. **Attendance Watcher:** `watcherStatus` (`armed`, `fastLastRunAt`, `concurrency`).
4. **Assignment Watcher:** `assignmentStatus` (`armed`, `lastNewAt`).
5. **8:30 AM Scheduler:** `schedulerStatus`. *(Audit Note: `schedulerStatus` in `src/scheduler.js` is initialized with `armed: false` and never updated during `startScheduler` or `runMorningScheduleJob`, so `admin.html` hardcodes the `SCHEDULED` badge regardless of backend `data.scheduler`.)*
6. **Firebase Admin:** Shows whether `firebase-admin` is configured (`CONNECTED` vs `KEY NEEDED`), with buttons to configure credentials or delete a Firebase user directly.

### 2.3 User Management Table (`GET /api/admin/users`)
- **Pagination:** `page` (default `1`), `limit` (`25` in UI, clamped `5..100` on server).
- **Multi-Filter Search (`db.applyAdminFilters`):**
  - Text search across `studentName`, `email`, `qumsQid`, `newErpEmail`, `rawQid`.
  - `qumsFilter`: `all` | `connected` | `expired` | `not_setup` | `new_erp` | `old_erp`.
  - `telegramFilter`: `all` | `linked` | `unlinked`.
  - `reconnectFilter`: `all` | `telegram` | `web` | `never`.
  - `statusFilter`: `all` | `active` | `suspended` | `unverified`.
  - Legacy `filter`: `all` | `admin` | `qums_connected` | `session_expired` | `telegram_connected` | `suspended` | `active` | `old_erp` | `new_erp`.
- **Privacy Filter (`db.safeAdminUser`):** Strips `passwordHash`, `qumsPasswordEncrypted`, `newErpPasswordEncrypted`, `qumsSessionData`, `newErpSessionData`, and `telegramLinkCode` before sending to the admin client.
- **Select All Across Pages:** `GET /api/admin/users/all-ids` returns matching IDs. *(Audit Note: `getMatchingUserIdsForAdmin` only passes `{ search, filter }`, ignoring `qumsFilter`, `telegramFilter`, `reconnectFilter`, `statusFilter`.)*

### 2.4 Excel Export (`GET /api/admin/export/excel`)
- Uses `xlsx` (`SheetJS`) to generate `qattend-users-YYYY-MM-DD.xlsx` with two worksheets:
  1. **`Users`:** Filtered users with S.No, User ID, ERP Type, Student Name, Email, New ERP Email, QID, Year & Semester, Session Status, Telegram Connected, Account Status, Reconnect Source/Counts/Timestamp, Last Checked timestamps, Created timestamp.
  2. **`Summary & Metrics`:** Aggregate stats and export IST timestamp.

### 2.5 User Suspension & Dual Deletion
- **Suspend / Unsuspend (`POST /api/admin/users/:id/suspend`):**
  - Prevents self-suspension (`400`). Toggles `users.is_suspended`. Suspended users are immediately blocked by `requireAuth` and skipped by `watcher.js` and `scheduler.js`.
- **Permanent Dual Deletion (`POST /api/admin/users/:id/delete` & `DELETE /api/admin/users/:id`):**
  - Prevents self-deletion (`400`).
  - Releases ERP registry locks (`releaseAllUserSessions`).
  - Unlinks disk files: `data/qums-sessions/<id>.json`, `data/new-erp-sessions/<id>.json`, `data/notified_periods/<id>.json`.
  - Deletes user from Firebase Auth, Firestore `users/<uid>`, and RTDB `users/<uid>` via `firebaseAuth.deleteFirebaseUser()`.
  - Deletes all rows for that user across 14 PostgreSQL tables (`db.deleteUser`).

### 2.6 Firebase Admin Credentials & Direct Deletion
- **`POST /api/admin/firebase-credentials`:** Accepts raw or base64 Service Account JSON, saves it to `system_settings` (`key = 'firebase_service_account_key'`), and hot-initializes `firebase-admin` in memory.
- **`POST /api/admin/firebase-users/delete`:** Directly calls `firebaseAuth.deleteFirebaseUser({ email, uid })` to purge orphaned Firebase accounts.

### 2.7 Bulk Telegram Reconnect Dispatch (`POST /api/admin/users/bulk-reconnect-notify`)
- Accepts up to `1000` `userIds`, skips unlinked users, dispatches session-expiry/reconnect prompts with `100ms` pacing between users, and renders a delivery report modal (`Sent`, `Skipped`, `Failed`, plus `Retry Failed Only`).

---

## 3. Telegram Admin Panel (`src/telegram-admin.js`)

Triggered by sending `/admin` or `admin` from a Telegram chat linked to an admin user. Uses an in-memory state machine (`adminStates` Map per `chatId`).

### 3.1 Implemented Menu & Callbacks
- **Main Menu (`buildMainMenuKeyboard`):**
  1. `📊 Dashboard` (`adm:menu:dash`) — live user/session/DB counts.
  2. `👥 Manage Users` (`adm:menu:users:1`) — paginated list (8/page) with masked identifiers (`maskIdentifier`: e.g., `ka***@gmail.com`, `24***81`).
  3. `☑️ Select Multiple Users` (`adm:menu:select:1`) — checkbox toggle (`adm:toggle:<id>:<page>`), select page (`adm:sel_all_page`), select all matching (`adm:sel_all_filter`), deselect (`adm:desel_all`).
  4. `⏸️ Suspend Users` (`adm:menu:suspend` / `adm:bulk_suspend`) — suspends selected users, releases ERP sessions, logs `BULK_SUSPEND` to `admin_audit_logs`.
  5. `🗑️ Delete Users` (`adm:menu:delete` / `adm:bulk_delete`) — **two-stage confirmation** (`adm:delete_step_2` → `adm:execute_bulk_delete`), unlinks files, deletes from Firebase & Supabase, logs `BULK_DELETE` to `admin_audit_logs`.
  6. `✉️ Send Custom Message` (`adm:menu:msg` / `adm:bulk_msg`) — sets `pendingAction = 'AWAITING_CUSTOM_MESSAGE'`, previews recipient count, broadcasts `📢 Announcement` to selected or ALL non-suspended linked users at `100ms` delay (`adm:confirm_send_broadcast` → `executeBroadcast`), logs `BROADCAST_MESSAGE` to `admin_audit_logs`.
  7. Quick filters: `Active Sessions` (`adm:filter:active:1`), `Old ERP Users` (`adm:filter:old_erp:1`), `New ERP Users` (`adm:filter:new_erp:1`), `Suspended Users` (`adm:filter:suspended:1`), `Admin Users` (`adm:filter:admin:1`).
  8. `🩺 System Status` (`adm:menu:status`) — DB schema health, latency, PID.
  9. `📜 Audit Logs` (`adm:menu:audit:1`) — paginated reader for `admin_audit_logs` (5/page).
  10. `❌ Close Admin Panel` (`adm:menu:close`).

### 3.2 Incomplete / Unhandled Callbacks in `src/telegram-admin.js`
1. **Single-User Detail Action Buttons:** `buildUserDetailKeyboard` (lines 231–250) renders `adm:user_delete_prompt:<id>:<page>`, `adm:user_msg:<id>`, and `adm:user_release_session:<id>:<page>`, **none of which have handlers in `handleAdminCallbackQuery`**, so tapping those three buttons does nothing (`adm:user_suspend` and `adm:user_reactivate` DO work).
2. **Audit Log Asymmetry:** Telegram Admin actions write to `admin_audit_logs`, whereas Web Admin actions (`/api/admin/users/:id/suspend`, `delete`, `bulk-reconnect-notify`, `firebase-credentials`) log only to `console` and **do not** insert into `admin_audit_logs`.
3. **Database Management:** No general SQL/table editor or database backup/restore UI exists (only `schemaHealth`, `ping`, and user deletion).

