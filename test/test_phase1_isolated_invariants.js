process.env.DATABASE_URL = ''; // Strict local isolation
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const db = require('../src/db');
const { encryptSecret } = require('../src/crypto');
const watcher = require('../src/watcher');

async function runVerification() {
  console.log('=== RUNNING PHASE 1 PRE-DEPLOYMENT ISOLATED INVARIANT TESTS ===\n');

  // Test User Creation in isolated store
  const testUser = await db.createUser({
    email: 'phase1-verify@example.com',
    passwordHash: 'dummy_hash',
  });
  assert.ok(testUser && testUser.id, 'User created');

  const oldSessionPath = db.sessionPathFor(testUser.id);
  const newSessionPath = db.sessionPathForNewErp(testUser.id);

  // Ensure clean starting slate on disk
  if (fs.existsSync(oldSessionPath)) fs.unlinkSync(oldSessionPath);
  if (fs.existsSync(newSessionPath)) fs.unlinkSync(newSessionPath);

  // =========================================================================
  // Requirement 2 & 3: Old ERP & New ERP Session Restoration & Placeholder safety
  // =========================================================================
  console.log('--- Checking Requirement 2 & 3: Session Restoration & __HAS_SESSION__ Safety ---');

  // Case D: Session file missing + DB contains NULL/empty session data
  console.log('1. Verify missing file + NULL session data returns null and creates NO file');
  const resNullOld = await db.ensureSessionOnDisk(testUser);
  assert.strictEqual(resNullOld, null, 'Old ERP should return null when session data is null');
  assert.strictEqual(fs.existsSync(oldSessionPath), false, 'Old ERP session file must NOT be created');

  const resNullNew = await db.ensureNewErpSessionOnDisk(testUser);
  assert.strictEqual(resNullNew, null, 'New ERP should return null when session data is null');
  assert.strictEqual(fs.existsSync(newSessionPath), false, 'New ERP session file must NOT be created');
  console.log('   ✔ PASS: NULL session data safely returns null with no file written.');

  // Case: Session data is __HAS_SESSION__ but no plain JSON exists
  console.log('2. Verify __HAS_SESSION__ placeholder is NEVER written to disk');
  testUser.qumsSessionData = '__HAS_SESSION__';
  testUser.newErpSessionData = '__HAS_SESSION__';
  const resPlaceholderOld = await db.ensureSessionOnDisk(testUser);
  assert.strictEqual(resPlaceholderOld, null);
  assert.strictEqual(fs.existsSync(oldSessionPath), false, '__HAS_SESSION__ must not create old session file');

  const resPlaceholderNew = await db.ensureNewErpSessionOnDisk(testUser);
  assert.strictEqual(resPlaceholderNew, null);
  assert.strictEqual(fs.existsSync(newSessionPath), false, '__HAS_SESSION__ must not create new session file');
  console.log('   ✔ PASS: __HAS_SESSION__ is never written to disk.');

  // Case C: Database / user object contains valid encrypted session data
  console.log('3. Verify valid encrypted session data restores plain JSON to disk');
  const dummyState = JSON.stringify({ cookies: [{ name: 'test_cookie', value: 'secret123' }], origins: [] });
  const encryptedState = encryptSecret(dummyState);

  testUser.qumsSessionData = encryptedState;
  testUser.newErpSessionData = encryptedState;

  const resEncOld = await db.ensureSessionOnDisk(testUser);
  assert.strictEqual(resEncOld, oldSessionPath);
  assert.strictEqual(fs.existsSync(oldSessionPath), true, 'Old ERP session file must be created on disk');
  assert.strictEqual(fs.readFileSync(oldSessionPath, 'utf8'), dummyState, 'File content must match plain JSON');

  const resEncNew = await db.ensureNewErpSessionOnDisk(testUser);
  assert.strictEqual(resEncNew, newSessionPath);
  assert.strictEqual(fs.existsSync(newSessionPath), true, 'New ERP session file must be created on disk');
  assert.strictEqual(fs.readFileSync(newSessionPath, 'utf8'), dummyState, 'File content must match plain JSON');
  console.log('   ✔ PASS: Valid encrypted session is restored to disk with exact plain JSON.');

  // Case A: Session file already exists on disk
  console.log('4. Verify existing file returns immediately without re-writing');
  // Overwrite with a sentinel content to prove ensureSessionOnDisk does not touch existing file
  const sentinel = '{"sentinel":"existing_valid_file"}';
  fs.writeFileSync(oldSessionPath, sentinel);
  fs.writeFileSync(newSessionPath, sentinel);

  const resExistOld = await db.ensureSessionOnDisk(testUser);
  assert.strictEqual(resExistOld, oldSessionPath);
  assert.strictEqual(fs.readFileSync(oldSessionPath, 'utf8'), sentinel, 'Existing file must not be modified');

  const resExistNew = await db.ensureNewErpSessionOnDisk(testUser);
  assert.strictEqual(resExistNew, newSessionPath);
  assert.strictEqual(fs.readFileSync(newSessionPath, 'utf8'), sentinel, 'Existing file must not be modified');
  console.log('   ✔ PASS: Existing session file is preserved and immediately returned.');

  // Cleanup session files
  if (fs.existsSync(oldSessionPath)) fs.unlinkSync(oldSessionPath);
  if (fs.existsSync(newSessionPath)) fs.unlinkSync(newSessionPath);

  // =========================================================================
  // Requirement 1: allUsers() callers receive every required property
  // =========================================================================
  console.log('\n--- Checking Requirement 1: allUsers() Column & Property Contract ---');
  const allU = await db.allUsers();
  assert.ok(Array.isArray(allU) && allU.length > 0, 'allUsers returns array');
  const u = allU.find((x) => x.id === testUser.id);
  assert.ok(u, 'Test user found in allUsers');

  const expectedProperties = [
    'id', 'email', 'passwordHash', 'qumsQid', 'qumsSessionPath', 'qumsSessionData',
    'telegramLinkCode', 'telegramChatId', 'firebaseUid', 'studentName', 'qumsYearSem',
    'isAdmin', 'emailVerified', 'isSuspended', 'qumsSessionStatus', 'activeErpType',
    'newErpEmail', 'newErpPasswordEncrypted', 'newErpSessionPath', 'newErpSessionData',
    'newErpSessionStatus', 'newErpStudentName', 'newErpQid', 'newErpAcademicYear',
    'newErpSemester', 'newErpCourse', 'newErpLastSyncedAt', 'monitoringStartedDate',
    'monitoringStartedAt', 'lastAttendanceSyncAt', 'lastAssignmentSyncAt',
    'attendanceLastCheckedAt', 'assignmentLastCheckedAt', 'profileSyncedAt',
    'lastError', 'lastReconnectSource', 'lastReconnectedAt', 'reconnectCountTelegram',
    'reconnectCountWeb', 'createdAt', 'updatedAt'
  ];

  for (const prop of expectedProperties) {
    assert.ok(prop in u, `Property '${prop}' must exist on user returned by allUsers()`);
  }
  console.log(`   ✔ PASS: All ${expectedProperties.length} user model properties are present on allUsers() objects.`);

  // =========================================================================
  // Requirement 4: touchUserSync return object
  // =========================================================================
  console.log('\n--- Checking Requirement 4: touchUserSync return contract ---');
  const touchRes = await db.touchUserSync(testUser.id, { attendance: true, error: '' });
  assert.deepStrictEqual(touchRes, { ok: true, touched: true });
  const touchMissing = await db.touchUserSync('non_existent_user_id', { attendance: true });
  assert.deepStrictEqual(touchMissing, { ok: false, error: 'User not found' });
  console.log('   ✔ PASS: touchUserSync returns { ok: true, touched: true } on success, handles missing users safely.');

  // =========================================================================
  // Requirement 5 & 6: runMonthRegisterCycle() known attendance state preservation
  // =========================================================================
  console.log('\n--- Checking Requirement 5 & 6: runMonthRegisterCycle State Preservation & Dedupe ---');

  // Pre-seed known attendance
  const initialKnown = [
    { key: 'CS101-2026-11-05', date: '2026-11-05', subjectCode: 'CS101', subject: 'Subject 1', status: 'present', statusRaw: 'P' },
    { key: 'CS102-2026-11-05', date: '2026-11-05', subjectCode: 'CS102', subject: 'Subject 2', status: '', statusRaw: '' }, // legacy reseed
  ];
  await db.upsertKnownAttendance(testUser.id, initialKnown);

  const notificationsSent = [];
  const cycleResult = await watcher.runMonthRegisterCycle({
    userId: testUser.id,
    qid: '24099999',
    userEmail: testUser.email,
    todayIst: { date: '2026-11-16', hourDecimal: 10.0 },
    monitoringStartedDate: '2026-11-10', // 2026-11-08 will be olderToSilentlyStore, 2026-11-12 will be pending
    fetchFn: async () => [
      {
        year: 2026,
        month: 11,
        records: [
          // 1. Unchanged existing record
          { key: 'CS101-2026-11-05', date: '2026-11-05', subjectCode: 'CS101', subject: 'Subject 1', status: 'present', statusRaw: 'P' },
          // 2. Reseed record (previously empty status, now has status)
          { key: 'CS102-2026-11-05', date: '2026-11-05', subjectCode: 'CS102', subject: 'Subject 2', status: 'present', statusRaw: 'P' },
          // 3. Older historical record before monitoringStartedDate (olderToSilentlyStore)
          { key: 'CS103-2026-11-08', date: '2026-11-08', subjectCode: 'CS103', subject: 'Subject 3', status: 'absent', statusRaw: 'A' },
          // 4. Eligible new record on or after monitoringStartedDate (should notify)
          { key: 'CS104-2026-11-12', date: '2026-11-12', subjectCode: 'CS104', subject: 'Subject 4', status: 'absent', statusRaw: 'A' },
        ],
      },
    ],
    sendFn: async (text) => { notificationsSent.push(text); },
    log: { log: () => {}, error: () => {} },
    dryRun: false,
  });

  assert.ok(cycleResult, 'Cycle completed');
  // olderToSilentlyStore (CS103) must NOT trigger a notification
  // CS104 must trigger a notification
  assert.strictEqual(notificationsSent.length, 1, 'Only eligible new record should trigger notification');
  assert.ok(notificationsSent[0].includes('CS104') || notificationsSent[0].includes('Subject 4'), 'Notification should be for CS104');

  // Verify known attendance table state has both olderToSilentlyStore, reseed, and newly notified
  const finalKnown = await db.listKnownAttendance(testUser.id);
  const finalKeys = new Set(finalKnown.map((r) => r.key));
  assert.ok(finalKeys.has('CS101-2026-11-05'), 'CS101 must be in known attendance');
  assert.ok(finalKeys.has('CS102-2026-11-05'), 'CS102 must be in known attendance');
  assert.ok(finalKeys.has('CS103-2026-11-08'), 'CS103 (silently stored) must be in known attendance');
  assert.ok(finalKeys.has('CS104-2026-11-12'), 'CS104 (notified) must be in known attendance');

  // Second cycle: exactly same fetched records -> 0 notifications (perfect deduplication)
  const notificationsSecondCycle = [];
  await watcher.runMonthRegisterCycle({
    userId: testUser.id,
    qid: '24099999',
    userEmail: testUser.email,
    todayIst: { date: '2026-11-16', hourDecimal: 10.0 },
    monitoringStartedDate: '2026-11-10',
    fetchFn: async () => [
      {
        year: 2026,
        month: 11,
        records: [
          { key: 'CS101-2026-11-05', date: '2026-11-05', subjectCode: 'CS101', subject: 'Subject 1', status: 'present', statusRaw: 'P' },
          { key: 'CS102-2026-11-05', date: '2026-11-05', subjectCode: 'CS102', subject: 'Subject 2', status: 'present', statusRaw: 'P' },
          { key: 'CS103-2026-11-08', date: '2026-11-08', subjectCode: 'CS103', subject: 'Subject 3', status: 'absent', statusRaw: 'A' },
          { key: 'CS104-2026-11-12', date: '2026-11-12', subjectCode: 'CS104', subject: 'Subject 4', status: 'absent', statusRaw: 'A' },
        ],
      },
    ],
    sendFn: async (text) => { notificationsSecondCycle.push(text); },
    log: { log: () => {}, error: () => {} },
    dryRun: false,
  });

  assert.strictEqual(notificationsSecondCycle.length, 0, 'Second cycle must send ZERO duplicate notifications');
  console.log('   ✔ PASS: Notifications deduplicated, older records silently stored, known attendance completely accurate.');

  // Cleanup test user
  await db.deleteUser(testUser.id);
  console.log('\n=== ALL PHASE 1 INVARIANT TESTS PASSED CLEANLY! ===');
  process.exit(0);
}

runVerification().catch((err) => {
  console.error('❌ Verification failed:', err);
  process.exit(1);
});
