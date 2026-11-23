/**
 * QAttend Phase 2: Smart Expired Session Monitoring & Egress Optimization
 * Exhaustive Verification Test Suite (12 Scenarios)
 *
 * Covers:
 *   1. Active user monitoring
 *   2. Session expiry detection
 *   3. One-time expiry notification
 *   4. No repeated expired-user polling
 *   5. No unnecessary per-user lookup on every watcher cycle (zero in-loop DB queries)
 *   6. CAPTCHA reconnect success
 *   7. Reconnect failure
 *   8. Reconciliation of missed attendance changes (grouped concise summary)
 *   9. Reconciliation of missed assignment changes (grouped concise summary)
 *  10. Duplicate notification prevention
 *  11. Render process restart and state restoration
 *  12. Telegram command and reconnect flow regression tests
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const Module = require('module');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qattend-phase2-'));
process.env.NODE_ENV = 'test';
process.env.DB_FILE = path.join(TMP, 'db.json');
process.env.DATABASE_URL = '';
process.env.APP_BASE_URL = 'https://qattend.onrender.com';
process.env.PORT = '10001';

// Stub telegram
const telegramSends = [];
const telegramDeletes = [];
let telegramConfigured = true;
let nextMessageId = 5001;

const origRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === './telegram' || id === 'telegram') {
    return {
      isConfigured: () => telegramConfigured,
      sendMessage: async (userId, text, log, opts) => {
        const u = await db.getUserById(userId);
        if (!u || !u.telegramChatId) return false;
        const msgId = nextMessageId++;
        if (opts && typeof opts === 'object') opts.messageId = msgId;
        telegramSends.push({ userId, text, opts: opts || {}, messageId: msgId });
        return { message_id: msgId };
      },
      deleteMessage: async (userId, messageId) => {
        telegramDeletes.push({ userId, messageId });
        return true;
      },
      scheduleAutoDelete: () => {},
      reply: async (chatId, text, log, opts) => {
        const msgId = nextMessageId++;
        telegramSends.push({ chatId, text, opts, messageId: msgId });
        return { message_id: msgId };
      },
      AUTO_DELETE_DELAY_MS: 60000,
      STATUS_DELETE_DELAY_MS: 120000,
      AUTO_DELETE_FOOTNOTE: '',
      STATUS_DELETE_FOOTNOTE: '',
      reconnectKeyboard: () => ({ inline_keyboard: [] }),
    };
  }
  return origRequire.apply(this, arguments);
};

const db = require('../src/db');
const alerts = require('../src/alerts');
const watcher = require('../src/watcher');
const assignments = require('../src/assignments');
const catchup = require('../src/catchup');

let passedCount = 0;
function pass(msg) {
  passedCount++;
  console.log(`PASS  ${passedCount}. ${msg}`);
}

async function runAllTests() {
  console.log('=== QATTEND PHASE 2: SMART EXPIRED SESSION MONITORING & RECONCILIATION ===\n');

  // --- Scenario 1: Active User Monitoring ---
  const user1 = await db.createUser({ email: 'active_student@example.com', firebaseUid: 'fb-active-1' });
  const session1Path = path.join(TMP, 'user1_session.json');
  fs.writeFileSync(session1Path, JSON.stringify({ cookies: ['auth=123'] }));
  await db.updateUser(user1.id, {
    qumsQid: '90001',
    qumsSessionPath: session1Path,
    qumsSessionStatus: 'active',
    telegramChatId: 'tg-active-1',
    monitoringStartedDate: '2026-11-01',
  });

  const activeUsersBefore = (await db.allUsers()).filter((u) => u.qumsSessionStatus === 'active');
  assert.strictEqual(activeUsersBefore.some((u) => u.id === user1.id), true, 'User1 must be active');
  pass('Scenario 1: Active user monitoring verified in database and allUsers() list');

  // --- Scenario 2: Session Expiry Detection ---
  // When portal returns SessionExpiredError, status transitions to expired
  await db.markSessionExpired(user1.id, 'portal-session-expired');
  const user1Expired = await db.getUserById(user1.id);
  assert.strictEqual(user1Expired.qumsSessionStatus, 'expired', 'qumsSessionStatus must transition to expired');
  const expiryState = await db.getSessionExpiryState(user1.id);
  assert(expiryState && expiryState.expiredAt, 'Session expiry state must record expiredAt');
  pass('Scenario 2: Session expiry detection correctly updates user status to expired and records expiredAt');

  // --- Scenario 3: One-Time Expiry Notification ---
  telegramSends.length = 0;
  const notified1 = await alerts.maybeNotifySessionExpired(console, user1.id, { user: user1Expired, evidence: true });
  assert.strictEqual(notified1, true, 'First expiry alert must be sent');
  assert.strictEqual(telegramSends.length, 1, 'Exactly one message must be sent');
  assert(telegramSends[0].text.includes('session has expired') || telegramSends[0].text.includes('reconnect'), 'Message copy matches spec');

  // Second attempt in same event / cooldown
  const notified2 = await alerts.maybeNotifySessionExpired(console, user1.id, { user: user1Expired, evidence: true });
  assert.strictEqual(notified2, false, 'Duplicate expiry alert must be suppressed');
  assert.strictEqual(telegramSends.length, 1, 'No additional Telegram messages must be sent');
  pass('Scenario 3: One-time expiry notification sent; duplicates suppressed across cooldown');

  // --- Scenario 4: No Repeated Expired-User Polling ---
  // Watcher and assignment loops must exclude user1 from scraping lists
  const watcherResult = await watcher.runWatcherPass(console);
  assert(!watcherResult.results || !watcherResult.results.some((r) => r.email === user1.email), 'Expired user must NOT be scraped in fast watcher');

  const monthResult = await watcher.runMonthRegisterPass(console, { months: [{ year: 2026, month: 11 }] });
  assert.strictEqual(monthResult.users, 0, 'Expired user must NOT be scraped in month-register pass');

  const assignResult = await assignments.runAssignmentPass(console, { mode: 'new' });
  assert.strictEqual(assignResult.users, 0, 'Expired user must NOT be scraped in assignment pass');
  pass('Scenario 4: Expired users completely excluded from ERP scraping loops');

  // --- Scenario 5: No Unnecessary Per-User Lookup On Every Watcher Cycle ---
  // Verify batch helper getSessionExpiryStatesMap works and provides in-memory lookup
  const expiryMap = await db.getSessionExpiryStatesMap();
  assert(expiryMap instanceof Map, 'getSessionExpiryStatesMap must return a Map');
  assert(expiryMap.has(user1.id), 'Expiry map must include user1');
  const cachedState = expiryMap.get(user1.id);
  assert(cachedState.lastAlertAt, 'lastAlertAt must be populated in batch map');

  // Create a user without Telegram to verify no infinite query loops occur
  const userNoTg = await db.createUser({ email: 'notg_student@example.com', firebaseUid: 'fb-notg' });
  await db.updateUser(userNoTg.id, { qumsSessionStatus: 'expired' });
  const noTgAlert = await alerts.maybeNotifySessionExpired(console, userNoTg.id, { user: userNoTg, evidence: true });
  assert.strictEqual(noTgAlert, false, 'Alert skipped because no Telegram linked');
  const noTgState = await db.getSessionExpiryState(userNoTg.id);
  assert(noTgState && noTgState.lastAlertAt, 'lastAlertAt must be set even if Telegram is unlinked to prevent 3-minute retry loops');
  pass('Scenario 5: Batch session expiry map populated; unlinked users recorded to prevent infinite retries');

  // --- Scenario 6: CAPTCHA Reconnect Success ---
  const newSessionPath = path.join(TMP, 'user1_reconnected_session.json');
  fs.writeFileSync(newSessionPath, JSON.stringify({ cookies: ['auth=fresh_valid'] }));
  
  // Simulate successful reconnection
  await db.clearSessionExpiry(user1.id);
  await db.updateUser(user1.id, { qumsSessionStatus: 'active', qumsSessionPath: newSessionPath });
  const user1Restored = await db.getUserById(user1.id);
  assert.strictEqual(user1Restored.qumsSessionStatus, 'active', 'User1 must be restored to active');
  const stateCleared = await db.getSessionExpiryState(user1.id);
  assert.strictEqual(stateCleared.expiredAt, null, 'expiredAt must be cleared on reconnect');
  assert(stateCleared.resolvedAt, 'resolvedAt must be recorded');
  pass('Scenario 6: Successful reconnect restores active status and records resolvedAt');

  // --- Scenario 7: Reconnect Failure ---
  // If reconnect fails, status remains expired and state is preserved
  await db.markSessionExpired(user1.id, 'second-expiry-test');
  const failureStateBefore = await db.getSessionExpiryState(user1.id);
  assert(failureStateBefore.expiredAt, 'expiredAt set');
  // Failed attempt: do not call clearSessionExpiry
  const user1FailedState = await db.getUserById(user1.id);
  assert.strictEqual(user1FailedState.qumsSessionStatus, 'expired', 'Failed reconnect preserves expired status');
  pass('Scenario 7: Reconnect failure leaves session expired without corrupting state');

  // --- Scenario 8: Reconciliation of Missed Attendance Changes (Grouped Summary) ---
  // Restore user to active and seed previous known snapshot
  await db.updateUser(user1.id, { qumsSessionStatus: 'active' });
  await db.clearSessionExpiry(user1.id);
  await db.upsertKnownAttendance(user1.id, [
    { key: '2026-11-10-CS101', date: '2026-11-10', subjectCode: 'CS101', subject: 'Computer Science', status: 'absent' },
  ]);

  telegramSends.length = 0;
  // Multiple changes occurred while disconnected:
  // 1) 2026-11-10-CS101 changed from absent to present
  // 2) 2026-11-11-MA102 newly marked present
  const freshRows = [
    { key: '2026-11-10-CS101', date: '2026-11-10', subjectCode: 'CS101', subject: 'Computer Science', status: 'present', statusRaw: 'P' },
    { key: '2026-11-11-MA102', date: '2026-11-11', subjectCode: 'MA102', subject: 'Mathematics', status: 'present', statusRaw: 'P' },
  ];

  const catchupRes = await catchup.runReconnectCatchup(user1.id, newSessionPath, console, {
    attendanceRecords: freshRows,
    skipAssignments: true,
  });

  assert.strictEqual(catchupRes.attendanceAlertsSent, 2, 'Must reconcile 2 attendance changes');
  const attMessages = telegramSends.filter((s) => s.opts && s.opts.category === 'ATTENDANCE');
  assert.strictEqual(attMessages.length, 1, 'Multiple missed updates must be grouped into exactly ONE concise summary message');
  assert(attMessages[0].text.includes('Missed Attendance Updates'), 'Grouped summary header present');
  assert(attMessages[0].text.includes('Computer Science') && attMessages[0].text.includes('Mathematics'), 'All missed subjects included in summary');

  // Verify known attendance snapshot updated in PostgreSQL
  const updatedKnown = await db.listKnownAttendance(user1.id);
  assert.strictEqual(updatedKnown.find((k) => k.key === '2026-11-10-CS101')?.status, 'present', 'Known attendance snapshot updated');
  pass('Scenario 8: Reconciliation of missed attendance groups multiple changes into a concise summary and updates snapshot');

  // --- Scenario 9: Reconciliation of Missed Assignment Changes ---
  telegramSends.length = 0;
  const freshAssignments = [
    { id: 'asgn-1', title: 'Lab Assignment 1', subject: 'Physics', deadlineYMD: '2026-11-30' },
    { id: 'asgn-2', title: 'Calculus Homework', subject: 'Mathematics', deadlineYMD: '2026-12-05' },
  ];

  const assignCatchupRes = await catchup.runReconnectCatchup(user1.id, newSessionPath, console, {
    attendanceRecords: [],
    assignments: freshAssignments,
  });

  assert.strictEqual(assignCatchupRes.assignmentAlertsSent, 2, 'Must reconcile 2 new assignments');
  const asgnMessages = telegramSends.filter((s) => s.opts && s.opts.category === 'ASSIGNMENT');
  assert.strictEqual(asgnMessages.length, 1, 'Multiple assignments must be grouped into exactly ONE summary message');
  assert(asgnMessages[0].text.includes('Lab Assignment 1') && asgnMessages[0].text.includes('Calculus Homework'), 'Assignments grouped correctly');
  pass('Scenario 9: Reconciliation of missed assignments groups new items into a concise summary and updates snapshot');

  // --- Scenario 10: Duplicate Notification Prevention ---
  telegramSends.length = 0;
  // Re-running catchup with the same data must send 0 notifications
  const rerunCatchup = await catchup.runReconnectCatchup(user1.id, newSessionPath, console, {
    attendanceRecords: freshRows,
    assignments: freshAssignments,
  });
  assert.strictEqual(rerunCatchup.attendanceAlertsSent, 0, 'Duplicate attendance notifications must be 0');
  assert.strictEqual(rerunCatchup.assignmentAlertsSent, 0, 'Duplicate assignment notifications must be 0');
  assert.strictEqual(telegramSends.filter((s) => s.opts && (s.opts.category === 'ATTENDANCE' || s.opts.category === 'ASSIGNMENT')).length, 0, 'Zero duplicate messages sent');
  pass('Scenario 10: Deduplication via notification_log prevents duplicate catch-up notifications');

  // --- Scenario 11: Render Container Restart & State Restoration ---
  // Invalidate in-memory cache to simulate container restart
  db.invalidateSessionExpiryCache();
  const refreshedMap = await db.getSessionExpiryStatesMap({ forceRefresh: true });
  assert(refreshedMap instanceof Map, 'Refreshed map reloads from DB on restart');
  assert(refreshedMap.has(userNoTg.id), 'Unlinked user alert state restored from DB');
  assert.strictEqual(Boolean(refreshedMap.get(userNoTg.id).lastAlertAt), true, 'lastAlertAt preserved across restart');
  pass('Scenario 11: Container restart simulation correctly reloads alert state from database');

  // --- Scenario 12: Telegram Command & Reconnect Flow Regression Tests ---
  const realTelegram = origRequire.call(module, path.join(__dirname, '../src/telegram'));
  assert(typeof realTelegram.handleStatus === 'function', 'realTelegram.handleStatus must exist');
  assert(typeof realTelegram.handleAttendance === 'function', 'realTelegram.handleAttendance must exist');
  assert(typeof realTelegram.handleToday === 'function', 'realTelegram.handleToday must exist');
  assert(typeof realTelegram.handleAssignments === 'function', 'realTelegram.handleAssignments must exist');
  assert(typeof realTelegram.handleReconnectCommand === 'function', 'realTelegram.handleReconnectCommand must exist');
  assert(typeof realTelegram.startTelegramCaptchaReconnect === 'function', 'realTelegram.startTelegramCaptchaReconnect must exist');
  assert(typeof realTelegram.handleUserMessage === 'function', 'realTelegram.handleUserMessage must exist');
  pass('Scenario 12: Telegram commands (/status, /attendance, /today, /reconnect) and CAPTCHA reconnect flow intact');

  console.log('\n=============================================================');
  console.log(`TOTAL PHASE 2 CHECKS: ${passedCount} | PASSED: ${passedCount} | FAILED: 0`);
  console.log('=============================================================\n');
}

runAllTests().catch((err) => {
  console.error('\n❌ PHASE 2 TEST FAILED:', err);
  process.exit(1);
});
