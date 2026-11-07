/**
 * App database — tiny built-in JSON store (data/db.json, atomic write via
 * temp+rename). NOTE: lowdb v5/v6/v7 me export-path/ESM issues the (Node 24),
 * isliye ek hi file me 40-line store kaafi hai — same "halka, file-based,
 * zero setup" spirit. Multi-user schema:
 *   users:  { id, email, passwordHash (bcrypt),
 *             qumsQid, qumsPasswordEncrypted (AES-256-GCM), qumsSessionPath,
 *             telegramLinkCode, telegramChatId, createdAt }
 *   resets: { email, tokenHash, expiresAt }  (forgot-password tokens, 1h)
 *
 * QUMS password is NEVER stored in plain text — see src/crypto.js.
 */
// const path = require('path');
// const fs = require('fs');
// const crypto = require('crypto');

// const DB_FILE = path.join(__dirname, '..', 'data', 'db.json');
// const QUMS_SESSION_DIR = path.join(__dirname, '..', 'data', 'qums-sessions');

// fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
// fs.mkdirSync(QUMS_SESSION_DIR, { recursive: true });

// let data = { users: [], resets: [], knownAttendance: [], weeklySchedule: [] };
// try {
//   const raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
//   data = {
//     users: raw.users || [],
//     resets: raw.resets || [],
//     knownAttendance: raw.knownAttendance || [],
//     weeklySchedule: raw.weeklySchedule || [],
//   };
// } catch {
//   /* first run — defaults */
// }

// // Machine-portable QUMS sessions: db.json me store kiya gaya qumsSessionPath
// // PURANE machine ka absolute path ho sakta hai (e.g. Mac -> Windows/Render
// // migrate karte waqt). Session file HAMESHA canonical path pe hoti hai
// // (qums-login-web.js isi pe save karta hai), isliye load pe normalize karo.
// // Isse multi-user deploy machine-agnostic ban jata hai — koi user-specific
// // path db me "sach" nahi hota.
// let sessionPathsFixed = false;
// for (const u of data.users) {
//   if (u.qumsSessionPath) {
//     const canonical = path.join(QUMS_SESSION_DIR, `${u.id}.json`);
//     if (u.qumsSessionPath !== canonical) {
//       u.qumsSessionPath = canonical;
//       sessionPathsFixed = true;
//     }
//   }
// }
// if (sessionPathsFixed) persist();

// function persist() {
//   const tmp = `${DB_FILE}.tmp`;
//   fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
//   fs.renameSync(tmp, DB_FILE);
// }

// function newId() {
//   return crypto.randomBytes(8).toString('hex');
// }

// function hasUsers() {
//   return data.users.length > 0;
// }

// function allUsers() {
//   return data.users.slice();
// }

// function getUserByEmail(email) {
//   const e = String(email || '').trim().toLowerCase();
//   return data.users.find((u) => u.email === e) || null;
// }

// function getUserById(id) {
//   return data.users.find((u) => u.id === id) || null;
// }

// function createUser({ email, passwordHash }) {
//   const user = {
//     id: newId(),
//     email: String(email).trim().toLowerCase(),
//     passwordHash,
//     qumsQid: '',
//     qumsPasswordEncrypted: '',
//     qumsSessionPath: '',
//     telegramLinkCode: '',
//     telegramChatId: '',
//     createdAt: new Date().toISOString(),
//   };
//   data.users.push(user);
//   persist();
//   return user;
// }

// function updateUser(id, patch) {
//   const user = getUserById(id);
//   if (user) Object.assign(user, patch);
//   persist();
//   return getUserById(id);
// }

// function sessionPathFor(userId) {
//   return path.join(QUMS_SESSION_DIR, `${userId}.json`);
// }

// // ---- forgot-password tokens ----
// function tokenHash(token) {
//   return crypto.createHash('sha256').update(String(token)).digest('hex');
// }

// function storeResetToken(email, token) {
//   // ek email pe ek hi active token
//   data.resets = data.resets.filter((r) => r.email !== String(email).toLowerCase());
//   data.resets.push({
//     email: String(email).toLowerCase(),
//     tokenHash: tokenHash(token),
//     expiresAt: Date.now() + 60 * 60 * 1000, // 1 hour
//   });
//   persist();
// }

// function consumeResetToken(token) {
//   const h = tokenHash(token);
//   const rec = data.resets.find((r) => r.tokenHash === h) || null;
//   if (!rec) return null;
//   data.resets = data.resets.filter((r) => r.tokenHash !== h);
//   persist();
//   if (Date.now() > rec.expiresAt) return null;
//   return getUserByEmail(rec.email);
// }

// // ---- known attendance (month-register dedupe; "known_attendance" table) ----
// // Per-user records: { key, date, subjectCode, subject, status, teacher,
// //                     lectureIndex, lecturesThatDay, seenAt }
// const KNOWN_ATTENDANCE_CAP = 5000; // per user — purani entries chhod do

// function knownAttendanceEntry(userId) {
//   return data.knownAttendance.find((k) => k.userId === userId) || null;
// }

// function listKnownAttendance(userId) {
//   const entry = knownAttendanceEntry(userId);
//   return entry ? entry.records.slice() : [];
// }

// function addKnownAttendance(userId, records) {
//   let entry = knownAttendanceEntry(userId);
//   if (!entry) {
//     entry = { userId, records: [] };
//     data.knownAttendance.push(entry);
//   }
//   const seen = new Set(entry.records.map((r) => r.key));
//   let added = 0;
//   for (const rec of records || []) {
//     if (!rec || !rec.key || seen.has(rec.key)) continue;
//     entry.records.push({ ...rec, seenAt: new Date().toISOString() });
//     seen.add(rec.key);
//     added += 1;
//   }
//   if (entry.records.length > KNOWN_ATTENDANCE_CAP) {
//     entry.records = entry.records.slice(-KNOWN_ATTENDANCE_CAP);
//   }
//   if (added) persist();
//   return added;
// }

// function removeKnownAttendance(userId, keys) {
//   const entry = knownAttendanceEntry(userId);
//   if (!entry) return 0;
//   const drop = new Set(Array.isArray(keys) ? keys : [keys]);
//   const before = entry.records.length;
//   entry.records = entry.records.filter((r) => !drop.has(r.key));
//   const removed = before - entry.records.length;
//   if (removed) persist();
//   return removed;
// }

// // ---- weekly schedule cache (7-day TTL; PK: userId + dayOfWeek + period) ----
// // Spec: student ka weekly timetable fixed/repeating hota hai. Pehle hafte har
// // din live scrape se cache build hoti hai; uske baad morning message mostly
// // cache se fast banta hai, aur har 7 din me ek baar auto-refresh ho jata hai.
// const WEEKLY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// function weeklyRowsFor(userId, dayOfWeek) {
//   return data.weeklySchedule.filter(
//     (r) => r.userId === userId && r.dayOfWeek === dayOfWeek
//   );
// }

// /** rows: [{ period, subject, subjectCode, teacher, room }] — upsert (PK per period). */
// function upsertWeeklySchedule(userId, dayOfWeek, rows) {
//   let changed = false;
//   for (const row of rows || []) {
//     if (!row || !row.period) continue;
//     const hit = data.weeklySchedule.find(
//       (r) => r.userId === userId && r.dayOfWeek === dayOfWeek && r.period === row.period
//     );
//     const patch = {
//       subject: row.subject || '',
//       subjectCode: row.subjectCode || '',
//       teacher: row.teacher || '',
//       room: row.room || '',
//       lastUpdated: new Date().toISOString(),
//     };
//     if (hit) {
//       Object.assign(hit, patch);
//     } else {
//       data.weeklySchedule.push({ userId, dayOfWeek, period: row.period, ...patch });
//     }
//     changed = true;
//   }
//   if (changed) persist();
//   return (rows || []).length;
// }

/**
 * Cached rows for (userId, dayOfWeek). Returns:
 *   { fresh: Boolean, rows: [{ period, subject, subjectCode, teacher, room }] }
 * fresh = entries exist AND sab se nayi lastUpdated 7 din se purani nahi.
 */
// function getWeeklySchedule(userId, dayOfWeek) {
//   const rows = weeklyRowsFor(userId, dayOfWeek);
//   if (!rows.length) return { fresh: false, rows: [] };
//   const newest = Math.max(...rows.map((r) => Date.parse(r.lastUpdated) || 0));
//   const fresh = Date.now() - newest < WEEKLY_TTL_MS;
//   return {
//     fresh,
//     rows: rows.map((r) => ({
//       period: r.period,
//       duration: '',
//       subject: r.subject,
//       subjectCode: r.subjectCode,
//       teacher: r.teacher,
//       room: r.room,
//     })),
//   };
// }

// /** Force-refresh ke liye: (userId[, dayOfWeek]) ki cached entries delete. */
// function clearWeeklySchedule(userId, dayOfWeek) {
//   const before = data.weeklySchedule.length;
//   data.weeklySchedule = data.weeklySchedule.filter(
//     (r) => !(r.userId === userId && (dayOfWeek === undefined || r.dayOfWeek === dayOfWeek))
//   );
//   const removed = before - data.weeklySchedule.length;
//   if (removed) persist();
//   return removed;
// }

// // ---- telegram linking (deep-link flow; purane WhatsApp channel ki jagah) ----
// // users schema add: telegramLinkCode (dashboard->bot deep-link payload),
// //                   telegramChatId (/start par save hota hai)

// function telegramLinkCodeFor(userId) {
//   const user = getUserById(userId);
//   if (!user) return null;
//   if (!user.telegramLinkCode) {
//     user.telegramLinkCode = crypto.randomBytes(6).toString('hex'); // 12 hex chars
//     persist();
//   }
//   return user.telegramLinkCode;
// }

// function getUserByTelegramLinkCode(code) {
//   const c = String(code || '').trim();
//   if (!c) return null;
//   return data.users.find((u) => u.telegramLinkCode && u.telegramLinkCode === c) || null;
// }

// function getUserByTelegramChatId(chatId) {
//   const c = String(chatId || '').trim();
//   if (!c) return null;
//   return data.users.find((u) => u.telegramChatId && String(u.telegramChatId) === c) || null;
// }

// function setTelegramChatId(userId, chatId) {
//   const user = getUserById(userId);
//   if (!user) return null;
//   user.telegramChatId = String(chatId).trim();
//   persist();
//   return user;
// }

/**
 * PRIVACY GUARANTEE: ek Telegram chat sirf EK account se linked rahegi.
 * Naya /start <code> same chat pe aaye to dusre users ka is chat pe koi
 * binding khatam — warna purane user ke updates bhi isi chat pe aa sakte the.
 */
// function clearTelegramChatForChat(chatId, exceptUserId) {
//   const c = String(chatId || '').trim();
//   if (!c) return 0;
//   let cleared = 0;
//   for (const u of data.users) {
//     if (u.id !== exceptUserId && u.telegramChatId && String(u.telegramChatId) === c) {
//       u.telegramChatId = '';
//       cleared += 1;
//     }
//   }
//   if (cleared) persist();
//   return cleared;
// }

// function clearTelegramChatId(userId) {
//   const user = getUserById(userId);
//   if (!user) return null;
//   user.telegramChatId = '';
//   persist();
//   return user;
// }

// /** Test/cleanup helper — user row delete (cascade-ish: knownAttendance entry bhi). */
// function deleteUser(userId) {
//   const before = data.users.length;
//   data.users = data.users.filter((u) => u.id !== userId);
//   data.knownAttendance = data.knownAttendance.filter((k) => k.userId !== userId);
//   const removed = before - data.users.length;
//   if (removed) persist();
//   return removed;
// }

// module.exports = {
//   DB_FILE,
//   QUMS_SESSION_DIR,
//   hasUsers,
//   allUsers,
//   getUserByEmail,
//   getUserById,
//   createUser,
//   updateUser,
//   deleteUser,
//   sessionPathFor,
//   storeResetToken,
//   consumeResetToken,
//   listKnownAttendance,
//   addKnownAttendance,
//   removeKnownAttendance,
//   upsertWeeklySchedule,
//   getWeeklySchedule,
//   clearWeeklySchedule,
//   telegramLinkCodeFor,
//   getUserByTelegramLinkCode,
//   getUserByTelegramChatId,
//   setTelegramChatId,
//   clearTelegramChatId,
//   clearTelegramChatForChat,
// };


/**
 * App database — PostgreSQL in production, JSON fallback for local dev.
 * DATABASE_URL present => PostgreSQL. Otherwise data/db.json is used.
 *
 * Tables: users, resets, known_attendance, weekly_schedule.
 * users.firebase_uid maps an application user to its Firebase Auth account
 * (one application email == one application user == one Firebase user).
 */
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { MIGRATIONS, OPTIONAL_MIGRATIONS } = require('./migrations');

const DB_FILE = process.env.DB_FILE
  ? path.resolve(process.env.DB_FILE) // test isolation hook (e.g. assignments --test)
  : path.join(__dirname, '..', 'data', 'db.json');
const QUMS_SESSION_DIR = path.join(__dirname, '..', 'data', 'qums-sessions');
const NEW_ERP_SESSION_DIR = path.join(__dirname, '..', 'data', 'new-erp-sessions');

const USE_PG = Boolean(process.env.DATABASE_URL);

fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
fs.mkdirSync(QUMS_SESSION_DIR, { recursive: true });
fs.mkdirSync(NEW_ERP_SESSION_DIR, { recursive: true });

let pool = null;
let initPromise = null;
let data = {
  users: [],
  resets: [],
  knownAttendance: [],
  weeklySchedule: [],
  knownAssignments: [],
  sessionExpiry: [],
  notifications: [],
  qumsIdentities: [],
  attendanceRecords: [],
  assignmentsTable: [],
  notificationLogs: [],
  scheduledDeletions: [],
  activeErpSessions: [],
  adminAuditLogs: [],
  newErpTimetable: [],
  newErpAttendanceCache: [],
};

if (!USE_PG) {
  try {
    const raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    data = {
      users: raw.users || [],
      resets: raw.resets || [],
      knownAttendance: raw.knownAttendance || [],
      weeklySchedule: raw.weeklySchedule || [],
      knownAssignments: raw.knownAssignments || [],
      sessionExpiry: raw.sessionExpiry || [],
      notifications: raw.notifications || [],
      qumsIdentities: raw.qumsIdentities || [],
      attendanceRecords: raw.attendanceRecords || [],
      assignmentsTable: raw.assignmentsTable || [],
      notificationLogs: raw.notificationLogs || [],
      scheduledDeletions: raw.scheduledDeletions || [],
      activeErpSessions: raw.activeErpSessions || [],
      adminAuditLogs: raw.adminAuditLogs || [],
      newErpTimetable: raw.newErpTimetable || [],
      newErpAttendanceCache: raw.newErpAttendanceCache || [],
    };
  } catch {}

  let sessionPathsFixed = false;
  for (const u of data.users) {
    if (u.qumsSessionPath) {
      const canonical = path.join(QUMS_SESSION_DIR, `${u.id}.json`);
      if (u.qumsSessionPath !== canonical) {
        u.qumsSessionPath = canonical;
        sessionPathsFixed = true;
      }
    }
    if (u.newErpSessionPath) {
      const canonicalNew = path.join(NEW_ERP_SESSION_DIR, `${u.id}.json`);
      if (u.newErpSessionPath !== canonicalNew) {
        u.newErpSessionPath = canonicalNew;
        sessionPathsFixed = true;
      }
    }
  }
  if (sessionPathsFixed) persistJson();
}

function persistJson() {
  const tmp = `${DB_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

function newId() { return crypto.randomBytes(8).toString('hex'); }
function sessionPathFor(userId) { return path.join(QUMS_SESSION_DIR, `${userId}.json`); }
function sessionPathForNewErp(userId) { return path.join(NEW_ERP_SESSION_DIR, `${userId}.json`); }

/**
 * TLS for PostgreSQL (Supabase / Render).
 * Supabase requires SSL; its pooler presents a chain Node may not trust with
 * the bundled CAs, hence `rejectUnauthorized:false` (encryption stays on).
 * Override with DATABASE_SSL=disable (local Postgres) or DATABASE_SSL=verify.
 */
function sslConfig() {
  const mode = String(process.env.DATABASE_SSL || '').trim().toLowerCase();
  if (mode === 'disable' || mode === 'off' || mode === 'false') return undefined;
  if (mode === 'verify') return { rejectUnauthorized: true };
  const url = String(process.env.DATABASE_URL || '');
  const remote = /supabase\.(co|com|net)|render\.com|amazonaws\.com|neon\.tech/i.test(url) || url.includes('sslmode=require');
  if (remote || process.env.NODE_ENV === 'production') return { rejectUnauthorized: false };
  return undefined; // local Postgres without TLS
}

// ---------------------------------------------------------------------------
// Migrations (idempotent, statement-by-statement — see src/migrations.js)
// ---------------------------------------------------------------------------

/** Last run summary; exposed for the admin System Health panel. */
const lastMigrationRun = { at: null, applied: [], failed: [] };

async function runMigrations(log = console) {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  const done = new Set((await pool.query('SELECT id FROM schema_migrations')).rows.map((r) => r.id));
  const optional = OPTIONAL_MIGRATIONS.filter((m) => {
    const enabled = typeof m.enabled === 'function' ? m.enabled() : true;
    if (!enabled && !done.has(m.id)) {
      log.log(`[db] optional migration ${m.id} skipped (enable via its env flag when you are ready).`);
    }
    return enabled;
  });
  const pending = [...MIGRATIONS, ...optional].filter((m) => !done.has(m.id));

  for (const m of pending) {
    const failures = [];
    // One pool.query per statement: a failure aborts only that statement, so a
    // single bad statement can never leave later columns/tables uncreated
    // (this is exactly how users.student_name previously went missing).
    for (const stmt of m.statements) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await pool.query(stmt);
      } catch (err) {
        failures.push(`${err.message}`);
        log.error(`[db] migration ${m.id} statement failed: ${err.message}`);
      }
    }
    if (failures.length === 0) {
      // eslint-disable-next-line no-await-in-loop
      await pool.query('INSERT INTO schema_migrations(id) VALUES($1) ON CONFLICT(id) DO NOTHING', [m.id]);
      lastMigrationRun.applied.push(m.id);
      log.log(`[db] migration applied: ${m.id}`);
    } else {
      lastMigrationRun.failed.push({ id: m.id, errors: failures });
      log.error(`[db] migration ${m.id} incomplete (${failures.length} statement(s)) — idempotent, retried on next boot.`);
    }
  }
  lastMigrationRun.at = new Date().toISOString();
  return lastMigrationRun;
}

/** Live schema check used by the admin dashboard (real state, never faked). */
async function schemaHealth() {
  if (!USE_PG) return { ok: true, mode: 'json', missing: [], migrations: lastMigrationRun };
  await init();
  const expected = {
    users: ['id', 'email', 'password_hash', 'firebase_uid', 'student_name', 'qums_year_sem', 'is_admin', 'attendance_last_checked_at', 'assignment_last_checked_at', 'profile_synced_at'],
    known_attendance: ['user_id', 'records'],
    known_assignments: ['user_id', 'records'],
    session_expiry_state: ['user_id', 'expired_at', 'last_alert_at', 'resolved_at'],
    notifications: ['id', 'user_id', 'kind', 'sent_at'],
  };
  const r = await pool.query(
    "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = ANY (current_schemas(FALSE))"
  );
  const have = new Map();
  for (const row of r.rows) {
    if (!have.has(row.table_name)) have.set(row.table_name, new Set());
    have.get(row.table_name).add(row.column_name);
  }
  const missing = [];
  for (const [table, cols] of Object.entries(expected)) {
    const set = have.get(table);
    if (!set) { missing.push(`${table} (table)`); continue; }
    for (const c of cols) if (!set.has(c)) missing.push(`${table}.${c}`);
  }
  return { ok: missing.length === 0, mode: 'postgres', missing, migrations: lastMigrationRun };
}

/**
 * Deliberate, opt-in import of the local JSON store (IMPORT_JSON_DATA=1).
 * Skips instead of merging when the target already has users, and skips child
 * rows whose user is not in the imported set (no orphan foreign-key warnings).
 */
async function importLocalJsonData(log = console) {
  if (!fs.existsSync(DB_FILE)) {
    log.log('[db] IMPORT_JSON_DATA=1 but no local db.json found — nothing to import.');
    return { users: 0, skipped: true };
  }
  const raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  const existing = await pool.query('SELECT COUNT(*)::int AS n FROM users');
  if (existing.rows[0].n > 0) {
    log.error('[db] target database already has users — local JSON import SKIPPED (never merge into production data).');
    return { users: 0, skipped: true };
  }
  const ids = new Set();
  let imported = 0;
  for (const u of raw.users || []) {
    if (!u || !u.id || !u.email) continue;
    try {
      await pool.query(
        `INSERT INTO users (id,email,password_hash,qums_qid,qums_session_path,telegram_link_code,telegram_chat_id,firebase_uid,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (email) DO NOTHING`,
        [u.id, u.email, u.passwordHash || '', u.qumsQid || '', u.qumsSessionPath ? sessionPathFor(u.id) : '', u.telegramLinkCode || '', u.telegramChatId || '', u.firebaseUid || '', u.createdAt || new Date().toISOString()]
      );
      ids.add(u.id);
      imported += 1;
    } catch (err) {
      log.error(`[db] JSON import: user ${u.id} skipped (${err.message})`);
    }
  }
  let attendance = 0;
  let assignments = 0;
  for (const k of raw.knownAttendance || []) {
    if (!k || !ids.has(k.userId)) continue; // orphan guard
    await pool.query(`INSERT INTO known_attendance(user_id,records) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET records=EXCLUDED.records`, [k.userId, JSON.stringify(k.records || [])]);
    attendance += 1;
  }
  for (const k of raw.knownAssignments || []) {
    if (!k || !ids.has(k.userId)) continue; // orphan guard
    await pool.query(`INSERT INTO known_assignments(user_id,records) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET records=EXCLUDED.records`, [k.userId, JSON.stringify(k.records || [])]);
    assignments += 1;
  }
  log.log(`[db] JSON import done: users=${imported}, attendanceStates=${attendance}, assignmentStates=${assignments} (orphans skipped).`);
  return { users: imported, attendance, assignments, skipped: false };
}

async function init() {
  if (!USE_PG) return;
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const { Pool } = require('pg');
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: sslConfig(),
      max: Number(process.env.PG_POOL_MAX || 5),
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    });
    await runMigrations();

    // Optional local JSON -> PostgreSQL import.
    // DISABLED BY DEFAULT on purpose: the historical db.json in this repo is
    // developer test data, and importing it into production Supabase produced
    // orphaned-user foreign-key warnings. Enable deliberately with
    // IMPORT_JSON_DATA=1 (e.g. a one-off migration run), never implicitly.
    if (String(process.env.IMPORT_JSON_DATA || '') !== '1') {
      if (fs.existsSync(DB_FILE)) {
        console.log('[db] local db.json detected — import SKIPPED (set IMPORT_JSON_DATA=1 to migrate it deliberately).');
      }
    } else {
      await importLocalJsonData();
    }
  })();
  await initPromise;
}

async function hasUsers() {
  if (!USE_PG) return data.users.length > 0;
  await init();
  const r = await pool.query('SELECT EXISTS(SELECT 1 FROM users) AS exists');
  return r.rows[0].exists;
}

async function allUsers() {
  if (!USE_PG) return data.users.slice();
  await init();
  const r = await pool.query('SELECT * FROM users ORDER BY created_at');
  return r.rows.map(fromUserRow);
}

/**
 * Row -> app user.
 *
 * NOTE: `studentName` IS A CACHE of the QUMS profile name (source of truth =
 * the authenticated QUMS session; see scraper.refreshQumsProfile). The legacy
 * `qums_password_encrypted` column is intentionally NOT read any more — QAttend
 * never stores the QUMS password (the user types it on every setup/reconnect).
 */
/** Format Date into YYYY-MM-DD in Asia/Kolkata (IST). */
function getIstDateString(d = new Date()) {
  const dateObj = typeof d === 'string' || typeof d === 'number' ? new Date(d) : d;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(dateObj);
  const get = (t) => (parts.find((p) => p.type === t) || {}).value || '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function decodeSessionData(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('{')) {
    try {
      JSON.parse(trimmed);
      return trimmed;
    } catch {}
  }
  try {
    const { decryptSecret } = require('./crypto');
    const decrypted = decryptSecret(trimmed);
    if (decrypted && decrypted.trim().startsWith('{')) {
      JSON.parse(decrypted.trim());
      return decrypted.trim();
    }
  } catch {}
  return null;
}

async function ensureSessionOnDisk(userOrId) {
  if (!userOrId) return null;
  let user = typeof userOrId === 'string' ? await getUserById(userOrId) : userOrId;
  if (!user || !user.id) return null;

  const canonical = sessionPathFor(user.id);
  if (fs.existsSync(canonical)) {
    user.qumsSessionPath = canonical;
    return canonical;
  }

  let sessionData = user.qumsSessionData;
  if (!sessionData && USE_PG) {
    try {
      await init();
      const r = await pool.query('SELECT qums_session_data FROM users WHERE id=$1', [user.id]);
      if (r.rows[0] && r.rows[0].qums_session_data) {
        sessionData = r.rows[0].qums_session_data;
        user.qumsSessionData = sessionData;
      }
    } catch {}
  }

  const plainJson = decodeSessionData(sessionData);
  if (plainJson) {
    try {
      fs.mkdirSync(path.dirname(canonical), { recursive: true });
      fs.writeFileSync(canonical, plainJson, { mode: 0o600 });
      user.qumsSessionPath = canonical;
      return canonical;
    } catch (e) {
      console.error(`[db] failed to restore session on disk for user ${user.id}:`, e.message);
    }
  }
  return null;
}

async function saveUserSessionData(userId, rawJson) {
  if (!userId || !rawJson) return false;
  let dataToStore = rawJson;
  try {
    const { encryptSecret } = require('./crypto');
    dataToStore = encryptSecret(rawJson);
  } catch (err) {
    dataToStore = rawJson;
  }
  await updateUser(userId, { qumsSessionData: dataToStore });
  return true;
}

async function ensureNewErpSessionOnDisk(userOrId) {
  if (!userOrId) return null;
  let user = typeof userOrId === 'string' ? await getUserById(userOrId) : userOrId;
  if (!user || !user.id) return null;

  const canonical = sessionPathForNewErp(user.id);
  if (fs.existsSync(canonical)) {
    user.newErpSessionPath = canonical;
    return canonical;
  }

  let sessionData = user.newErpSessionData;
  if (!sessionData && USE_PG) {
    try {
      await init();
      const r = await pool.query('SELECT new_erp_session_data FROM users WHERE id=$1', [user.id]);
      if (r.rows[0] && r.rows[0].new_erp_session_data) {
        sessionData = r.rows[0].new_erp_session_data;
        user.newErpSessionData = sessionData;
      }
    } catch {}
  }

  const plainJson = decodeSessionData(sessionData);
  if (plainJson) {
    try {
      fs.mkdirSync(path.dirname(canonical), { recursive: true });
      fs.writeFileSync(canonical, plainJson, { mode: 0o600 });
      user.newErpSessionPath = canonical;
      return canonical;
    } catch (e) {
      console.error(`[db] failed to restore new erp session on disk for user ${user.id}:`, e.message);
    }
  }
  return null;
}

async function saveNewErpSessionData(userId, rawJson) {
  if (!userId || !rawJson) return false;
  let dataToStore = rawJson;
  try {
    const { encryptSecret } = require('./crypto');
    dataToStore = encryptSecret(rawJson);
  } catch (err) {
    dataToStore = rawJson;
  }
  await updateUser(userId, { newErpSessionData: dataToStore });
  return true;
}

function fromUserRow(r) {
  let mDate = '';
  if (r.monitoring_started_date) {
    if (typeof r.monitoring_started_date === 'string') {
      mDate = r.monitoring_started_date.slice(0, 10);
    } else if (r.monitoring_started_date instanceof Date) {
      mDate = getIstDateString(r.monitoring_started_date);
    }
  } else if (r.monitoring_started_at) {
    mDate = getIstDateString(new Date(r.monitoring_started_at));
  }

  const canonicalSession = r.id ? sessionPathFor(r.id) : (r.qums_session_path || '');
  let resolvedSessionPath = r.qums_session_path || '';
  if (r.id && (r.qums_session_path || r.qums_session_data)) {
    resolvedSessionPath = canonicalSession;
    if (r.qums_session_data && !fs.existsSync(canonicalSession)) {
      try {
        const plainJson = decodeSessionData(r.qums_session_data);
        if (plainJson) {
          fs.mkdirSync(path.dirname(canonicalSession), { recursive: true });
          fs.writeFileSync(canonicalSession, plainJson, { mode: 0o600 });
        }
      } catch {}
    }
  }

  const canonicalNewErpSession = r.id ? sessionPathForNewErp(r.id) : (r.new_erp_session_path || '');
  let resolvedNewErpSessionPath = r.new_erp_session_path || '';
  if (r.id && (r.new_erp_session_path || r.new_erp_session_data)) {
    resolvedNewErpSessionPath = canonicalNewErpSession;
    if (r.new_erp_session_data && !fs.existsSync(canonicalNewErpSession)) {
      try {
        const plainJson = decodeSessionData(r.new_erp_session_data);
        if (plainJson) {
          fs.mkdirSync(path.dirname(canonicalNewErpSession), { recursive: true });
          fs.writeFileSync(canonicalNewErpSession, plainJson, { mode: 0o600 });
        }
      } catch {}
    }
  }

  const row = {
    id: r.id, email: r.email, passwordHash: r.password_hash,
    qumsQid: r.qums_qid || '',
    qumsSessionPath: resolvedSessionPath,
    qumsSessionData: r.qums_session_data || '',
    telegramLinkCode: r.telegram_link_code || '',
    telegramChatId: r.telegram_chat_id || '',
    firebaseUid: r.firebase_uid || '',
    studentName: r.student_name || '',
    qumsYearSem: r.qums_year_sem || '',
    isAdmin: r.is_admin === true,
    emailVerified: r.email_verified === true,
    isSuspended: r.is_suspended === true,
    qumsSessionStatus: r.qums_session_status || 'active',
    activeErpType: r.active_erp_type || 'OLD',
    newErpEmail: r.new_erp_email || '',
    newErpPasswordEncrypted: r.new_erp_password_encrypted || '',
    newErpSessionPath: resolvedNewErpSessionPath,
    newErpSessionData: r.new_erp_session_data || '',
    newErpSessionStatus: r.new_erp_session_status || 'not_setup',
    newErpStudentName: r.new_erp_student_name || '',
    newErpQid: r.new_erp_qid || '',
    newErpAcademicYear: r.new_erp_academic_year || '',
    newErpSemester: r.new_erp_semester || '',
    newErpCourse: r.new_erp_course || '',
    newErpLastSyncedAt: r.new_erp_last_synced_at ? new Date(r.new_erp_last_synced_at).toISOString() : '',
    monitoringStartedDate: mDate,
    monitoringStartedAt: r.monitoring_started_at ? new Date(r.monitoring_started_at).toISOString() : '',
    lastAttendanceSyncAt: r.last_attendance_sync_at ? new Date(r.last_attendance_sync_at).toISOString() : (r.attendance_last_checked_at ? new Date(r.attendance_last_checked_at).toISOString() : ''),
    lastAssignmentSyncAt: r.last_assignment_sync_at ? new Date(r.last_assignment_sync_at).toISOString() : (r.assignment_last_checked_at ? new Date(r.assignment_last_checked_at).toISOString() : ''),
    attendanceLastCheckedAt: r.attendance_last_checked_at ? new Date(r.attendance_last_checked_at).toISOString() : '',
    assignmentLastCheckedAt: r.assignment_last_checked_at ? new Date(r.assignment_last_checked_at).toISOString() : '',
    profileSyncedAt: r.profile_synced_at ? new Date(r.profile_synced_at).toISOString() : '',
    lastError: r.last_error || '',
    lastReconnectSource: r.last_reconnect_source || '',
    lastReconnectedAt: r.last_reconnected_at ? new Date(r.last_reconnected_at).toISOString() : '',
    reconnectCountTelegram: Number(r.reconnect_count_telegram || 0),
    reconnectCountWeb: Number(r.reconnect_count_web || 0),
    createdAt: r.created_at ? new Date(r.created_at).toISOString() : '',
    updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : '',
  };
  if (r.qums_password_encrypted) {
    row.qumsPasswordEncrypted = r.qums_password_encrypted;
  }
  return row;
}

/** Blank app-user template shared by the JSON store and PG inserts. */
function blankUser({ email, passwordHash, firebaseUid, emailVerified, isSuspended }) {
  return {
    id: newId(),
    email: String(email).trim().toLowerCase(),
    passwordHash,
    firebaseUid: String(firebaseUid || ''),
    qumsQid: '',
    qumsSessionPath: '',
    qumsSessionData: '',
    telegramLinkCode: '',
    telegramChatId: '',
    studentName: '', // QUMS profile name CACHE (source of truth = QUMS session)
    qumsYearSem: '', // QUMS Year/Sem CACHE (fetched from the portal, never hardcoded)
    isAdmin: false,
    emailVerified: Boolean(emailVerified || false),
    isSuspended: Boolean(isSuspended || false),
    qumsSessionStatus: 'active',
    activeErpType: 'OLD',
    newErpEmail: '',
    newErpPasswordEncrypted: '',
    newErpSessionPath: '',
    newErpSessionData: '',
    newErpSessionStatus: 'not_setup',
    newErpStudentName: '',
    newErpQid: '',
    newErpAcademicYear: '',
    newErpSemester: '',
    newErpCourse: '',
    newErpLastSyncedAt: '',
    monitoringStartedDate: '',
    monitoringStartedAt: '',
    lastAttendanceSyncAt: '',
    lastAssignmentSyncAt: '',
    attendanceLastCheckedAt: '',
    assignmentLastCheckedAt: '',
    profileSyncedAt: '',
    lastError: '',
    lastReconnectSource: '',
    lastReconnectedAt: '',
    reconnectCountTelegram: 0,
    reconnectCountWeb: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

async function getUserByEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  if (!USE_PG) return data.users.find((u) => u.email === e) || null;
  await init();
  const r = await pool.query('SELECT * FROM users WHERE email=$1 LIMIT 1', [e]);
  return r.rows[0] ? fromUserRow(r.rows[0]) : null;
}

async function getUserById(id) {
  if (!USE_PG) return data.users.find((u) => u.id === id) || null;
  await init();
  const r = await pool.query('SELECT * FROM users WHERE id=$1 LIMIT 1', [id]);
  return r.rows[0] ? fromUserRow(r.rows[0]) : null;
}

async function createUser({ email, passwordHash, firebaseUid, emailVerified, isSuspended }) {
  const user = blankUser({ email, passwordHash, firebaseUid, emailVerified, isSuspended });
  if (!USE_PG) { data.users.push(user); persistJson(); return user; }
  await init();
  const r = await pool.query(
    `INSERT INTO users(id,email,password_hash,firebase_uid,email_verified,is_suspended,created_at) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [user.id, user.email, user.passwordHash, user.firebaseUid, user.emailVerified, user.isSuspended, user.createdAt]
  );
  return fromUserRow(r.rows[0]);
}

/**
 * Patch a user. Only whitelisted columns are writable, and the QUMS password
 * column is never written (encrypted or otherwise) — QAttend does not store it.
 */
const WRITABLE_USER_COLUMNS = {
  email: 'email',
  passwordHash: 'password_hash',
  qumsQid: 'qums_qid',
  qumsPasswordEncrypted: 'qums_password_encrypted',
  qumsSessionPath: 'qums_session_path',
  qumsSessionData: 'qums_session_data',
  telegramLinkCode: 'telegram_link_code',
  telegramChatId: 'telegram_chat_id',
  firebaseUid: 'firebase_uid',
  studentName: 'student_name',
  qumsYearSem: 'qums_year_sem',
  isAdmin: 'is_admin',
  emailVerified: 'email_verified',
  isSuspended: 'is_suspended',
  qumsSessionStatus: 'qums_session_status',
  activeErpType: 'active_erp_type',
  newErpEmail: 'new_erp_email',
  newErpPasswordEncrypted: 'new_erp_password_encrypted',
  newErpSessionPath: 'new_erp_session_path',
  newErpSessionData: 'new_erp_session_data',
  newErpSessionStatus: 'new_erp_session_status',
  newErpStudentName: 'new_erp_student_name',
  newErpQid: 'new_erp_qid',
  newErpAcademicYear: 'new_erp_academic_year',
  newErpSemester: 'new_erp_semester',
  newErpCourse: 'new_erp_course',
  newErpLastSyncedAt: 'new_erp_last_synced_at',
  monitoringStartedDate: 'monitoring_started_date',
  monitoringStartedAt: 'monitoring_started_at',
  lastAttendanceSyncAt: 'last_attendance_sync_at',
  lastAssignmentSyncAt: 'last_assignment_sync_at',
  lastReconnectSource: 'last_reconnect_source',
  lastReconnectedAt: 'last_reconnected_at',
  reconnectCountTelegram: 'reconnect_count_telegram',
  reconnectCountWeb: 'reconnect_count_web',
  updatedAt: 'updated_at',
  lastError: 'last_error',
};

async function updateUser(id, patch) {
  const user = await getUserById(id);
  if (!user) return null;
  const merged = { ...user, ...patch, updatedAt: new Date().toISOString() };
  if (!USE_PG) { Object.assign(user, patch); user.updatedAt = merged.updatedAt; persistJson(); return user; }

  const cols = [];
  const values = [id];
  for (const [appKey, column] of Object.entries(WRITABLE_USER_COLUMNS)) {
    if (!(appKey in patch)) continue;
    let v = merged[appKey];
    if (v === undefined || v === null) v = (appKey === 'isAdmin' || appKey === 'emailVerified' || appKey === 'isSuspended') ? false : '';
    values.push(v);
    cols.push(`${column}=$${values.length}`);
  }
  // always touch updated_at
  if (!('updatedAt' in patch)) {
    cols.push('updated_at=NOW()');
  }
  if (!cols.length) return user;
  await init();
  const r = await pool.query(`UPDATE users SET ${cols.join(',')} WHERE id=$1 RETURNING *`, values);
  return r.rows[0] ? fromUserRow(r.rows[0]) : null;
}

/** Per-user sync bookkeeping (real timestamps — used by admin "last sync"). */
async function touchUserSync(userId, { attendance, assignment, profile, error } = {}) {
  if (!USE_PG) {
    const u = data.users.find((x) => x.id === userId);
    if (!u) return null;
    const now = new Date().toISOString();
    if (attendance) { u.attendanceLastCheckedAt = now; u.lastAttendanceSyncAt = now; u.updatedAt = now; }
    if (assignment) { u.assignmentLastCheckedAt = now; u.lastAssignmentSyncAt = now; u.updatedAt = now; }
    if (profile) { u.profileSyncedAt = now; u.updatedAt = now; }
    if (error !== undefined) { u.lastError = String(error || ''); u.updatedAt = now; }
    persistJson();
    return u;
  }
  const sets = [];
  const values = [userId];
  if (attendance) {
    sets.push('attendance_last_checked_at=NOW()');
    sets.push('last_attendance_sync_at=NOW()');
  }
  if (assignment) {
    sets.push('assignment_last_checked_at=NOW()');
    sets.push('last_assignment_sync_at=NOW()');
  }
  if (profile) {
    sets.push('profile_synced_at=NOW()');
  }
  if (error !== undefined) {
    values.push(String(error || ''));
    sets.push(`last_error=$${values.length}`);
  }
  if (!sets.length) return getUserById(userId);
  sets.push('updated_at=NOW()');
  await init();
  await pool.query(`UPDATE users SET ${sets.join(',')} WHERE id=$1`, values);
  return getUserById(userId);
}

async function setUserAdmin(userId, isAdmin) {
  return updateUser(userId, { isAdmin: Boolean(isAdmin) });
}

async function setUserSuspended(userId, isSuspended) {
  return updateUser(userId, { isSuspended: Boolean(isSuspended) });
}

async function getQumsEncryptedPassword(userId) {
  if (!userId) return null;
  if (!USE_PG) {
    const u = data.users.find((x) => x.id === userId);
    return (u && u.qumsPasswordEncrypted) || null;
  }
  await init();
  const r = await pool.query('SELECT qums_password_encrypted FROM users WHERE id=$1', [userId]);
  return (r.rows[0] && r.rows[0].qums_password_encrypted) || null;
}

async function getUserByFirebaseUid(firebaseUid) {
  const uid = String(firebaseUid || '').trim();
  if (!uid) return null;
  if (!USE_PG) return data.users.find((u) => u.firebaseUid === uid) || null;
  await init();
  const r = await pool.query('SELECT * FROM users WHERE firebase_uid=$1 LIMIT 1', [uid]);
  return r.rows[0] ? fromUserRow(r.rows[0]) : null;
}

async function deleteUser(userId) {
  const user = await getUserById(userId);
  if (!USE_PG) {
    const before = data.users.length;
    data.users = data.users.filter((u) => u.id !== userId);
    data.knownAttendance = data.knownAttendance.filter((k) => k.userId !== userId);
    data.knownAssignments = data.knownAssignments.filter((k) => k.userId !== userId);
    data.sessionExpiry = data.sessionExpiry.filter((s) => s.userId !== userId);
    data.notifications = data.notifications.filter((n) => n.userId !== userId);
    data.qumsIdentities = (data.qumsIdentities || []).filter((q) => q.userId !== userId);
    data.attendanceRecords = (data.attendanceRecords || []).filter((a) => a.userId !== userId);
    data.assignmentsTable = (data.assignmentsTable || []).filter((a) => a.userId !== userId);
    data.notificationLogs = (data.notificationLogs || []).filter((n) => n.userId !== userId);
    if (user && user.email) {
      data.resets = (data.resets || []).filter((r) => r.email !== user.email);
    }
    if (user && user.telegramChatId) {
      data.scheduledDeletions = (data.scheduledDeletions || []).filter((s) => String(s.chatId) !== String(user.telegramChatId));
    }
    if (before !== data.users.length) persistJson();
    return before - data.users.length;
  }
  await init();
  if (user && user.email) {
    await pool.query('DELETE FROM resets WHERE email=$1', [user.email]).catch(() => {});
  }
  await pool.query('DELETE FROM notifications WHERE user_id=$1', [userId]).catch(() => {});
  if (user && user.telegramChatId) {
    await pool.query('DELETE FROM scheduled_message_deletions WHERE chat_id=$1', [String(user.telegramChatId)]).catch(() => {});
  }
  const r = await pool.query('DELETE FROM users WHERE id=$1', [userId]);
  return r.rowCount;
}

function tokenHash(token) { return crypto.createHash('sha256').update(String(token)).digest('hex'); }

async function storeResetToken(email, token) {
  const e = String(email).toLowerCase();
  const expiresAt = Date.now() + 60 * 60 * 1000;
  if (!USE_PG) {
    data.resets = data.resets.filter((r) => r.email !== e);
    data.resets.push({ email: e, tokenHash: tokenHash(token), expiresAt }); persistJson(); return;
  }
  await init();
  await pool.query(`INSERT INTO resets(email,token_hash,expires_at) VALUES($1,$2,$3) ON CONFLICT(email) DO UPDATE SET token_hash=EXCLUDED.token_hash,expires_at=EXCLUDED.expires_at`, [e, tokenHash(token), expiresAt]);
}

async function consumeResetToken(token) {
  const h = tokenHash(token);
  if (!USE_PG) {
    const rec = data.resets.find((r) => r.tokenHash === h) || null;
    if (!rec) return null;
    data.resets = data.resets.filter((r) => r.tokenHash !== h); persistJson();
    if (Date.now() > rec.expiresAt) return null;
    return getUserByEmail(rec.email);
  }
  await init();
  const r = await pool.query('SELECT email,expires_at FROM resets WHERE token_hash=$1 LIMIT 1', [h]);
  if (!r.rows[0]) return null;
  await pool.query('DELETE FROM resets WHERE token_hash=$1', [h]);
  if (Date.now() > Number(r.rows[0].expires_at)) return null;
  return getUserByEmail(r.rows[0].email);
}

async function listKnownAttendance(userId) {
  if (!USE_PG) { const e=data.knownAttendance.find(k=>k.userId===userId); return e ? e.records.slice() : []; }
  await init(); const r=await pool.query('SELECT records FROM known_attendance WHERE user_id=$1',[userId]); return r.rows[0] ? r.rows[0].records : [];
}

async function addKnownAttendance(userId, records) {
  const current = await listKnownAttendance(userId); const seen=new Set(current.map(r=>r.key)); let added=0;
  for (const rec of records || []) { if(!rec||!rec.key||seen.has(rec.key)) continue; current.push({...rec,seenAt:new Date().toISOString()}); seen.add(rec.key); added++; }
  const trimmed=current.slice(-5000);
  if (!USE_PG) { let e=data.knownAttendance.find(k=>k.userId===userId); if(!e){e={userId,records:[]};data.knownAttendance.push(e);} e.records=trimmed; if(added)persistJson(); return added; }
  await init(); await pool.query(`INSERT INTO known_attendance(user_id,records) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET records=EXCLUDED.records`,[userId,JSON.stringify(trimmed)]); return added;
}

/**
 * UPSERT (replace-by-key) the user's backdated-attendance state.
 *
 * Why this exists next to addKnownAttendance():
 *   addKnownAttendance() SKIPS keys that already exist — perfect for
 *   "new record" dedupe, WRONG for a status change (Absent -> Present).
 *   The month-register watcher stores the last known STATUS per record, so a
 *   changed record must UPDATE its entry (otherwise the same transition would
 *   re-alert on every cycle). This is the "store the last known status/state"
 *   contract from the spec.
 *
 * Records are keyed on `key` (= `${YYYY-MM-DD}-${subjectCode}`). The newest
 * value wins; entries are capped like the other known_* stores.
 * Returns the number of entries that were added or actually changed.
 */
async function upsertKnownAttendance(userId, records) {
  const current = await listKnownAttendance(userId);
  const byKey = new Map();
  for (const r of current) if (r && r.key) byKey.set(r.key, r);
  let changed = 0;
  const stamp = new Date().toISOString();
  for (const rec of records || []) {
    if (!rec || !rec.key) continue;
    const prev = byKey.get(rec.key);
    // Compare only the identifying/status-bearing fields — seenAt always moves.
    const sig = (r) => (r ? JSON.stringify([r.date, r.subjectCode, r.subject, r.status, r.statusRaw, r.lectures || null]) : '');
    const next = { ...rec, seenAt: stamp };
    if (sig(prev) !== sig(next)) changed += 1;
    byKey.set(rec.key, next);
  }
  const trimmed = Array.from(byKey.values()).slice(-5000);
  if (!USE_PG) {
    let e = data.knownAttendance.find((k) => k.userId === userId);
    if (!e) { e = { userId, records: [] }; data.knownAttendance.push(e); }
    e.records = trimmed;
    if (changed) persistJson();
  } else {
    await init();
    await pool.query(`INSERT INTO known_attendance(user_id,records) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET records=EXCLUDED.records`, [userId, JSON.stringify(trimmed)]);
  }

  // Also mirror into attendance_records table for structured relational queries
  try {
    const user = await getUserById(userId);
    const qid = (user && user.qumsQid) || '';
    for (const rec of records || []) {
      if (rec && rec.date && rec.subjectCode) {
        await saveAttendanceRecord(userId, qid, rec);
      }
    }
  } catch {}
  return changed;
}

async function removeKnownAttendance(userId, keys) {
  const drop=new Set(Array.isArray(keys)?keys:[keys]); const current=await listKnownAttendance(userId); const next=current.filter(r=>!drop.has(r.key)); const removed=current.length-next.length;
  if(!removed) return 0;
  if(!USE_PG){let e=data.knownAttendance.find(k=>k.userId===userId);if(e){e.records=next;persistJson();}return removed;}
  await init();await pool.query('UPDATE known_attendance SET records=$2 WHERE user_id=$1',[userId,JSON.stringify(next)]);return removed;
}

// ---- known assignments (assignment-notification + deadline-reminder dedupe;
//      "known_assignments" table; same JSONB-per-user pattern as known_attendance).
//      Per-user records: { key, kind: 'new'|'reminder', assignmentId, title,
//                          subject, teacher, deadline, sentAt } ----
const KNOWN_ASSIGNMENTS_CAP = 2000; // per user

function assignmentEntry(userId) {
  return data.knownAssignments.find((k) => k.userId === userId) || null;
}

async function listKnownAssignments(userId) {
  if (!USE_PG) { const e = assignmentEntry(userId); return e ? e.records.slice() : []; }
  await init(); const r = await pool.query('SELECT records FROM known_assignments WHERE user_id=$1', [userId]);
  return r.rows[0] ? r.rows[0].records : [];
}

async function addKnownAssignments(userId, records) {
  const current = await listKnownAssignments(userId); const seen = new Set(current.map((r) => r.key)); let added = 0;
  for (const rec of records || []) { if (!rec || !rec.key || seen.has(rec.key)) continue; current.push({ ...rec, sentAt: new Date().toISOString() }); seen.add(rec.key); added++; }
  const trimmed = current.slice(-KNOWN_ASSIGNMENTS_CAP);
  if (!USE_PG) { let e = assignmentEntry(userId); if (!e) { e = { userId, records: [] }; data.knownAssignments.push(e); } e.records = trimmed; if (added) persistJson(); }
  else {
    await init();
    await pool.query(`INSERT INTO known_assignments(user_id,records) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET records=EXCLUDED.records`, [userId, JSON.stringify(trimmed)]);
  }

  // Also mirror into assignments table for structured relational queries
  try {
    const user = await getUserById(userId);
    const qid = (user && user.qumsQid) || '';
    for (const rec of records || []) {
      if (rec && rec.title) {
        await saveAssignmentRecord(userId, qid, rec);
      }
    }
  } catch {}
  return added;
}

async function removeKnownAssignment(userId, keys) {
  const drop = new Set(Array.isArray(keys) ? keys : [keys]); const current = await listKnownAssignments(userId); const next = current.filter((r) => !drop.has(r.key)); const removed = current.length - next.length;
  if (!removed) return 0;
  if (!USE_PG) { let e = assignmentEntry(userId); if (e) { e.records = next; persistJson(); } return removed; }
  await init(); await pool.query('UPDATE known_assignments SET records=$2 WHERE user_id=$1', [userId, JSON.stringify(next)]); return removed;
}

async function updateKnownAssignmentMessageId(userId, key, telegramMessageId) {
  if (!userId || !key) return false;
  const current = await listKnownAssignments(userId);
  let updated = false;
  for (const item of current) {
    if (item.key === key) {
      item.telegramMessageId = telegramMessageId || null;
      updated = true;
    }
  }
  if (!updated) return false;
  if (!USE_PG) {
    let e = assignmentEntry(userId);
    if (e) { e.records = current; persistJson(); }
    return true;
  }
  await init();
  await pool.query('UPDATE known_assignments SET records=$2 WHERE user_id=$1', [userId, JSON.stringify(current)]);
  return true;
}

async function upsertWeeklySchedule(userId, dayOfWeek, rows) {
  if (!USE_PG) {
    for(const row of rows||[]){if(!row||!row.period)continue;const hit=data.weeklySchedule.find(r=>r.userId===userId&&r.dayOfWeek===dayOfWeek&&r.period===row.period);const patch={duration:row.duration||'',subject:row.subject||'',subjectCode:row.subjectCode||'',teacher:row.teacher||'',room:row.room||'',lastUpdated:new Date().toISOString()};if(hit)Object.assign(hit,patch);else data.weeklySchedule.push({userId,dayOfWeek,period:row.period,...patch});} persistJson(); return (rows||[]).length;
  }
  await init(); for(const row of rows||[]){if(!row||!row.period)continue;await pool.query(`INSERT INTO weekly_schedule(user_id,day_of_week,period,duration,subject,subject_code,teacher,room,last_updated) VALUES($1,$2,$3,$4,$5,$6,$7,$8,NOW()) ON CONFLICT(user_id,day_of_week,period) DO UPDATE SET duration=COALESCE(NULLIF(EXCLUDED.duration, ''), weekly_schedule.duration), subject=EXCLUDED.subject,subject_code=EXCLUDED.subject_code,teacher=EXCLUDED.teacher,room=EXCLUDED.room,last_updated=NOW()`,[userId,dayOfWeek,row.period,row.duration||'',row.subject||'',row.subjectCode||'',row.teacher||'',row.room||'']);} return (rows||[]).length;
}

async function getWeeklySchedule(userId, dayOfWeek) {
  if(!USE_PG){const rows=data.weeklySchedule.filter(r=>r.userId===userId&&r.dayOfWeek===dayOfWeek);if(!rows.length)return{fresh:false,rows:[]};const newest=Math.max(...rows.map(r=>Date.parse(r.lastUpdated)||0));return{fresh:Date.now()-newest<7*24*60*60*1000,rows:rows.map(r=>({period:r.period,duration:r.duration||'',subject:r.subject,subjectCode:r.subjectCode,teacher:r.teacher,room:r.room}))};}
  await init();const r=await pool.query('SELECT * FROM weekly_schedule WHERE user_id=$1 AND day_of_week=$2 ORDER BY period',[userId,dayOfWeek]);if(!r.rows.length)return{fresh:false,rows:[]};const newest=Math.max(...r.rows.map(x=>new Date(x.last_updated).getTime()));return{fresh:Date.now()-newest<7*24*60*60*1000,rows:r.rows.map(x=>({period:x.period,duration:x.duration||'',subject:x.subject,subjectCode:x.subject_code,teacher:x.teacher,room:x.room}))};
}

async function clearWeeklySchedule(userId, dayOfWeek) {
  if(!USE_PG){const before=data.weeklySchedule.length;data.weeklySchedule=data.weeklySchedule.filter(r=>!(r.userId===userId&&(dayOfWeek===undefined||r.dayOfWeek===dayOfWeek)));const n=before-data.weeklySchedule.length;if(n)persistJson();return n;}
  await init();const r=dayOfWeek===undefined?await pool.query('DELETE FROM weekly_schedule WHERE user_id=$1',[userId]):await pool.query('DELETE FROM weekly_schedule WHERE user_id=$1 AND day_of_week=$2',[userId,dayOfWeek]);return r.rowCount;
}

// ---------------------------------------------------------------------------
// Session-expiry state (PostgreSQL-backed — survives Render/Supabase restarts)
// ---------------------------------------------------------------------------

const SESSION_ALERT_COOLDOWN_MS = Number(process.env.SESSION_ALERT_COOLDOWN_MS || 12 * 60 * 60 * 1000);

async function getSessionExpiryState(userId) {
  if (!userId || typeof userId !== 'string' || !userId.trim()) return null;
  if (!USE_PG) {
    const e = data.sessionExpiry.find((s) => s.userId === userId);
    return e ? { ...e, telegramMessageId: e.telegramMessageId || null } : null;
  }
  await init();
  const r = await pool.query('SELECT * FROM session_expiry_state WHERE user_id=$1', [userId]);
  if (!r.rows[0]) return null;
  const row = r.rows[0];
  return {
    userId: row.user_id,
    expiredAt: row.expired_at ? Number(row.expired_at) : null,
    lastAlertAt: row.last_alert_at ? Number(row.last_alert_at) : null,
    alertCount: Number(row.alert_count || 0),
    resolvedAt: row.resolved_at ? Number(row.resolved_at) : null,
    note: row.note || '',
    telegramMessageId: row.telegram_message_id ? String(row.telegram_message_id) : (row.telegramMessageId || null),
  };
}

/** Record that this user's session expired (evidence-based — see scraper). */
async function markSessionExpired(userId, note = '') {
  if (!userId || typeof userId !== 'string' || !userId.trim()) {
    console.error(`[db] markSessionExpired rejected invalid userId: ${typeof userId}`);
    return null;
  }
  const now = Date.now();
  if (!USE_PG) {
    let e = data.sessionExpiry.find((s) => s.userId === userId);
    if (!e) { e = { userId, expiredAt: now, lastAlertAt: null, alertCount: 0, resolvedAt: null, note, telegramMessageId: null }; data.sessionExpiry.push(e); }
    else { e.expiredAt = now; e.resolvedAt = null; if (note) e.note = note; }
    const u = data.users.find((x) => x.id === userId);
    if (u) {
      u.qumsSessionStatus = 'expired';
      if (u.activeErpType === 'NEW') u.newErpSessionStatus = 'expired';
    }
    persistJson();
    return e;
  }
  await init();
  await pool.query(
    `INSERT INTO session_expiry_state(user_id,expired_at,note) VALUES($1,$2,$3)
     ON CONFLICT(user_id) DO UPDATE SET expired_at=EXCLUDED.expired_at, resolved_at=NULL, note=EXCLUDED.note`,
    [userId, now, String(note || '')]
  );
  await pool.query(
    `UPDATE users SET qums_session_status='expired',
     new_erp_session_status=CASE WHEN active_erp_type='NEW' THEN 'expired' ELSE new_erp_session_status END,
     updated_at=NOW() WHERE id=$1`,
    [userId]
  ).catch(() => {});
  return getSessionExpiryState(userId);
}

/** Persist that an expiry alert went out (dedupe across restarts). */
async function recordSessionExpiryAlert(userId, messageId = null) {
  if (!userId || typeof userId !== 'string' || !userId.trim()) {
    console.error(`[db] recordSessionExpiryAlert rejected invalid userId: ${typeof userId}`);
    return null;
  }
  const now = Date.now();
  const msgIdStr = messageId ? String(messageId).trim() : null;
  if (!USE_PG) {
    let e = data.sessionExpiry.find((s) => s.userId === userId);
    if (!e) {
      e = { userId, expiredAt: now, lastAlertAt: now, alertCount: 1, resolvedAt: null, note: '', telegramMessageId: msgIdStr };
      data.sessionExpiry.push(e);
    } else {
      e.lastAlertAt = now;
      e.alertCount = Number(e.alertCount || 0) + 1;
      if (msgIdStr) {
        e.telegramMessageId = e.telegramMessageId ? `${e.telegramMessageId},${msgIdStr}` : msgIdStr;
      }
    }
    persistJson();
    return e;
  }
  await init();
  await pool.query(
    `INSERT INTO session_expiry_state(user_id,expired_at,last_alert_at,alert_count,telegram_message_id)
     VALUES($1,$2,$2,1,$3)
     ON CONFLICT(user_id) DO UPDATE SET 
       last_alert_at=EXCLUDED.last_alert_at, 
       alert_count=session_expiry_state.alert_count+1,
       telegram_message_id = CASE 
         WHEN EXCLUDED.telegram_message_id IS NULL THEN session_expiry_state.telegram_message_id
         WHEN session_expiry_state.telegram_message_id IS NULL OR session_expiry_state.telegram_message_id = '' THEN EXCLUDED.telegram_message_id
         ELSE session_expiry_state.telegram_message_id || ',' || EXCLUDED.telegram_message_id
       END`,
    [userId, now, msgIdStr]
  );
  return getSessionExpiryState(userId);
}

/** Get all recorded Telegram message IDs for session expiry / conflict alerts for cleanup */
async function getSessionExpiryMessageIds(userId) {
  if (!userId) return [];
  const ids = new Set();
  const state = await getSessionExpiryState(userId);
  if (state && state.telegramMessageId) {
    String(state.telegramMessageId).split(',').map((s) => s.trim()).filter(Boolean).forEach((id) => ids.add(id));
  }
  if (!USE_PG) {
    const logs = data.notificationLogs || [];
    for (const n of logs) {
      if (n.userId === userId && (n.kind === 'session_expired' || n.kind === 'session_conflict') && n.metadata && n.metadata.messageId) {
        ids.add(String(n.metadata.messageId));
      }
    }
  } else {
    await init();
    const r = await pool.query(
      `SELECT metadata->>'messageId' AS message_id 
       FROM notification_log 
       WHERE user_id = $1 
         AND type IN ('session_expired', 'session_conflict')
         AND metadata->>'messageId' IS NOT NULL`,
      [userId]
    );
    for (const row of r.rows) {
      if (row.message_id) ids.add(String(row.message_id));
    }
  }
  return Array.from(ids);
}

/** Clear the recorded Telegram message ID for session expiry (e.g. after deletion). */
async function clearSessionExpiryTelegramMessage(userId) {
  if (!userId || typeof userId !== 'string' || !userId.trim()) return;
  if (!USE_PG) {
    const e = data.sessionExpiry.find((s) => s.userId === userId);
    if (e) { e.telegramMessageId = null; persistJson(); }
    return;
  }
  await init();
  await pool.query('UPDATE session_expiry_state SET telegram_message_id=NULL WHERE user_id=$1', [userId]).catch(() => {});
  await pool.query(
    `UPDATE notification_log 
     SET metadata = metadata - 'messageId' 
     WHERE user_id=$1 AND type IN ('session_expired', 'session_conflict')`,
    [userId]
  ).catch(() => {});
}

/** Reconnect succeeded or verified authenticated scrape -> clear expiry state so a future expiry alerts again. */
async function clearSessionExpiry(userId, { maxExpiredAt = null } = {}) {
  if (!userId || typeof userId !== 'string' || !userId.trim()) return false;
  const now = Date.now();
  if (!USE_PG) {
    const e = data.sessionExpiry.find((s) => s.userId === userId);
    if (e) {
      if (maxExpiredAt && e.expiredAt && Number(e.expiredAt) > Number(maxExpiredAt)) {
        return false; // Newer expiry event occurred concurrently — do not clear
      }
      e.resolvedAt = now;
      if (!maxExpiredAt) e.lastAlertAt = null;
      e.expiredAt = null;
      e.note = '';
      persistJson();
    }
    const u = data.users.find((x) => x.id === userId);
    if (u) {
      if (!maxExpiredAt || !e || !e.expiredAt || Number(e.expiredAt) <= Number(maxExpiredAt)) {
        u.qumsSessionStatus = 'active';
        if (u.activeErpType === 'NEW') u.newErpSessionStatus = 'active';
        persistJson();
      }
    }
    return true;
  }
  await init();
  if (maxExpiredAt) {
    const maxTs = Number(maxExpiredAt);
    const r = await pool.query(
      `UPDATE session_expiry_state 
       SET resolved_at=$2, expired_at=NULL, note=''
       WHERE user_id=$1 AND (expired_at IS NULL OR expired_at <= $3)`,
      [userId, now, maxTs]
    );
    if (r.rowCount > 0) {
      await pool.query(
        `UPDATE users SET qums_session_status='active',
         new_erp_session_status=CASE WHEN active_erp_type='NEW' THEN 'active' ELSE new_erp_session_status END,
         updated_at=NOW() 
         WHERE id=$1 AND (qums_session_status='expired' OR new_erp_session_status='expired')
           AND NOT EXISTS (
             SELECT 1 FROM session_expiry_state 
             WHERE user_id=$1 AND expired_at > $2 AND resolved_at IS NULL
           )`,
        [userId, maxTs]
      ).catch(() => {});
      return true;
    }
    return false;
  }

  await pool.query(
    `INSERT INTO session_expiry_state(user_id,resolved_at) VALUES($1,$2)
     ON CONFLICT(user_id) DO UPDATE SET resolved_at=EXCLUDED.resolved_at, expired_at=NULL, last_alert_at=NULL, note=''`,
    [userId, now]
  );
  await pool.query(
    `UPDATE users SET qums_session_status='active',
     new_erp_session_status=CASE WHEN active_erp_type='NEW' THEN 'active' ELSE new_erp_session_status END,
     updated_at=NOW() WHERE id=$1`,
    [userId]
  ).catch(() => {});
  return true;
}

/** Users whose session is currently expired (real signal for the admin panel). */
async function listSessionExpiredUsers() {
  if (!USE_PG) {
    const fromExpiry = data.sessionExpiry.filter((s) => s.expiredAt && !s.resolvedAt).map((s) => s.userId);
    const fromUsers = data.users.filter((u) => u.qumsSessionStatus === 'expired').map((u) => u.id);
    return Array.from(new Set([...fromExpiry, ...fromUsers]));
  }
  await init();
  const r = await pool.query(`
    SELECT DISTINCT u.id 
    FROM users u
    LEFT JOIN session_expiry_state s ON s.user_id = u.id
    WHERE (s.expired_at IS NOT NULL AND s.resolved_at IS NULL)
       OR u.qums_session_status = 'expired'
  `);
  return r.rows.map((x) => x.id);
}

// ---------------------------------------------------------------------------
// Notification log (analytics + audit; never contains credentials or bodies)
// ---------------------------------------------------------------------------

const NOTIFICATION_KINDS = [
  'attendance_class',
  'attendance_backdated',
  'attendance_changed',
  'assignment_new',
  'assignment_deadline',
  'session_expired',
  'qums_reconnected',
  'morning_schedule',
];
const NOTIFICATION_CAP_JSON = 5000;

/** Record a user-facing notification. Never throws (analytics never blocks delivery). */
async function recordNotification(userId, kind, meta = {}, log = console) {
  try {
    if (!userId) return false;
    const subject = String(meta.subject || '').slice(0, 200);
    const classDate = String(meta.classDate || '').slice(0, 40);
    if (!USE_PG) {
      data.notifications.push({ userId, kind, subject, classDate, sentAt: new Date().toISOString() });
      if (data.notifications.length > NOTIFICATION_CAP_JSON) data.notifications = data.notifications.slice(-NOTIFICATION_CAP_JSON);
      persistJson();
    } else {
      await init();
      await pool.query(
        'INSERT INTO notifications(user_id,kind,subject,class_date) VALUES($1,$2,$3,$4)',
        [userId, String(kind), subject, classDate]
      );
    }
    const dedupeKey = meta.dedupeKey || `${kind}:${meta.classDate || ''}:${meta.subjectCode || ''}:${meta.status || ''}:${Date.now()}`;
    await tryRecordNotificationLog(userId, kind, dedupeKey, meta);
    return true;
  } catch (err) {
    log.error(`[db] notification log failed (${err.message}) — delivery unaffected.`);
    return false;
  }
}

/** Aggregate counts for the admin analytics panel. */
async function notificationStats(days = 30) {
  if (!USE_PG) {
    const all = data.notifications;
    const since = Date.now() - days * 86400000;
    const byKind = {};
    for (const n of all) byKind[n.kind] = (byKind[n.kind] || 0) + 1;
    return { total: all.length, last30d: all.filter((n) => Date.parse(n.sentAt) >= since).length, byKind };
  }
  await init();
  const total = await pool.query('SELECT COUNT(*)::int AS n FROM notifications');
  const win = await pool.query("SELECT COUNT(*)::int AS n FROM notifications WHERE sent_at >= NOW() - ($1 || ' days')::interval", [String(days)]);
  const kinds = await pool.query('SELECT kind, COUNT(*)::int AS n FROM notifications GROUP BY kind ORDER BY n DESC');
  const byKind = {};
  for (const r of kinds.rows) byKind[r.kind] = r.n;
  return { total: total.rows[0].n, last30d: win.rows[0].n, byKind };
}

async function recentNotifications(limit = 20) {
  const n = Math.min(200, Math.max(1, Number(limit) || 20));
  if (!USE_PG) return data.notifications.slice(-n).reverse();
  await init();
  const r = await pool.query('SELECT user_id, kind, subject, class_date, sent_at FROM notifications ORDER BY sent_at DESC LIMIT $1', [n]);
  return r.rows.map((x) => ({ userId: x.user_id, kind: x.kind, subject: x.subject, classDate: x.class_date, sentAt: x.sent_at }));
}

// ---------------------------------------------------------------------------
// Admin queries (read-only; returns ONLY non-sensitive fields)
// ---------------------------------------------------------------------------

/** Public per-user shape for /admin — never includes hashes/secrets. */
function safeAdminUser(u, expiredUserIds = []) {
  const hasOldSession = Boolean(
    (u.qumsSessionPath && (fs.existsSync(u.qumsSessionPath) || u.qumsSessionData)) ||
    u.qumsSessionData
  );
  const hasNewSession = Boolean(
    (u.newErpSessionPath && (fs.existsSync(u.newErpSessionPath) || u.newErpSessionData)) ||
    u.newErpSessionData
  );

  const activeErp = (u.activeErpType || (hasNewSession && !hasOldSession ? 'NEW' : 'OLD')).toUpperCase();
  const hasSession = activeErp === 'NEW' ? hasNewSession : hasOldSession;
  const onDisk = activeErp === 'NEW'
    ? Boolean(u.newErpSessionPath && fs.existsSync(u.newErpSessionPath))
    : Boolean(u.qumsSessionPath && fs.existsSync(u.qumsSessionPath));

  const isOldExpired = Boolean(expiredUserIds.includes(u.id) || u.qumsSessionStatus === 'expired');
  const isNewExpired = Boolean(u.newErpSessionStatus === 'expired' || u.newErpSessionStatus === 'EXPIRED');
  const isExpired = activeErp === 'NEW' ? isNewExpired : isOldExpired;

  // Student name: prefer New ERP name for New ERP users, fallback to Old ERP name
  const studentName = activeErp === 'NEW'
    ? (u.newErpStudentName || u.studentName || '')
    : (u.studentName || u.newErpStudentName || '');

  // QID: clean QID from New ERP or Old ERP
  const rawQid = activeErp === 'NEW'
    ? (u.newErpQid || u.qumsQid || '')
    : (u.qumsQid || u.newErpQid || '');
  const cleanQid = (rawQid && rawQid.length <= 16 && !/[+/=]/.test(rawQid)) ? rawQid : (rawQid || '');

  // Year / Sem
  let yearSem = u.qumsYearSem || '';
  if (activeErp === 'NEW') {
    const parts = [
      u.newErpCourse && !u.newErpCourse.includes('{') ? u.newErpCourse : '',
      u.newErpSemester ? `Sem ${u.newErpSemester}` : '',
      u.newErpAcademicYear || '',
    ].filter(Boolean);
    if (parts.length) {
      yearSem = parts.join(' • ');
    }
  }

  return {
    id: u.id,
    email: u.email,
    studentName,
    qumsYearSem: yearSem,
    qumsQid: cleanQid,
    rawQid,
    qumsConnected: hasSession,
    qumsSessionOnDisk: onDisk,
    sessionExpired: isExpired,
    qumsSessionStatus: isExpired ? 'expired' : (hasSession ? 'active' : 'not_setup'),
    telegramConnected: Boolean(u.telegramChatId),
    isAdmin: Boolean(u.isAdmin),
    emailVerified: Boolean(u.emailVerified),
    isSuspended: Boolean(u.isSuspended),
    createdAt: u.createdAt || '',
    profileSyncedAt: u.profileSyncedAt || '',
    attendanceLastCheckedAt: u.attendanceLastCheckedAt || '',
    assignmentLastCheckedAt: u.assignmentLastCheckedAt || '',
    lastError: u.lastError || '',
    lastReconnectSource: u.lastReconnectSource || '',
    lastReconnectedAt: u.lastReconnectedAt || '',
    reconnectCountTelegram: Number(u.reconnectCountTelegram || 0),
    reconnectCountWeb: Number(u.reconnectCountWeb || 0),
    // New ERP metadata
    activeErpType: activeErp,
    newErpConnected: hasNewSession,
    newErpEmail: u.newErpEmail || '',
    newErpStudentName: u.newErpStudentName || '',
    newErpQid: cleanQid,
    newErpSessionStatus: u.newErpSessionStatus || 'not_setup',
    newErpCourse: u.newErpCourse || '',
    newErpSemester: u.newErpSemester || '',
    newErpAcademicYear: u.newErpAcademicYear || '',
  };
}

/**
 * Pure: search (name/email/QID) + filter for the admin list. Exported for tests.
 * filter: 'all' | 'qums_connected' | 'session_expired' | 'telegram_connected' | 'suspended' | 'active' | 'old_erp' | 'new_erp'
 */
function applyAdminFilters(rows, {
  search = '',
  filter = 'all',
  qumsFilter = 'all',
  telegramFilter = 'all',
  reconnectFilter = 'all',
  statusFilter = 'all',
} = {}) {
  const q = String(search || '').trim().toLowerCase();
  return (rows || []).filter((r) => {
    if (q) {
      const hay = `${r.studentName || ''} ${r.email || ''} ${r.qumsQid || ''} ${r.newErpEmail || ''} ${r.rawQid || ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (filter === 'admin' && !r.isAdmin) return false;
    if (filter === 'qums_connected' && !r.qumsConnected) return false;
    if (filter === 'session_expired' && !r.sessionExpired) return false;
    if (filter === 'telegram_connected' && !r.telegramConnected) return false;
    if (filter === 'suspended' && !r.isSuspended) return false;
    if (filter === 'active' && (r.isSuspended || r.sessionExpired || !r.qumsConnected)) return false;
    if (filter === 'old_erp' && r.activeErpType !== 'OLD') return false;
    if (filter === 'new_erp' && r.activeErpType !== 'NEW') return false;

    // Filter 1: QUMS Status
    if (qumsFilter === 'connected' && (!r.qumsConnected || r.sessionExpired)) return false;
    if (qumsFilter === 'expired' && !r.sessionExpired) return false;
    if (qumsFilter === 'not_setup' && r.qumsConnected) return false;
    if (qumsFilter === 'new_erp' && r.activeErpType !== 'NEW') return false;
    if (qumsFilter === 'old_erp' && r.activeErpType !== 'OLD') return false;

    // Filter 2: Telegram Status
    if (telegramFilter === 'linked' && !r.telegramConnected) return false;
    if (telegramFilter === 'unlinked' && r.telegramConnected) return false;

    // Filter 3: Reconnect Channel (Telegram vs Webpage)
    if (reconnectFilter === 'telegram' && r.lastReconnectSource !== 'telegram' && !(r.reconnectCountTelegram > 0)) return false;
    if (reconnectFilter === 'web' && r.lastReconnectSource !== 'web' && !(r.reconnectCountWeb > 0)) return false;
    if (reconnectFilter === 'never' && (r.lastReconnectSource || r.reconnectCountTelegram > 0 || r.reconnectCountWeb > 0)) return false;

    // Account Status Filter
    if (statusFilter === 'active' && (r.isSuspended || !r.emailVerified)) return false;
    if (statusFilter === 'suspended' && !r.isSuspended) return false;
    if (statusFilter === 'unverified' && r.emailVerified) return false;

    return true;
  });
}

/** Get all matching user IDs across all pages (for select all across pages) */
async function getMatchingUserIdsForAdmin({ search = '', filter = 'all' } = {}) {
  const users = await allUsers();
  const expired = await listSessionExpiredUsers();
  const rows = users.map((u) => safeAdminUser(u, expired));
  const filtered = applyAdminFilters(rows, { search, filter });
  return filtered.map((u) => u.id);
}

/** Paginated admin user list (search + filter applied server-side). */
async function listUsersForAdmin({
  search = '',
  filter = 'all',
  qumsFilter = 'all',
  telegramFilter = 'all',
  reconnectFilter = 'all',
  statusFilter = 'all',
  page = 1,
  limit = 25,
} = {}) {
  const users = await allUsers();
  const expired = await listSessionExpiredUsers();
  const rows = users.map((u) => safeAdminUser(u, expired));
  const filtered = applyAdminFilters(rows, { search, filter, qumsFilter, telegramFilter, reconnectFilter, statusFilter });
  const perPage = Math.min(100, Math.max(5, Number(limit) || 25));
  const pages = Math.max(1, Math.ceil(filtered.length / perPage));
  const p = Math.min(pages, Math.max(1, Number(page) || 1));
  const slice = filtered.slice((p - 1) * perPage, (p - 1) * perPage + perPage);
  // Newest first for display, but stable/predictable for tests.
  return { total: filtered.length, allTotal: rows.length, page: p, pages, perPage, users: slice };
}

/** Cached real database reachability (updated by ping). */
const dbStatus = { state: USE_PG ? 'unknown' : 'json', lastError: '', checkedAt: null };

/** Real counts for the admin dashboard (no invented numbers). */
async function adminStats() {
  const users = await allUsers();
  const expired = await listSessionExpiredUsers();
  const now = Date.now();
  const day = 86400000;
  const withSession = users.filter((u) => {
    if (u.activeErpType === 'NEW') {
      return Boolean((u.newErpSessionPath && fs.existsSync(u.newErpSessionPath)) || u.newErpSessionData);
    }
    return Boolean((u.qumsSessionPath && fs.existsSync(u.qumsSessionPath)) || u.qumsSessionData);
  });
  const newErpConnected = users.filter((u) => u.activeErpType === 'NEW' && Boolean((u.newErpSessionPath && fs.existsSync(u.newErpSessionPath)) || u.newErpSessionData)).length;
  const oldErpConnected = users.filter((u) => u.activeErpType !== 'NEW' && Boolean((u.qumsSessionPath && fs.existsSync(u.qumsSessionPath)) || u.qumsSessionData)).length;

  let telegramReconnects = 0;
  let webReconnects = 0;
  for (const u of users) {
    telegramReconnects += Number(u.reconnectCountTelegram || 0);
    webReconnects += Number(u.reconnectCountWeb || 0);
    if (!u.reconnectCountTelegram && !u.reconnectCountWeb && u.lastReconnectSource) {
      if (u.lastReconnectSource === 'telegram') telegramReconnects += 1;
      else if (u.lastReconnectSource === 'web') webReconnects += 1;
    }
  }

  if (USE_PG) {
    try {
      const recRes = await pool.query(`SELECT source, COUNT(*)::int as c FROM reconnect_events GROUP BY source`);
      if (recRes && recRes.rows && recRes.rows.length) {
        let tgEv = 0, webEv = 0;
        for (const row of recRes.rows) {
          if (row.source === 'telegram') tgEv = row.c;
          if (row.source === 'web') webEv = row.c;
        }
        telegramReconnects = Math.max(telegramReconnects, tgEv);
        webReconnects = Math.max(webReconnects, webEv);
      }
    } catch {}
  }

  return {
    totalUsers: users.length,
    newUsers24h: users.filter((u) => u.createdAt && now - Date.parse(u.createdAt) < day).length,
    newUsers7d: users.filter((u) => u.createdAt && now - Date.parse(u.createdAt) < 7 * day).length,
    qumsConnected: withSession.length,
    newErpConnected,
    oldErpConnected,
    sessionExpired: users.filter((u) => expired.includes(u.id)).length,
    telegramConnected: users.filter((u) => u.telegramChatId).length,
    suspended: users.filter((u) => u.isSuspended).length,
    admins: users.filter((u) => u.isAdmin).length,
    reconnectStats: {
      telegram: telegramReconnects,
      web: webReconnects,
      total: telegramReconnects + webReconnects,
    },
    dbMode: USE_PG ? 'postgres' : 'json',
    database: {
      requested: !USE_PG ? 'json' : 'ok',
      state: dbStatus.state,
      lastError: dbStatus.lastError,
      checkedAt: dbStatus.checkedAt,
    },
    userList: withSession.map((u) => u.id),
  };
}

/** Live DB ping for the admin System Health panel. */
async function ping() {
  if (!USE_PG) {
    dbStatus.state = 'json';
    dbStatus.checkedAt = new Date().toISOString();
    return { ok: true, mode: 'json', latencyMs: 0 };
  }
  const started = Date.now();
  try {
    await init();
    await pool.query('SELECT 1');
    dbStatus.state = 'ok';
    dbStatus.lastError = '';
    dbStatus.checkedAt = new Date().toISOString();
    return { ok: true, mode: 'postgres', latencyMs: Date.now() - started };
  } catch (err) {
    dbStatus.state = 'error';
    dbStatus.lastError = err.message;
    dbStatus.checkedAt = new Date().toISOString();
    return { ok: false, mode: 'postgres', error: err.message, latencyMs: Date.now() - started };
  }
}

async function telegramLinkCodeFor(userId){const user=await getUserById(userId);if(!user)return null;if(user.telegramLinkCode)return user.telegramLinkCode;const code=crypto.randomBytes(6).toString('hex');await updateUser(userId,{telegramLinkCode:code});return code;}
async function getUserByTelegramLinkCode(code){const c=String(code||'').trim();if(!c)return null;if(!USE_PG){return data.users.find(u=>u.telegramLinkCode&&u.telegramLinkCode===c)||null;}await init();const r=await pool.query('SELECT * FROM users WHERE telegram_link_code=$1 LIMIT 1',[c]);return r.rows[0]?fromUserRow(r.rows[0]):null;}
async function getUserByTelegramChatId(chatId){const c=String(chatId||'').trim();if(!c)return null;if(!USE_PG)return data.users.find(u=>u.telegramChatId&&String(u.telegramChatId)===c)||null;await init();const r=await pool.query('SELECT * FROM users WHERE telegram_chat_id=$1 LIMIT 1',[c]);return r.rows[0]?fromUserRow(r.rows[0]):null;}
async function setTelegramChatId(userId,chatId){return updateUser(userId,{telegramChatId:String(chatId).trim()});}
async function clearTelegramChatForChat(chatId,exceptUserId){const c=String(chatId||'').trim();if(!c)return 0;if(!USE_PG){let n=0;for(const u of data.users){if(u.id!==exceptUserId&&u.telegramChatId&&String(u.telegramChatId)===c){u.telegramChatId='';n++;}}if(n)persistJson();return n;}await init();const r=await pool.query('UPDATE users SET telegram_chat_id=\'\' WHERE telegram_chat_id=$1 AND id<>$2',[c,exceptUserId]);return r.rowCount;}
async function clearTelegramChatId(userId){return updateUser(userId,{telegramChatId:''});}

// ---------------------------------------------------------------------------
// Structured Relational Storage: QUMS Identities, Attendance Records,
// Assignments, and Persistent Notification Log (Migration 011)
// ---------------------------------------------------------------------------

async function getQumsIdentities(userId) {
  if (!USE_PG) {
    return (data.qumsIdentities || []).filter((q) => q.userId === userId).map((q) => ({
      ...q,
      monitoringStartedDate: q.monitoringStartedDate || (q.monitoringStartedAt ? getIstDateString(new Date(q.monitoringStartedAt)) : ''),
    }));
  }
  await init();
  const r = await pool.query('SELECT * FROM qums_identities WHERE user_id=$1 ORDER BY created_at ASC', [userId]);
  return r.rows.map((row) => ({
    id: row.id,
    userId: row.user_id,
    qid: row.qid,
    studentName: row.student_name,
    yearSem: row.year_sem,
    monitoringStartedDate: row.monitoring_started_date
      ? (typeof row.monitoring_started_date === 'string' ? row.monitoring_started_date.slice(0, 10) : getIstDateString(row.monitoring_started_date))
      : (row.monitoring_started_at ? getIstDateString(new Date(row.monitoring_started_at)) : ''),
    monitoringStartedAt: row.monitoring_started_at ? new Date(row.monitoring_started_at).toISOString() : '',
    isActive: row.is_active === true,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : '',
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : '',
  }));
}

async function getActiveQumsIdentity(userId) {
  if (!USE_PG) {
    const hit = (data.qumsIdentities || []).find((q) => q.userId === userId && q.isActive) || null;
    if (!hit) return null;
    return {
      ...hit,
      monitoringStartedDate: hit.monitoringStartedDate || (hit.monitoringStartedAt ? getIstDateString(new Date(hit.monitoringStartedAt)) : ''),
    };
  }
  await init();
  const r = await pool.query('SELECT * FROM qums_identities WHERE user_id=$1 AND is_active=TRUE LIMIT 1', [userId]);
  if (!r.rows[0]) return null;
  const row = r.rows[0];
  return {
    id: row.id,
    userId: row.user_id,
    qid: row.qid,
    studentName: row.student_name,
    yearSem: row.year_sem,
    monitoringStartedDate: row.monitoring_started_date
      ? (typeof row.monitoring_started_date === 'string' ? row.monitoring_started_date.slice(0, 10) : getIstDateString(row.monitoring_started_date))
      : (row.monitoring_started_at ? getIstDateString(new Date(row.monitoring_started_at)) : ''),
    monitoringStartedAt: row.monitoring_started_at ? new Date(row.monitoring_started_at).toISOString() : '',
    isActive: row.is_active === true,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : '',
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : '',
  };
}

async function switchQumsIdentity(userId, qid, { studentName = '', yearSem = '', monitoringStartedDate = '' } = {}) {
  const q = String(qid || '').trim();
  if (!q) return null;
  const now = new Date().toISOString();
  const mDate = monitoringStartedDate || getIstDateString();
  if (!USE_PG) {
    if (!data.qumsIdentities) data.qumsIdentities = [];
    for (const item of data.qumsIdentities) {
      if (item.userId === userId) item.isActive = false;
    }
    let hit = data.qumsIdentities.find((item) => item.userId === userId && item.qid === q);
    if (!hit) {
      hit = {
        id: newId(),
        userId,
        qid: q,
        studentName: studentName || '',
        yearSem: yearSem || '',
        monitoringStartedDate: mDate,
        monitoringStartedAt: now,
        isActive: true,
        createdAt: now,
        updatedAt: now,
      };
      data.qumsIdentities.push(hit);
    } else {
      hit.isActive = true;
      if (studentName) hit.studentName = studentName;
      if (yearSem) hit.yearSem = yearSem;
      if (!hit.monitoringStartedDate) hit.monitoringStartedDate = mDate;
      hit.updatedAt = now;
    }
    persistJson();
    return hit;
  }
  await init();
  await pool.query('UPDATE qums_identities SET is_active=FALSE, updated_at=NOW() WHERE user_id=$1', [userId]);
  const r = await pool.query(
    `INSERT INTO qums_identities(id, user_id, qid, student_name, year_sem, monitoring_started_date, monitoring_started_at, is_active, created_at, updated_at)
     VALUES($1, $2, $3, $4, $5, $6, NOW(), TRUE, NOW(), NOW())
     ON CONFLICT(user_id, qid) DO UPDATE SET
       is_active=TRUE,
       student_name=COALESCE(NULLIF(EXCLUDED.student_name, ''), qums_identities.student_name),
       year_sem=COALESCE(NULLIF(EXCLUDED.year_sem, ''), qums_identities.year_sem),
       monitoring_started_date=COALESCE(qums_identities.monitoring_started_date, EXCLUDED.monitoring_started_date),
       updated_at=NOW()
     RETURNING *`,
    [newId(), userId, q, studentName, yearSem, mDate]
  );
  return r.rows[0];
}

async function saveAttendanceRecord(userId, qid, rec) {
  if (!rec || !rec.date || !rec.subjectCode) return false;
  const q = String(qid || '').trim();
  const now = new Date().toISOString();
  if (!USE_PG) {
    if (!data.attendanceRecords) data.attendanceRecords = [];
    let hit = data.attendanceRecords.find((r) => r.userId === userId && r.qid === q && r.subjectCode === rec.subjectCode && r.classDate === rec.date);
    if (!hit) {
      data.attendanceRecords.push({
        id: (data.attendanceRecords.length + 1).toString(),
        userId,
        qid: q,
        subjectCode: rec.subjectCode,
        subjectName: rec.subject || '',
        classDate: rec.date,
        status: rec.status || 'present',
        firstSeenAt: now,
        lastSeenAt: now,
        createdAt: now,
        updatedAt: now,
      });
    } else {
      hit.status = rec.status || 'present';
      hit.lastSeenAt = now;
      hit.updatedAt = now;
    }
    persistJson();
    return true;
  }
  await init();
  await pool.query(
    `INSERT INTO attendance_records(user_id, qid, subject_code, subject_name, class_date, status, first_seen_at, last_seen_at, created_at, updated_at)
     VALUES($1, $2, $3, $4, $5, $6, NOW(), NOW(), NOW(), NOW())
     ON CONFLICT(user_id, qid, subject_code, class_date) DO UPDATE SET
       status=EXCLUDED.status,
       last_seen_at=NOW(),
       updated_at=NOW()`,
    [userId, q, rec.subjectCode, rec.subject || '', rec.date, rec.status || 'present']
  );
  return true;
}

async function listAttendanceRecords(userId, qid) {
  if (!USE_PG) {
    return (data.attendanceRecords || []).filter((r) => r.userId === userId && (!qid || r.qid === qid));
  }
  await init();
  const q = String(qid || '').trim();
  const sql = q
    ? 'SELECT * FROM attendance_records WHERE user_id=$1 AND qid=$2 ORDER BY class_date DESC'
    : 'SELECT * FROM attendance_records WHERE user_id=$1 ORDER BY class_date DESC';
  const params = q ? [userId, q] : [userId];
  const r = await pool.query(sql, params);
  return r.rows.map((row) => ({
    id: row.id,
    userId: row.user_id,
    qid: row.qid,
    subjectCode: row.subject_code,
    subjectName: row.subject_name,
    classDate: row.class_date,
    status: row.status,
    firstSeenAt: new Date(row.first_seen_at).toISOString(),
    lastSeenAt: new Date(row.last_seen_at).toISOString(),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  }));
}

async function saveAssignmentRecord(userId, qid, a) {
  if (!a || !a.title) return false;
  const q = String(qid || '').trim();
  const extId = String(a.id || a.key || a.title);
  const now = new Date().toISOString();
  if (!USE_PG) {
    if (!data.assignmentsTable) data.assignmentsTable = [];
    let hit = data.assignmentsTable.find((row) => row.userId === userId && row.externalAssignmentId === extId);
    if (!hit) {
      data.assignmentsTable.push({
        id: (data.assignmentsTable.length + 1).toString(),
        userId,
        qid: q,
        externalAssignmentId: extId,
        subject: a.subject || '',
        title: a.title || '',
        lastDate: a.deadlineYMD || a.lastDate || '',
        firstSeenAt: now,
        lastSeenAt: now,
        createdAt: now,
        updatedAt: now,
      });
    } else {
      hit.lastDate = a.deadlineYMD || a.lastDate || hit.lastDate;
      hit.lastSeenAt = now;
      hit.updatedAt = now;
    }
    persistJson();
    return true;
  }
  await init();
  await pool.query(
    `INSERT INTO assignments(user_id, qid, external_assignment_id, subject, title, last_date, first_seen_at, last_seen_at, created_at, updated_at)
     VALUES($1, $2, $3, $4, $5, $6, NOW(), NOW(), NOW(), NOW())
     ON CONFLICT(user_id, external_assignment_id) DO UPDATE SET
       last_date=EXCLUDED.last_date,
       last_seen_at=NOW(),
       updated_at=NOW()`,
    [userId, q, extId, a.subject || '', a.title || '', a.deadlineYMD || a.lastDate || '']
  );
  return true;
}

async function listAssignmentRecords(userId, qid) {
  if (!USE_PG) {
    return (data.assignmentsTable || []).filter((r) => r.userId === userId && (!qid || r.qid === qid));
  }
  await init();
  const q = String(qid || '').trim();
  const sql = q
    ? 'SELECT * FROM assignments WHERE user_id=$1 AND qid=$2 ORDER BY first_seen_at DESC'
    : 'SELECT * FROM assignments WHERE user_id=$1 ORDER BY first_seen_at DESC';
  const params = q ? [userId, q] : [userId];
  const r = await pool.query(sql, params);
  return r.rows.map((row) => ({
    id: row.id,
    userId: row.user_id,
    qid: row.qid,
    externalAssignmentId: row.external_assignment_id,
    subject: row.subject,
    title: row.title,
    lastDate: row.last_date,
    firstSeenAt: new Date(row.first_seen_at).toISOString(),
    lastSeenAt: new Date(row.last_seen_at).toISOString(),
  }));
}

async function tryRecordNotificationLog(userId, type, dedupeKey, metadata = {}) {
  if (!userId || !dedupeKey) return false;
  const now = new Date().toISOString();
  if (!USE_PG) {
    if (!data.notificationLogs) data.notificationLogs = [];
    const hit = data.notificationLogs.find((n) => n.userId === userId && n.dedupeKey === dedupeKey);
    if (hit) return false; // duplicate
    data.notificationLogs.push({
      id: (data.notificationLogs.length + 1).toString(),
      userId,
      type,
      referenceId: metadata.referenceId || '',
      dedupeKey,
      sentAt: now,
      metadata,
    });
    persistJson();
    return true;
  }
  await init();
  const r = await pool.query(
    `INSERT INTO notification_log(user_id, type, reference_id, dedupe_key, sent_at, metadata)
     VALUES($1, $2, $3, $4, NOW(), $5)
     ON CONFLICT(user_id, dedupe_key) DO NOTHING
     RETURNING id`,
    [userId, type, metadata.referenceId || '', dedupeKey, JSON.stringify(metadata)]
  );
  return (r.rowCount || 0) > 0;
}

async function hasNotificationLog(userId, dedupeKey) {
  if (!userId || !dedupeKey) return false;
  if (!USE_PG) {
    return Boolean((data.notificationLogs || []).find((n) => n.userId === userId && n.dedupeKey === dedupeKey));
  }
  await init();
  const r = await pool.query('SELECT 1 FROM notification_log WHERE user_id=$1 AND dedupe_key=$2 LIMIT 1', [userId, dedupeKey]);
  return (r.rowCount || 0) > 0;
}

async function deleteNotificationLog(userId, dedupeKey) {
  if (!userId || !dedupeKey) return false;
  if (!USE_PG) {
    if (!data.notificationLogs) return false;
    const len = data.notificationLogs.length;
    data.notificationLogs = data.notificationLogs.filter((n) => !(n.userId === userId && n.dedupeKey === dedupeKey));
    if (data.notificationLogs.length !== len) {
      persistJson();
      return true;
    }
    return false;
  }
  await init();
  const r = await pool.query('DELETE FROM notification_log WHERE user_id=$1 AND dedupe_key=$2', [userId, dedupeKey]);
  return (r.rowCount || 0) > 0;
}

async function hasAttendanceBeenNotified(userId, { qid, classDate, subjectCode, subject, status, prevStatus } = {}) {
  if (!userId || !classDate) return false;
  const q = String(qid || '').trim();
  const cDate = String(classDate).trim();
  const sCode = String(subjectCode || '').trim().toUpperCase();
  const subj = String(subject || '').trim().toUpperCase();
  const stat = String(status || '').trim().toLowerCase();

  if (!USE_PG) {
    const logs = data.notificationLogs || [];
    return logs.some((n) => {
      if (n.userId !== userId) return false;
      const key = String(n.dedupeKey || '').toUpperCase();
      const meta = n.metadata || {};
      const metaSubj = String(meta.subject || '').toUpperCase();
      const metaCode = String(meta.subjectCode || '').toUpperCase();

      const keyMatch =
        (key.includes(cDate) && (
          (sCode && sCode !== 'MANDATORY' && key.includes(sCode)) ||
          (subj && key.includes(subj)) ||
          (meta.classDate === cDate && (metaCode === sCode || (subj && metaSubj === subj)))
        ));
      if (!keyMatch) return false;

      // Status check
      if (stat) {
        if (
          key.toLowerCase().endsWith(`:${stat}`) ||
          key.toLowerCase().endsWith(`->${stat}`) ||
          String(meta.status || '').toLowerCase() === stat ||
          String(meta.newStatus || '').toLowerCase() === stat
        ) {
          return true;
        }
      }
      return false;
    });
  }

  await init();
  const sql = `
    SELECT 1 FROM notification_log
    WHERE user_id = $1
      AND (
        (dedupe_key LIKE '%' || $2 || '%' AND (
          ($3 != '' AND $3 != 'MANDATORY' AND UPPER(dedupe_key) LIKE '%' || $3 || '%')
          OR ($4 != '' AND UPPER(dedupe_key) LIKE '%' || $4 || '%')
          OR (metadata->>'classDate' = $2 AND (UPPER(metadata->>'subjectCode') = $3 OR ($4 != '' AND UPPER(metadata->>'subject') = $4)))
        ))
      )
      AND (
        metadata->>'status' = $5
        OR metadata->>'newStatus' = $5
        OR LOWER(dedupe_key) LIKE '%:' || $5
        OR LOWER(dedupe_key) LIKE '%->' || $5
      )
    LIMIT 1
  `;
  const r = await pool.query(sql, [userId, cDate, sCode, subj, stat]);
  return (r.rowCount || 0) > 0;
}

// ---- scheduled message auto-deletions ----
async function addScheduledDeletion(chatId, messageId, deleteAt) {
  const row = {
    chatId: String(chatId),
    messageId: Number(messageId),
    deleteAt: Number(deleteAt),
    createdAt: Date.now(),
  };
  if (!USE_PG) {
    if (!data.scheduledDeletions) data.scheduledDeletions = [];
    const exists = data.scheduledDeletions.some(
      (r) => String(r.chatId) === row.chatId && Number(r.messageId) === row.messageId
    );
    if (!exists) {
      data.scheduledDeletions.push(row);
      persistJson();
    }
    return row;
  }
  await init();
  const existing = await pool.query(
    `SELECT id FROM scheduled_message_deletions WHERE chat_id=$1 AND message_id=$2 LIMIT 1`,
    [row.chatId, row.messageId]
  );
  if (existing.rows.length === 0) {
    await pool.query(
      `INSERT INTO scheduled_message_deletions(chat_id, message_id, delete_at, created_at) VALUES($1, $2, $3, $4)`,
      [row.chatId, row.messageId, row.deleteAt, row.createdAt]
    );
  }
  return row;
}

async function listPendingDeletions() {
  if (!USE_PG) {
    return (data.scheduledDeletions || []).slice();
  }
  await init();
  const res = await pool.query(`SELECT chat_id AS "chatId", message_id AS "messageId", delete_at AS "deleteAt" FROM scheduled_message_deletions ORDER BY delete_at ASC`);
  return res.rows.map((r) => ({
    chatId: r.chatId,
    messageId: Number(r.messageId),
    deleteAt: Number(r.deleteAt),
  }));
}

async function removeScheduledDeletion(chatId, messageId) {
  if (!USE_PG) {
    if (!data.scheduledDeletions) return 0;
    const before = data.scheduledDeletions.length;
    data.scheduledDeletions = data.scheduledDeletions.filter(
      (r) => !(String(r.chatId) === String(chatId) && Number(r.messageId) === Number(messageId))
    );
    if (data.scheduledDeletions.length !== before) persistJson();
    return before - data.scheduledDeletions.length;
  }
  await init();
  const res = await pool.query(
    `DELETE FROM scheduled_message_deletions WHERE chat_id=$1 AND message_id=$2`,
    [String(chatId), Number(messageId)]
  );
  return res.rowCount || 0;
}

// ---------------------------------------------------------------------------
// Centralized ERP Session Registry (One QUMS Account = One Active Session)
// ---------------------------------------------------------------------------

class SessionConflictError extends Error {
  constructor(message, activeErp, requestedErp) {
    super(message);
    this.name = 'SessionConflictError';
    this.code = 'SESSION_CONFLICT';
    this.activeErp = activeErp;
    this.requestedErp = requestedErp;
  }
}

function normalizeQumsIdentity(id) {
  return String(id || '').trim().toLowerCase();
}

async function getActiveErpSession(qumsIdentity) {
  const normId = normalizeQumsIdentity(qumsIdentity);
  if (!normId) return null;
  if (!USE_PG) {
    const list = data.activeErpSessions || [];
    return list.find((s) => normalizeQumsIdentity(s.qumsIdentity) === normId && s.status === 'active') || null;
  }
  await init();
  const res = await pool.query(
    `SELECT qums_identity AS "qumsIdentity", user_id AS "userId", erp_type AS "erpType", session_id AS "sessionId", status, created_at AS "createdAt", updated_at AS "updatedAt", last_active_at AS "lastActiveAt" FROM active_erp_sessions WHERE LOWER(qums_identity) = $1 AND status = 'active' LIMIT 1`,
    [normId]
  );
  return res.rows[0] || null;
}

async function getActiveErpSessionByUserId(userId) {
  if (!userId) return null;
  if (!USE_PG) {
    const list = data.activeErpSessions || [];
    return list.find((s) => s.userId === userId && s.status === 'active') || null;
  }
  await init();
  const res = await pool.query(
    `SELECT qums_identity AS "qumsIdentity", user_id AS "userId", erp_type AS "erpType", session_id AS "sessionId", status, created_at AS "createdAt", updated_at AS "updatedAt", last_active_at AS "lastActiveAt" FROM active_erp_sessions WHERE user_id = $1 AND status = 'active' LIMIT 1`,
    [userId]
  );
  return res.rows[0] || null;
}

async function acquireErpSession({ qumsIdentity, userId, erpType, sessionId = newId() }) {
  const normId = normalizeQumsIdentity(qumsIdentity);
  if (!normId || !userId || !erpType) {
    throw new Error('acquireErpSession requires qumsIdentity, userId, and erpType.');
  }
  const targetType = erpType.toUpperCase(); // 'OLD' or 'NEW'
  const existing = await getActiveErpSession(normId);

  if (existing && existing.erpType !== targetType && existing.status === 'active') {
    const otherTypeLabel = existing.erpType === 'OLD' ? 'Old ERP' : 'New ERP';
    const targetTypeLabel = targetType === 'OLD' ? 'Old ERP' : 'New ERP';
    throw new SessionConflictError(
      `This QUMS account is already active in ${otherTypeLabel}. Please disconnect the existing session before switching to ${targetTypeLabel}.`,
      existing.erpType,
      targetType
    );
  }

  // Also check if this user has another active session under a different identity
  const userExisting = await getActiveErpSessionByUserId(userId);
  if (userExisting && userExisting.erpType !== targetType && userExisting.status === 'active') {
    const otherTypeLabel = userExisting.erpType === 'OLD' ? 'Old ERP' : 'New ERP';
    const targetTypeLabel = targetType === 'OLD' ? 'Old ERP' : 'New ERP';
    throw new SessionConflictError(
      `This QUMS account is already active in ${otherTypeLabel}. Please disconnect the existing session before switching to ${targetTypeLabel}.`,
      userExisting.erpType,
      targetType
    );
  }

  const now = new Date().toISOString();
  const sessionRecord = {
    qumsIdentity: normId,
    userId,
    erpType: targetType,
    sessionId: String(sessionId),
    status: 'active',
    createdAt: (existing && existing.createdAt) || now,
    updatedAt: now,
    lastActiveAt: now,
  };

  if (!USE_PG) {
    if (!data.activeErpSessions) data.activeErpSessions = [];
    const idx = data.activeErpSessions.findIndex((s) => normalizeQumsIdentity(s.qumsIdentity) === normId);
    if (idx >= 0) {
      data.activeErpSessions[idx] = sessionRecord;
    } else {
      data.activeErpSessions.push(sessionRecord);
    }
    persistJson();
  } else {
    await init();
    await pool.query(
      `INSERT INTO active_erp_sessions (qums_identity, user_id, erp_type, session_id, status, created_at, updated_at, last_active_at)
       VALUES ($1, $2, $3, $4, 'active', NOW(), NOW(), NOW())
       ON CONFLICT (qums_identity) DO UPDATE SET
         user_id = EXCLUDED.user_id,
         erp_type = EXCLUDED.erp_type,
         session_id = EXCLUDED.session_id,
         status = 'active',
         updated_at = NOW(),
         last_active_at = NOW()`,
      [normId, userId, targetType, String(sessionId)]
    );
  }

  // Keep user active_erp_type updated
  await updateUser(userId, { activeErpType: targetType }).catch(() => {});
  return sessionRecord;
}

async function releaseErpSession(qumsIdentity, userId) {
  const normId = normalizeQumsIdentity(qumsIdentity);
  if (!normId && !userId) return false;
  if (!USE_PG) {
    if (!data.activeErpSessions) return false;
    let modified = false;
    for (const s of data.activeErpSessions) {
      if ((normId && normalizeQumsIdentity(s.qumsIdentity) === normId) || (userId && s.userId === userId)) {
        s.status = 'released';
        s.updatedAt = new Date().toISOString();
        modified = true;
      }
    }
    if (modified) persistJson();
    return modified;
  }
  await init();
  const query = normId
    ? `UPDATE active_erp_sessions SET status = 'released', updated_at = NOW() WHERE LOWER(qums_identity) = $1`
    : `UPDATE active_erp_sessions SET status = 'released', updated_at = NOW() WHERE user_id = $1`;
  const val = normId || userId;
  const res = await pool.query(query, [val]);
  return (res.rowCount || 0) > 0;
}

async function releaseAllErpSessionsForUser(userId) {
  return releaseErpSession(null, userId);
}

// ---------------------------------------------------------------------------
// Admin Audit Logs
// ---------------------------------------------------------------------------

async function logAdminAudit({ adminId, adminEmail, action, targetUserIds = [], details = {} }) {
  const row = {
    id: USE_PG ? undefined : (data.adminAuditLogs ? data.adminAuditLogs.length + 1 : 1),
    adminId: String(adminId || 'unknown'),
    adminEmail: String(adminEmail || 'admin'),
    action: String(action || 'UNKNOWN_ACTION'),
    targetUserIds: Array.isArray(targetUserIds) ? targetUserIds : [targetUserIds],
    details: details || {},
    createdAt: new Date().toISOString(),
  };

  if (!USE_PG) {
    if (!data.adminAuditLogs) data.adminAuditLogs = [];
    data.adminAuditLogs.push(row);
    if (data.adminAuditLogs.length > 5000) {
      data.adminAuditLogs = data.adminAuditLogs.slice(-5000);
    }
    persistJson();
    return row;
  }

  await init();
  const res = await pool.query(
    `INSERT INTO admin_audit_logs (admin_id, admin_email, action, target_user_ids, details, created_at)
     VALUES ($1, $2, $3, $4, $5, NOW()) RETURNING id, admin_id AS "adminId", admin_email AS "adminEmail", action, target_user_ids AS "targetUserIds", details, created_at AS "createdAt"`,
    [row.adminId, row.adminEmail, row.action, JSON.stringify(row.targetUserIds), JSON.stringify(row.details)]
  );
  return res.rows[0];
}

async function listAdminAuditLogs({ limit = 50, offset = 0, action = null } = {}) {
  const lim = Math.max(1, Math.min(200, Number(limit) || 50));
  const off = Math.max(0, Number(offset) || 0);

  if (!USE_PG) {
    let logs = (data.adminAuditLogs || []).slice().reverse();
    if (action) {
      logs = logs.filter((l) => l.action === action);
    }
    const total = logs.length;
    return {
      total,
      limit: lim,
      offset: off,
      logs: logs.slice(off, off + lim),
    };
  }

  await init();
  let where = '';
  const params = [];
  if (action) {
    params.push(action);
    where = `WHERE action = $${params.length}`;
  }
  const countRes = await pool.query(`SELECT COUNT(*)::int AS n FROM admin_audit_logs ${where}`, params);
  const total = (countRes.rows[0] && countRes.rows[0].n) || 0;

  params.push(lim);
  params.push(off);
  const rowsRes = await pool.query(
    `SELECT id, admin_id AS "adminId", admin_email AS "adminEmail", action, target_user_ids AS "targetUserIds", details, created_at AS "createdAt"
     FROM admin_audit_logs ${where} ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  return {
    total,
    limit: lim,
    offset: off,
    logs: rowsRes.rows,
  };
}

// ---------------------------------------------------------------------------
// New ERP Timetable & Attendance Cache
// ---------------------------------------------------------------------------

async function upsertNewErpTimetable(userId, timetableData) {
  if (!userId || !timetableData) return 0;
  const rows = Array.isArray(timetableData.rows) ? timetableData.rows : [];
  const now = new Date().toISOString();

  if (!USE_PG) {
    if (!data.newErpTimetable) data.newErpTimetable = [];
    data.newErpTimetable = data.newErpTimetable.filter((t) => t.userId !== userId);
    for (const r of rows) {
      data.newErpTimetable.push({
        userId,
        dayOfWeek: r.dayOfWeek || 0,
        periodTime: r.periodTime || r.period || '',
        subjectName: r.subjectName || r.subject || '',
        facultyName: r.facultyName || r.faculty || r.teacher || '',
        classroom: r.classroom || r.room || '',
        rawData: r,
        lastUpdated: now,
      });
    }
    persistJson();
    return rows.length;
  }

  await init();
  for (const r of rows) {
    await pool.query(
      `INSERT INTO new_erp_timetable (user_id, day_of_week, period_time, subject_name, faculty_name, classroom, raw_data, last_updated)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
       ON CONFLICT (user_id, day_of_week, period_time, subject_name) DO UPDATE SET
         faculty_name = EXCLUDED.faculty_name,
         classroom = EXCLUDED.classroom,
         raw_data = EXCLUDED.raw_data,
         last_updated = NOW()`,
      [
        userId,
        r.dayOfWeek || 0,
        r.periodTime || r.period || '',
        r.subjectName || r.subject || '',
        r.facultyName || r.faculty || r.teacher || '',
        r.classroom || r.room || '',
        JSON.stringify(r),
      ]
    );
  }
  return rows.length;
}

async function getNewErpTimetable(userId) {
  if (!userId) return { success: true, hasData: false, timetable: { days: [] } };
  if (!USE_PG) {
    const list = (data.newErpTimetable || []).filter((t) => t.userId === userId);
    if (!list.length) return null;
    return {
      success: true,
      hasData: true,
      updatedAt: list[0].lastUpdated,
      timetable: {
        rows: list.map((l) => ({
          dayOfWeek: l.dayOfWeek,
          periodTime: l.periodTime,
          subjectName: l.subjectName,
          facultyName: l.facultyName,
          classroom: l.classroom,
        })),
      },
    };
  }

  await init();
  const res = await pool.query(
    `SELECT day_of_week AS "dayOfWeek", period_time AS "periodTime", subject_name AS "subjectName", faculty_name AS "facultyName", classroom, raw_data AS "rawData", last_updated AS "lastUpdated"
     FROM new_erp_timetable WHERE user_id = $1 ORDER BY day_of_week, period_time`,
    [userId]
  );
  if (!res.rows.length) return null;
  return {
    success: true,
    hasData: true,
    updatedAt: res.rows[0].lastUpdated,
    timetable: {
      rows: res.rows,
    },
  };
}

async function saveNewErpAttendanceCache(userId, { summary = {}, subjectWise = [], dailyRecords = [] } = {}) {
  if (!userId) return false;
  const now = new Date().toISOString();
  if (!USE_PG) {
    if (!data.newErpAttendanceCache) data.newErpAttendanceCache = [];
    const idx = data.newErpAttendanceCache.findIndex((c) => c.userId === userId);
    const rec = { userId, summary, subjectWise, dailyRecords, lastUpdated: now };
    if (idx >= 0) {
      data.newErpAttendanceCache[idx] = rec;
    } else {
      data.newErpAttendanceCache.push(rec);
    }
    persistJson();
    return true;
  }

  await init();
  await pool.query(
    `INSERT INTO new_erp_attendance_cache (user_id, summary, subject_wise, daily_records, last_updated)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       summary = EXCLUDED.summary,
       subject_wise = EXCLUDED.subject_wise,
       daily_records = EXCLUDED.daily_records,
       last_updated = NOW()`,
    [userId, JSON.stringify(summary), JSON.stringify(subjectWise), JSON.stringify(dailyRecords)]
  );
  return true;
}

async function getNewErpAttendanceCache(userId) {
  if (!userId) return null;
  if (!USE_PG) {
    const rec = (data.newErpAttendanceCache || []).find((c) => c.userId === userId);
    return rec || null;
  }
  await init();
  const res = await pool.query(
    `SELECT summary, subject_wise AS "subjectWise", daily_records AS "dailyRecords", last_updated AS "lastUpdated"
     FROM new_erp_attendance_cache WHERE user_id = $1 LIMIT 1`,
    [userId]
  );
  return res.rows[0] || null;
}

/** Record a reconnect event with its source ('telegram' | 'web') */
async function recordUserReconnect(userId, source = 'web', log = console) {
  const normSource = source === 'telegram' ? 'telegram' : 'web';
  const now = new Date().toISOString();
  if (!USE_PG) {
    const user = (data.users || []).find((u) => u.id === userId);
    if (user) {
      user.lastReconnectSource = normSource;
      user.lastReconnectedAt = now;
      if (normSource === 'telegram') {
        user.reconnectCountTelegram = (Number(user.reconnectCountTelegram) || 0) + 1;
      } else {
        user.reconnectCountWeb = (Number(user.reconnectCountWeb) || 0) + 1;
      }
      data.reconnectEvents = data.reconnectEvents || [];
      data.reconnectEvents.push({ userId, source: normSource, reconnectedAt: now });
      persistJson();
    }
    return;
  }
  await init();
  try {
    const colToInc = normSource === 'telegram' ? 'reconnect_count_telegram' : 'reconnect_count_web';
    await pool.query(
      `UPDATE users SET last_reconnect_source=$1, last_reconnected_at=NOW(), ${colToInc} = COALESCE(${colToInc}, 0) + 1 WHERE id=$2`,
      [normSource, userId]
    );
    await pool.query(
      `INSERT INTO reconnect_events(user_id, source, reconnected_at) VALUES($1, $2, NOW())`,
      [userId, normSource]
    );
  } catch (err) {
    log.error(`[db] recordUserReconnect failed for user ${userId}: ${err.message}`);
  }
}

module.exports={
  DB_FILE,QUMS_SESSION_DIR,NEW_ERP_SESSION_DIR,USE_PG,init,hasUsers,allUsers,getUserByEmail,getUserById,getUserByFirebaseUid,createUser,updateUser,deleteUser,sessionPathFor,sessionPathForNewErp,
  ensureSessionOnDisk,saveUserSessionData,ensureNewErpSessionOnDisk,saveNewErpSessionData,decodeSessionData,
  storeResetToken,consumeResetToken,listKnownAttendance,addKnownAttendance,upsertKnownAttendance,removeKnownAttendance,upsertWeeklySchedule,getWeeklySchedule,clearWeeklySchedule,
  telegramLinkCodeFor,getUserByTelegramLinkCode,getUserByTelegramChatId,setTelegramChatId,clearTelegramChatForChat,clearTelegramChatId,
  listKnownAssignments,addKnownAssignments,removeKnownAssignment,updateKnownAssignmentMessageId,
  // structured identity & monitoring (Migration 011/012)
  getQumsIdentities, getActiveQumsIdentity, switchQumsIdentity,
  saveAttendanceRecord, listAttendanceRecords,
  saveAssignmentRecord, listAssignmentRecords,
  tryRecordNotificationLog, hasNotificationLog, deleteNotificationLog, hasAttendanceBeenNotified,
  getIstDateString,
  // migrations / schema
  runMigrations, schemaHealth, importLocalJsonData, sslConfig,
  // per-user sync bookkeeping
  touchUserSync, setUserAdmin, setUserSuspended, getQumsEncryptedPassword,
  // session-expiry state (PostgreSQL-backed)
  SESSION_ALERT_COOLDOWN_MS, getSessionExpiryState, markSessionExpired, recordSessionExpiryAlert, getSessionExpiryMessageIds, clearSessionExpiry, clearSessionExpiryTelegramMessage, listSessionExpiredUsers,
  // scheduled message auto-deletions
  addScheduledDeletion, listPendingDeletions, removeScheduledDeletion,
  // notification log / analytics
  NOTIFICATION_KINDS, recordNotification, notificationStats, recentNotifications,
  // admin
  safeAdminUser, applyAdminFilters, listUsersForAdmin, getMatchingUserIdsForAdmin, adminStats, ping, recordUserReconnect,
  // ERP session exclusivity & New ERP helpers
  SessionConflictError, getActiveErpSession, getActiveErpSessionByUserId, acquireErpSession, releaseErpSession, releaseAllErpSessionsForUser,
  logAdminAudit, listAdminAuditLogs,
  upsertNewErpTimetable, getNewErpTimetable, saveNewErpAttendanceCache, getNewErpAttendanceCache,
};
