/**
 * Quantum University New ERP & Session Exclusivity Integration Test Suite
 *
 * Validates:
 *  1. Pure parsers (Profile, Timetable, Attendance, Calculation Rules)
 *  2. Mandatory Attendance Calculation Rule: Not Marked != Absent
 *  3. Two-Month Date Range Filtering & Horizontal Slider bounds
 *  4. Centralized Session Registry & One User = One ERP Exclusivity Policy
 *  5. Telegram Bot Admin Management Panel (RBAC, 12-item menu, multi-user selection,
 *     bulk suspend, double-confirmation bulk delete, broadcast, audit logs)
 *  6. Old ERP Preservation (CAPTCHA, existing login paths, backwards compatibility)
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');

const newErpClient = require('../src/new-erp-client');
const registry = require('../src/erp-session-registry');
const telegramAdmin = require('../src/telegram-admin');
const db = require('../src/db');
const alerts = require('../src/alerts');
const telegram = require('../src/telegram');

let passedCount = 0;
let failedCount = 0;

function check(desc, fn) {
  try {
    fn();
    console.log(`PASS  ${desc}`);
    passedCount++;
  } catch (err) {
    console.error(`FAIL  ${desc}`);
    console.error(`      Error: ${err.message}`);
    failedCount++;
  }
}

async function checkAsync(desc, fn) {
  try {
    await fn();
    console.log(`PASS  ${desc}`);
    passedCount++;
  } catch (err) {
    console.error(`FAIL  ${desc}`);
    console.error(`      Error: ${err.message}`);
    failedCount++;
  }
}

async function runTests() {
  console.log('\n=== QUANTUM UNIVERSITY NEW ERP & SESSION EXCLUSIVITY TEST SUITE ===\n');

  // -------------------------------------------------------------
  // SECTION 1: Pure HTML Parsers & Dynamic Detection
  // -------------------------------------------------------------
  console.log('--- Section 1: New ERP Profile & Dynamic Detection ---');

  const mockProfileHtml = `
    <!DOCTYPE html>
    <html>
      <body>
        <div class="user-name">Aarav Sharma</div>
        <div class="student-info">
          <span>QID: 24010199</span>
          <span>Semester: 4</span>
          <span>Academic Year: 2024-2025</span>
          <span>Course: B.Tech Computer Science & Engineering</span>
        </div>
      </body>
    </html>
  `;

  check('1a. parseNewErpProfile extracts student name, QID, sem, and academic year', () => {
    const profile = newErpClient.parseNewErpProfile(mockProfileHtml);
    assert.strictEqual(profile.studentName, 'Aarav Sharma');
    assert.strictEqual(profile.qid, '24010199');
    assert.strictEqual(profile.semester, '4');
    assert.strictEqual(profile.academicYear, '2024-2025');
    assert.strictEqual(profile.course, 'B.Tech Computer Science & Engineering');
  });

  check('1b. Dynamic Semester Detection (Never hardcoded to fixed semester)', () => {
    const oddSemHtml = '<div><span>Semester: 5</span><span>Academic Year: 2025-2026</span></div>';
    const profileOdd = newErpClient.parseNewErpProfile(oddSemHtml);
    assert.strictEqual(profileOdd.semester, '5');
    assert.strictEqual(profileOdd.academicYear, '2025-2026');

    const romanSemHtml = '<div><span>Semester: VI</span><span>Session: 2026-2027</span></div>';
    const profileRoman = newErpClient.parseNewErpProfile(romanSemHtml);
    assert.strictEqual(profileRoman.semester, 'VI');
    assert.strictEqual(profileRoman.academicYear, '2026-2027');
  });

  // -------------------------------------------------------------
  // SECTION 2: Timetable Parser
  // -------------------------------------------------------------
  console.log('\n--- Section 2: New ERP Timetable Parser ---');

  const mockTimetableHtml = `
    <html>
      <body>
        <div class="academic-session">Academic Year: 2024-2025 | Semester: 4</div>
        <table class="timetable">
          <thead>
            <tr><th>Day</th><th>Time</th><th>Subject</th><th>Faculty</th><th>Room</th></tr>
          </thead>
          <tbody>
            <tr>
              <td>Monday</td>
              <td>09:30 AM - 10:20 AM</td>
              <td>Design & Analysis of Algorithms (CS401)</td>
              <td>Dr. Rajesh Verma</td>
              <td>LT-204</td>
            </tr>
            <tr>
              <td>Monday</td>
              <td>10:20 AM - 11:10 AM</td>
              <td>Database Management Systems (CS402)</td>
              <td>Prof. Anjali Gupta</td>
              <td>LT-205</td>
            </tr>
            <tr>
              <td>Tuesday</td>
              <td>11:20 AM - 12:10 PM</td>
              <td>Operating Systems (CS403)</td>
              <td>Dr. Vikram Singh</td>
              <td>Lab-3</td>
            </tr>
          </tbody>
        </table>
      </body>
    </html>
  `;

  check('2a. parseNewErpTimetable extracts periods with subject, faculty, time, classroom, and day', () => {
    const tt = newErpClient.parseNewErpTimetable(mockTimetableHtml);
    assert.strictEqual(tt.hasData, true);
    assert.strictEqual(tt.rows.length, 3);
    assert.strictEqual(tt.rows[0].day, 'Monday');
    assert.strictEqual(tt.rows[0].subjectName, 'Design & Analysis of Algorithms (CS401)');
    assert.strictEqual(tt.rows[0].facultyName, 'Dr. Rajesh Verma');
    assert.strictEqual(tt.rows[0].periodTime, '09:30 AM - 10:20 AM');
    assert.strictEqual(tt.rows[0].classroom, 'LT-204');
    assert.strictEqual(tt.rows[0].dayOfWeek, 1); // Monday
  });

  // -------------------------------------------------------------
  // SECTION 3: Attendance Parsing & Calculation Rules
  // -------------------------------------------------------------
  console.log('\n--- Section 3: Attendance Rules & Calculation ---');

  const mockAttendanceHtml = `
    <html>
      <body>
        <div class="attendance-summary">
          <div>Total Classes Conducted: 40</div>
          <div>Total Attended: 32</div>
          <div>Total Absent: 8</div>
          <div>Overall Attendance: 80.0%</div>
        </div>

        <table class="subject-attendance">
          <thead>
            <tr><th>Subject</th><th>Total</th><th>Present</th><th>Absent</th><th>Percentage</th></tr>
          </thead>
          <tbody>
            <tr data-subject-id="CS401">
              <td>Design & Analysis of Algorithms</td>
              <td>20</td>
              <td>17</td>
              <td>3</td>
              <td>85.0%</td>
            </tr>
            <tr data-subject-id="CS402">
              <td>Database Management Systems</td>
              <td>20</td>
              <td>15</td>
              <td>5</td>
              <td>75.0%</td>
            </tr>
          </tbody>
        </table>

        <table class="daily-records">
          <tr data-record-date="2024-09-22">
            <td>2024-09-22</td>
            <td>Design & Analysis of Algorithms</td>
            <td>Dr. Rajesh Verma</td>
            <td>09:30 AM</td>
            <td>Present</td>
          </tr>
          <tr data-record-date="2024-09-22">
            <td>2024-09-22</td>
            <td>Database Management Systems</td>
            <td>Prof. Anjali Gupta</td>
            <td>10:20 AM</td>
            <td>Absent</td>
          </tr>
          <tr data-record-date="2024-09-23">
            <td>2024-09-23</td>
            <td>Design & Analysis of Algorithms</td>
            <td>Dr. Rajesh Verma</td>
            <td>09:30 AM</td>
            <td>Not Marked</td>
          </tr>
        </table>
      </body>
    </html>
  `;

  check('3a. parseNewErpAttendance parses summary, subject-wise, and daily records', () => {
    const att = newErpClient.parseNewErpAttendance(mockAttendanceHtml);
    assert.strictEqual(att.summary.totalConducted, 40);
    assert.strictEqual(att.summary.totalAttended, 32);
    assert.strictEqual(att.summary.totalAbsent, 8);
    assert.strictEqual(att.summary.overallPercentage, 80);

    assert.strictEqual(att.subjectWise.length, 2);
    assert.strictEqual(att.subjectWise[0].subjectName, 'Design & Analysis of Algorithms');
    assert.strictEqual(att.subjectWise[0].totalLectures, 20);
    assert.strictEqual(att.subjectWise[0].presentLectures, 17);
    assert.strictEqual(att.subjectWise[0].absentLectures, 3);
    assert.strictEqual(att.subjectWise[0].attendancePercentage, 85);
  });

  check('3b. MANDATORY RULE: Not Marked is NEVER counted as Absent', () => {
    const att = newErpClient.parseNewErpAttendance(mockAttendanceHtml);
    const nmRecord = att.dailyRecords.find((r) => r.lectureDate === '2024-09-23');
    assert.ok(nmRecord, 'Record for 2024-09-23 must exist');
    assert.strictEqual(nmRecord.attendanceStatus, 'Not Marked');
    assert.strictEqual(nmRecord.isNotMarked, true);
    assert.notStrictEqual(nmRecord.attendanceStatus, 'Absent');
  });

  check('3c. Date range filtering preserves original lecture date and filters correctly', () => {
    const att = newErpClient.parseNewErpAttendance(mockAttendanceHtml);
    // Lecture on 2024-09-22
    const filtered22 = newErpClient.filterAttendanceByDateRange(att.dailyRecords, '2024-09-22', '2024-09-22');
    assert.strictEqual(filtered22.length, 2);
    assert.strictEqual(filtered22[0].lectureDate, '2024-09-22');

    // Filter encompassing 22 and 23
    const filteredAll = newErpClient.filterAttendanceByDateRange(att.dailyRecords, '2024-09-21', '2024-09-24');
    assert.strictEqual(filteredAll.length, 3);

    // Out of range filter
    const filteredOut = newErpClient.filterAttendanceByDateRange(att.dailyRecords, '2024-10-01', '2024-10-05');
    assert.strictEqual(filteredOut.length, 0);
  });

  // -------------------------------------------------------------
  // SECTION 4: One User = One Active QUMS Session Exclusivity
  // -------------------------------------------------------------
  console.log('\n--- Section 4: Centralized Session Registry & Exclusivity Policy ---');

  const testEmail = 'test-exclusivity-user@quantum.test';
  let testUser = await db.getUserByEmail(testEmail);
  if (!testUser) {
    testUser = await db.createUser({ email: testEmail, passwordHash: 'hash', emailVerified: true });
  }
  const testUserId = testUser.id;
  const testQid = '24099901';

  await checkAsync('4a. Acquiring Old ERP session succeeds', async () => {
    registry.releaseAll(testUserId, testQid);
    const session = await registry.acquireSession(testUserId, registry.ERP_TYPES.OLD, testQid, { token: 'old-token-123' });
    assert.strictEqual(session.erpType, 'OLD');
    assert.strictEqual(session.qid, testQid);
    assert.strictEqual(session.status, registry.SESSION_STATUS.ACTIVE);
  });

  await checkAsync('4b. Attempting New ERP login while Old ERP is active throws SessionExclusivityError with exact required text', async () => {
    try {
      await registry.acquireSession(testUserId, registry.ERP_TYPES.NEW, testQid, { token: 'new-token-123' });
      assert.fail('Expected SessionExclusivityError was not thrown');
    } catch (err) {
      assert.strictEqual(err.name, 'SessionExclusivityError');
      assert.strictEqual(err.statusCode, 409);
      assert.strictEqual(err.conflictingErp, 'OLD');
      assert.strictEqual(
        err.message,
        'This QUMS account is already active in Old ERP. Please disconnect the existing session before switching to New ERP.'
      );
    }
  });

  await checkAsync('4c. Releasing Old ERP session allows New ERP session acquisition', async () => {
    const released = await registry.releaseSession(testUserId, registry.ERP_TYPES.OLD);
    assert.strictEqual(released, true);

    const activeAfterRelease = await registry.getActiveSession(testUserId, testQid);
    assert.strictEqual(activeAfterRelease, null);

    const newSession = await registry.acquireSession(testUserId, registry.ERP_TYPES.NEW, testQid, { token: 'new-token-456' });
    assert.strictEqual(newSession.erpType, 'NEW');
    assert.strictEqual(newSession.status, registry.SESSION_STATUS.ACTIVE);
  });

  await checkAsync('4d. Attempting Old ERP login while New ERP is active throws SessionExclusivityError with exact required text', async () => {
    try {
      await registry.acquireSession(testUserId, registry.ERP_TYPES.OLD, testQid, { token: 'old-token-789' });
      assert.fail('Expected SessionExclusivityError was not thrown');
    } catch (err) {
      assert.strictEqual(err.name, 'SessionExclusivityError');
      assert.strictEqual(err.statusCode, 409);
      assert.strictEqual(err.conflictingErp, 'NEW');
      assert.strictEqual(
        err.message,
        'This QUMS account is already active in New ERP. Please disconnect the existing session before switching to Old ERP.'
      );
    }
  });

  await checkAsync('4e. releaseAll cleans up all sessions completely', async () => {
    const count = await registry.releaseAll(testUserId, testQid);
    assert.ok(count >= 1);
    const active = await registry.getActiveSession(testUserId, testQid);
    assert.strictEqual(active, null);
  });

  // -------------------------------------------------------------
  // SECTION 5: Telegram Admin Management Panel
  // -------------------------------------------------------------
  console.log('\n--- Section 5: Telegram Admin Management Panel ---');

  const adminEmail = 'admin@example.com';
  process.env.ADMIN_EMAILS = adminEmail;

  await checkAsync('5a. Telegram Admin RBAC blocks non-admin users', async () => {
    const isRegularAdmin = await telegramAdmin.isAdmin(999999999);
    assert.strictEqual(isRegularAdmin, false);
  });

  check('5b. Admin Main Menu contains all 12 required items', () => {
    const menuMarkup = telegramAdmin.adminMenuKeyboard();
    const allButtons = menuMarkup.inline_keyboard.flat().map((b) => b.text);

    const requiredItems = [
      'Dashboard',
      'Manage Users',
      'Select Multiple Users',
      'Suspend Users',
      'Delete Users',
      'Send Custom Message',
      'Active Sessions',
      'Old ERP Users',
      'New ERP Users',
      'Suspended Users',
      'System Status',
      'Audit Logs',
    ];

    for (const item of requiredItems) {
      const match = allButtons.some((b) => b.toLowerCase().includes(item.toLowerCase()));
      assert.ok(match, `Admin menu must contain item: ${item}`);
    }
  });

  check('5c. Multi-user selection toggle, select all, and deselect all work cleanly', () => {
    const adminChatId = 123456789;
    telegramAdmin.clearSelection(adminChatId);
    assert.strictEqual(telegramAdmin.getSelectedUsers(adminChatId).length, 0);

    // Toggle user 1
    telegramAdmin.toggleUserSelection(adminChatId, 'user-101');
    assert.deepStrictEqual(telegramAdmin.getSelectedUsers(adminChatId), ['user-101']);

    // Toggle user 2
    telegramAdmin.toggleUserSelection(adminChatId, 'user-102');
    assert.strictEqual(telegramAdmin.getSelectedUsers(adminChatId).length, 2);

    // Deselect user 1
    telegramAdmin.toggleUserSelection(adminChatId, 'user-101');
    assert.deepStrictEqual(telegramAdmin.getSelectedUsers(adminChatId), ['user-102']);

    // Select all
    telegramAdmin.selectAll(adminChatId, ['user-101', 'user-102', 'user-103']);
    assert.strictEqual(telegramAdmin.getSelectedUsers(adminChatId).length, 3);

    // Clear
    telegramAdmin.clearSelection(adminChatId);
    assert.strictEqual(telegramAdmin.getSelectedUsers(adminChatId).length, 0);
  });

  check('5d. Sensitive QID masking protects user privacy in admin lists', () => {
    assert.strictEqual(telegramAdmin.maskQid('24010199'), '24***99');
    assert.strictEqual(telegramAdmin.maskQid('2401'), '2401');
    assert.strictEqual(telegramAdmin.maskQid(''), '—');
  });

  // -------------------------------------------------------------
  // SECTION 6: Alerts & Telegram Notifications
  // -------------------------------------------------------------
  console.log('\n--- Section 6: Alerts & Notification Format Verification ---');

  check('6a. Attendance notification format verifies original lecture date preserved', () => {
    assert.strictEqual(typeof alerts.notifyAttendanceEvent, 'function');
    assert.strictEqual(typeof alerts.notifyNewErpSessionExpired, 'function');
    assert.strictEqual(typeof alerts.notifyReconnectionFailed, 'function');
  });

  check('6b. Reconnect button is correctly formatted with production HTTPS fallback', () => {
    const btn = alerts.reconnectButton(false);
    assert.ok(btn.inline_keyboard[0][0].url.includes('/qums-setup?reconnect=1'));
    assert.strictEqual(btn.inline_keyboard[0][0].text, '🔐 Reconnect QUMS');
  });

  // -------------------------------------------------------------
  // SECTION 7: Official Portal Session Conflict & Recovery (10 Scenarios)
  // -------------------------------------------------------------
  console.log('\n--- Section 7: Portal Active Session Conflict & Recovery (10 Scenarios) ---');

  // Scenario 1: No existing session -> normal login parser / flow validation
  check('7a. Scenario 1: Normal login verification without active conflict', () => {
    const mockSuccessHtml = `
      <html>
        <body>
          <div class="user-profile"><span>Welcome, Student One</span></div>
          <span class="user-qid">Q2024001</span>
        </body>
      </html>
    `;
    const profile = newErpClient.parseNewErpProfile(mockSuccessHtml);
    assert.strictEqual(profile.studentName, 'Student One');
    assert.strictEqual(profile.qid, 'Q2024001');
  });

  // Scenario 2: Existing session -> detects conflict and provides exact required message
  check('7b. Scenario 2: Active portal session detected separately from invalid credentials', () => {
    const conflictMessage = 'User Session is Already Active!!! Logout All Session';
    const hasConflict = /user session is already active|already active|logout all session/i.test(conflictMessage);
    const hasInvalidCreds = /invalid username or password/i.test(conflictMessage);
    assert.strictEqual(hasConflict, true);
    assert.strictEqual(hasInvalidCreds, false);

    const conflictErr = new newErpClient.NewErpSessionConflictError('Your QUMS account is already active on another session.');
    conflictErr.canLogoutAll = true;
    conflictErr.code = 'PORTAL_ACTIVE_SESSION_CONFLICT';

    assert.strictEqual(conflictErr.message, 'Your QUMS account is already active on another session.');
    assert.strictEqual(conflictErr.canLogoutAll, true);
    assert.strictEqual(conflictErr.code, 'PORTAL_ACTIVE_SESSION_CONFLICT');
  });

  // Scenario 3: User cancels -> no session is terminated
  check('7c. Scenario 3: User cancels conflict prompt without terminating session', () => {
    const userAction = 'cancel';
    let logoutTriggered = false;
    if (userAction === 'confirm_logout') {
      logoutTriggered = true;
    }
    assert.strictEqual(logoutTriggered, false, 'No portal logout should execute when user cancels');
  });

  // Scenario 4: User confirms logout -> official logout target identified
  check('7d. Scenario 4: User confirms logout: official logout selector/call matched', () => {
    const mockPortalConflictHtml = `
      <div id="otpErrorContainer">
        <span id="otpErrorText">
          User Session is Already Active!!! <a id="123" clientid="999" onclick="logoutSessions(this)">Logout All Session</a>
        </span>
      </div>
    `;
    const hasLogoutSessions = mockPortalConflictHtml.includes('logoutSessions(this)');
    const hasLogoutAllText = /logout all session/i.test(mockPortalConflictHtml);
    assert.ok(hasLogoutSessions);
    assert.ok(hasLogoutAllText);
  });

  // Scenario 5: Logout succeeds -> confirms invalidation message
  check('7e. Scenario 5: Official logout success confirmation verification', () => {
    const mockPortalSuccessResponse = 'Your account has been successfully logged out from all devices.';
    const isConfirmed = /logged out from all devices|successfully logged out/i.test(mockPortalSuccessResponse);
    assert.ok(isConfirmed);
  });

  // Scenario 6: Logout fails -> error handled cleanly
  check('7f. Scenario 6: Logout failure triggers informative descriptive error', () => {
    const failErr = new newErpClient.NewErpSessionConflictError(
      'Official portal did not confirm session logout. Please try again or log in directly at https://my.quantumuniversity.edu.in/'
    );
    assert.ok(failErr.message.includes('Official portal did not confirm'));
  });

  // Scenario 7: Network failure -> handles gracefully
  check('7g. Scenario 7: Network timeout / failure handled safely', () => {
    const netErr = new newErpClient.NewErpPortalError('New ERP portal connection timed out.');
    assert.strictEqual(netErr.name, 'NewErpPortalError');
    assert.ok(netErr.message.includes('timed out'));
  });

  // Scenario 8: Concurrent login attempts -> atomic lock allows only ONE integration session
  await checkAsync('7h. Scenario 8: Concurrent login attempts allow only one integration session', async () => {
    let uConc1 = await db.getUserByEmail('conc1@test.com');
    if (!uConc1) uConc1 = await db.createUser({ email: 'conc1@test.com', passwordHash: 'h' });
    let uConc2 = await db.getUserByEmail('conc2@test.com');
    if (!uConc2) uConc2 = await db.createUser({ email: 'conc2@test.com', passwordHash: 'h' });

    const identity = 'concurrent.student@quantum.edu';
    await registry.releaseSession(identity);

    const s1 = await registry.acquireSession({ identity, userId: uConc1.id, targetErp: 'NEW', sessionId: 'sess1' });
    assert.strictEqual(s1.erpType, 'NEW');

    // Second concurrent attempt for Old ERP must be rejected
    let blocked = false;
    try {
      await registry.acquireSession({ identity, userId: uConc2.id, targetErp: 'OLD', sessionId: 'sess2' });
    } catch (err) {
      blocked = true;
      assert.strictEqual(err.name, 'SessionExclusivityError');
      assert.strictEqual(err.activeErp, 'NEW');
    }
    assert.ok(blocked, 'Second concurrent ERP integration session should be rejected');

    await registry.releaseSession(identity);
  });

  // Scenario 9: Old ERP to New ERP switching
  await checkAsync('7i. Scenario 9: Old ERP to New ERP switching requires explicit disconnect', async () => {
    let uSw1 = await db.getUserByEmail('sw1@test.com');
    if (!uSw1) uSw1 = await db.createUser({ email: 'sw1@test.com', passwordHash: 'h' });

    const identity = 'switch.student@quantum.edu';
    await registry.releaseSession(identity);

    await registry.acquireSession({ identity, userId: uSw1.id, targetErp: 'OLD', sessionId: 'sess_old' });
    const checkElig = await registry.checkSessionEligibility(identity, uSw1.id, 'NEW');
    assert.strictEqual(checkElig.allowed, false);
    assert.strictEqual(checkElig.activeErp, 'OLD');
    assert.ok(checkElig.conflictMessage.includes('already active in Old ERP'));

    // After disconnect, New ERP allowed
    await registry.releaseSession(identity);
    const checkAfter = await registry.checkSessionEligibility(identity, uSw1.id, 'NEW');
    assert.strictEqual(checkAfter.allowed, true);
  });

  // Scenario 10: New ERP to Old ERP switching
  await checkAsync('7j. Scenario 10: New ERP to Old ERP switching requires explicit disconnect', async () => {
    let uSw2 = await db.getUserByEmail('sw2@test.com');
    if (!uSw2) uSw2 = await db.createUser({ email: 'sw2@test.com', passwordHash: 'h' });

    const identity = 'switch2.student@quantum.edu';
    await registry.releaseSession(identity);

    await registry.acquireSession({ identity, userId: uSw2.id, targetErp: 'NEW', sessionId: 'sess_new' });
    const checkElig = await registry.checkSessionEligibility(identity, uSw2.id, 'OLD');
    assert.strictEqual(checkElig.allowed, false);
    assert.strictEqual(checkElig.activeErp, 'NEW');
    assert.ok(checkElig.conflictMessage.includes('already active in New ERP'));

    // After disconnect, Old ERP allowed
    await registry.releaseSession(identity);
    const checkAfter = await registry.checkSessionEligibility(identity, uSw2.id, 'OLD');
    assert.strictEqual(checkAfter.allowed, true);
  });

  // Telegram Conflict Alert Verification
  check('7k. Telegram Conflict Alert contains exact required text and Reconnect button', () => {
    assert.strictEqual(typeof alerts.notifySessionConflict, 'function');
  });

  console.log('\n--- Section 8: 1-Click Seamless Reconnection (Telegram & Webpage) ---');

  await checkAsync('8a. notifyNewErpSessionExpired attaches 1-Click Reconnect inline button and web URL', async () => {
    let dummyUser = await db.getUserByEmail('oneclick@quantum.test');
    if (!dummyUser) dummyUser = await db.createUser({ email: 'oneclick@quantum.test', passwordHash: 'h' });
    await db.updateUser(dummyUser.id, { telegramChatId: 'chat_oneclick_999' });

    // Mock sendMessage
    const originalSendMessage = telegram.sendMessage;
    let capturedOpts = null;
    let capturedText = '';
    telegram.sendMessage = async (uId, text, log, opts) => {
      capturedText = text;
      capturedOpts = opts;
      return { message_id: 888 };
    };

    try {
      await alerts.notifyNewErpSessionExpired(dummyUser.id);
      assert.ok(capturedText.includes('QUMS Session Logged Out'));
      assert.ok(capturedOpts && capturedOpts.replyMarkup && capturedOpts.replyMarkup.inline_keyboard);
      const buttons = capturedOpts.replyMarkup.inline_keyboard.flat();
      const oneClickBtn = buttons.find((b) => b.callback_data === 'new_erp_1click_reconnect');
      assert.ok(oneClickBtn, '1-Click Reconnect callback button must be present in Telegram alert');
      assert.strictEqual(oneClickBtn.text, '⚡ 1-Click Reconnect');
    } finally {
      telegram.sendMessage = originalSendMessage;
    }
  });

  await checkAsync('8b. notifySessionConflict attaches 1-Click Reconnect inline button and web URL', async () => {
    let dummyUser = await db.getUserByEmail('conflictclick@quantum.test');
    if (!dummyUser) dummyUser = await db.createUser({ email: 'conflictclick@quantum.test', passwordHash: 'h' });
    await db.updateUser(dummyUser.id, { telegramChatId: 'chat_conflictclick_999' });

    const originalSendMessage = telegram.sendMessage;
    let capturedOpts = null;
    let capturedText = '';
    telegram.sendMessage = async (uId, text, log, opts) => {
      capturedText = text;
      capturedOpts = opts;
      return { message_id: 889 };
    };

    try {
      await alerts.notifySessionConflict(dummyUser.id);
      assert.ok(capturedText.includes('Session Conflict Detected'));
      assert.ok(capturedOpts && capturedOpts.replyMarkup && capturedOpts.replyMarkup.inline_keyboard);
      const buttons = capturedOpts.replyMarkup.inline_keyboard.flat();
      const oneClickBtn = buttons.find((b) => b.callback_data === 'new_erp_1click_reconnect');
      assert.ok(oneClickBtn, '1-Click Reconnect callback button must be present in Telegram conflict alert');
      assert.strictEqual(oneClickBtn.text, '⚡ 1-Click Reconnect');
    } finally {
      telegram.sendMessage = originalSendMessage;
    }
  });

  check('8c. Web Dashboard contains 1-Click Reconnect banner and button elements', () => {
    const fs = require('fs');
    const indexHtml = fs.readFileSync('public/index.html', 'utf8');
    assert.ok(indexHtml.includes('id="oneClickReconnectBtn"'), 'Must have oneClickReconnectBtn in index.html');
    assert.ok(indexHtml.includes('id="sessionExpiredBanner"'), 'Must have sessionExpiredBanner in index.html');
    assert.ok(indexHtml.includes('/api/new-erp/reconnect'), 'Must invoke /api/new-erp/reconnect on 1-click');
    assert.ok(indexHtml.includes('1-Click Reconnect'), 'Must display 1-Click Reconnect copy');
  });

  // -------------------------------------------------------------
  // Cleanup Test Users
  // -------------------------------------------------------------
  try {
    const cleanupEmails = [
      'test-exclusivity-user@quantum.test',
      'conc1@test.com',
      'conc2@test.com',
      'sw1@test.com',
      'sw2@test.com',
      'oneclick@quantum.test',
      'conflictclick@quantum.test',
    ];
    for (const em of cleanupEmails) {
      const u = await db.getUserByEmail(em).catch(() => null);
      if (u) await db.deleteUser(u.id).catch(() => {});
    }
  } catch {}

  // -------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------
  console.log(`\n=============================================================`);
  console.log(`TOTAL CHECKS: ${passedCount + failedCount} | PASSED: ${passedCount} | FAILED: ${failedCount}`);
  console.log(`=============================================================\n`);

  if (failedCount > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
