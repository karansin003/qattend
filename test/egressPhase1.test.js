process.env.DATABASE_URL = ''; // Test isolation
const assert = require('assert');
const db = require('../src/db');
const watcher = require('../src/watcher');

async function runTests() {
  console.log('--- Starting Phase 1 Egress Optimization Tests ---');

  // Test 1: touchUserSync return value and behavior
  console.log('Test 1: db.touchUserSync return contract and timestamp update');
  const testEmail = `egress-test-${Date.now()}@example.com`;
  const created = await db.createUser({ email: testEmail, passwordHash: 'TestPassword123!' });
  assert.ok(created && created.id, 'User should be created');

  const touchResult = await db.touchUserSync(created.id, { attendance: true });
  assert.strictEqual(typeof touchResult, 'object', 'touchUserSync should return an object');
  assert.strictEqual(touchResult.ok, true, 'touchUserSync should return ok: true');
  assert.strictEqual(touchResult.touched, true, 'touchUserSync should return touched: true');

  // Verify timestamps were actually updated
  const updatedUser = await db.getUserById(created.id);
  assert.ok(updatedUser.lastAttendanceSyncAt, 'lastAttendanceSyncAt should be populated');
  assert.ok(updatedUser.attendanceLastCheckedAt, 'attendanceLastCheckedAt should be populated');
  console.log('✔ PASS: touchUserSync updates timestamps and returns { ok: true, touched: true }');

  // Test 2: allUsers column projection & session handling
  console.log('Test 2: db.allUsers column optimization & session preservation');
  assert.ok(db.ALL_USERS_COLUMNS, 'ALL_USERS_COLUMNS should be exported');
  const cols = db.ALL_USERS_COLUMNS.split(', ');
  assert.ok(!cols.includes('qums_session_data'), 'Raw unprojected qums_session_data should not be in ALL_USERS_COLUMNS');
  assert.ok(!cols.includes('new_erp_session_data'), 'Raw unprojected new_erp_session_data should not be in ALL_USERS_COLUMNS');
  assert.ok(db.ALL_USERS_COLUMNS.includes('__HAS_SESSION__'), 'qums_session_data should use __HAS_SESSION__ case expression');

  // Verify allUsers returns array of users
  const users = await db.allUsers();
  assert.ok(Array.isArray(users), 'allUsers should return an array');
  const foundUser = users.find((u) => u.id === created.id);
  assert.ok(foundUser, 'Newly created user should exist in allUsers');
  assert.strictEqual(foundUser.email, testEmail, 'Email should match');

  // Test getUserSessionData helper
  const oldSession = await db.getUserSessionData(created.id, 'OLD');
  assert.strictEqual(oldSession, null, 'Unset session data should return null');
  console.log('✔ PASS: allUsers projects lightweight session indicators and getUserSessionData helper works');

  // Test 3: watcher.runMonthRegisterCycle calls listKnownAttendance exactly once
  console.log('Test 3: watcher.runMonthRegisterCycle eliminates duplicate listKnownAttendance call');
  let listKnownAttendanceCalls = 0;
  const originalListKnownAttendance = db.listKnownAttendance;

  // Intercept listKnownAttendance to count invocations
  db.listKnownAttendance = async function (uid) {
    listKnownAttendanceCalls++;
    return originalListKnownAttendance.call(db, uid);
  };

  try {
    const fakeFetched = [
      {
        year: 2026,
        month: 11,
        records: [
          {
            key: 'CS101-2026-11-10-P1',
            date: '2026-11-10',
            subjectCode: 'CS101',
            subject: 'Computer Science',
            status: 'present',
            statusRaw: 'P',
          },
        ],
      },
    ];

    const result = await watcher.runMonthRegisterCycle({
      userId: created.id,
      qid: '1234567',
      userEmail: testEmail,
      todayIst: { date: '2026-11-10', hourDecimal: 10.0 },
      monitoringStartedDate: '2026-11-01',
      fetchFn: async () => fakeFetched,
      sendFn: async () => {},
      log: { log: () => {}, error: () => {} },
      dryRun: true,
    });

    assert.ok(result, 'Cycle should return a result');
    assert.strictEqual(
      listKnownAttendanceCalls,
      1,
      `Expected listKnownAttendance to be called exactly 1 time per cycle, got ${listKnownAttendanceCalls}`
    );
    console.log('✔ PASS: listKnownAttendance is called exactly 1 time per cycle (duplicate DB read eliminated)');
  } finally {
    db.listKnownAttendance = originalListKnownAttendance;
  }

  // Cleanup test user
  await db.deleteUser(created.id);
  console.log('--- All Phase 1 Egress Optimization Tests Passed Successfully! ---');
  process.exit(0);
}

runTests().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
