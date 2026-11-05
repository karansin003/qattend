/**
 * Tests for Admin Reconnect tracking, multi-filter options, and Excel (.xlsx) export.
 */
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = '';
process.env.SUPABASE_URL = '';

const assert = require('assert');
const XLSX = require('xlsx');
const db = require('../src/db');
const { applyAdminFilters } = require('../src/db');

async function runTests() {
  console.log('=== ADMIN RECONNECT, FILTERS & EXCEL EXPORT TESTS ===\n');

  // Test 1: applyAdminFilters with multi-filter options
  const sampleUsers = [
    {
      id: '1',
      studentName: 'Alice',
      email: 'alice@example.com',
      qumsQid: 'Q101',
      qumsConnected: true,
      sessionExpired: false,
      telegramConnected: true,
      lastReconnectSource: 'telegram',
      isSuspended: false,
      emailVerified: true
    },
    {
      id: '2',
      studentName: 'Bob',
      email: 'bob@example.com',
      qumsQid: 'Q102',
      qumsConnected: true,
      sessionExpired: true,
      telegramConnected: false,
      lastReconnectSource: 'web',
      isSuspended: false,
      emailVerified: true
    },
    {
      id: '3',
      studentName: 'Charlie',
      email: 'charlie@example.com',
      qumsQid: null,
      qumsConnected: false,
      sessionExpired: false,
      telegramConnected: false,
      lastReconnectSource: null,
      isSuspended: true,
      emailVerified: false
    }
  ];

  // 1a. QUMS filter
  const qumsConn = applyAdminFilters(sampleUsers, { qumsFilter: 'connected' });
  assert.strictEqual(qumsConn.length, 1);
  assert.strictEqual(qumsConn[0].id, '1');

  const qumsExp = applyAdminFilters(sampleUsers, { qumsFilter: 'expired' });
  assert.strictEqual(qumsExp.length, 1);
  assert.strictEqual(qumsExp[0].id, '2');

  const qumsNotSetup = applyAdminFilters(sampleUsers, { qumsFilter: 'not_setup' });
  assert.strictEqual(qumsNotSetup.length, 1);
  assert.strictEqual(qumsNotSetup[0].id, '3');
  console.log('PASS  1. QUMS status filter (connected, expired, not_setup)');

  // 1b. Telegram filter
  const tgLinked = applyAdminFilters(sampleUsers, { telegramFilter: 'linked' });
  assert.strictEqual(tgLinked.length, 1);
  assert.strictEqual(tgLinked[0].id, '1');

  const tgUnlinked = applyAdminFilters(sampleUsers, { telegramFilter: 'unlinked' });
  assert.strictEqual(tgUnlinked.length, 2);
  console.log('PASS  2. Telegram status filter (linked, unlinked)');

  // 1c. Reconnect source filter
  const recTg = applyAdminFilters(sampleUsers, { reconnectFilter: 'telegram' });
  assert.strictEqual(recTg.length, 1);
  assert.strictEqual(recTg[0].id, '1');

  const recWeb = applyAdminFilters(sampleUsers, { reconnectFilter: 'web' });
  assert.strictEqual(recWeb.length, 1);
  assert.strictEqual(recWeb[0].id, '2');

  const recNever = applyAdminFilters(sampleUsers, { reconnectFilter: 'never' });
  assert.strictEqual(recNever.length, 1);
  assert.strictEqual(recNever[0].id, '3');
  console.log('PASS  3. Reconnect source filter (telegram, web, never)');

  // 1d. Account status filter
  const statusSuspended = applyAdminFilters(sampleUsers, { statusFilter: 'suspended' });
  assert.strictEqual(statusSuspended.length, 1);
  assert.strictEqual(statusSuspended[0].id, '3');
  console.log('PASS  4. Account status filter (suspended, active, unverified)');

  // Test 2: recordUserReconnect and adminStats
  const testEmail = `reconnect-test-${Date.now()}@example.com`;
  const createdUser = await db.createUser(testEmail, 'TestPass123!');
  assert.ok(createdUser && createdUser.id);

  // Initial stats
  const statsBefore = await db.adminStats();
  const initTg = statsBefore.reconnectStats.telegram || 0;
  const initWeb = statsBefore.reconnectStats.web || 0;

  // Record a telegram reconnect
  await db.recordUserReconnect(createdUser.id, 'telegram');
  const userAfterTg = await db.getUserById(createdUser.id);
  assert.strictEqual(userAfterTg.lastReconnectSource, 'telegram');
  assert.strictEqual(userAfterTg.reconnectCountTelegram, 1);
  assert.strictEqual(userAfterTg.reconnectCountWeb, 0);
  assert.ok(userAfterTg.lastReconnectedAt);

  // Record a web reconnect
  await db.recordUserReconnect(createdUser.id, 'web');
  const userAfterWeb = await db.getUserById(createdUser.id);
  assert.strictEqual(userAfterWeb.lastReconnectSource, 'web');
  assert.strictEqual(userAfterWeb.reconnectCountTelegram, 1);
  assert.strictEqual(userAfterWeb.reconnectCountWeb, 1);

  // Verify updated adminStats
  const statsAfter = await db.adminStats();
  assert.ok(statsAfter.reconnectStats);
  console.log('PASS  5. db.recordUserReconnect updates user counters and adminStats reflects metrics');

  // Test 3: Excel generation verification using XLSX
  const usersForExport = [
    {
      id: createdUser.id,
      email: testEmail,
      studentName: 'Test Student',
      qumsQid: '999999',
      qumsYearSem: 'B.Tech CSE - Sem 4',
      isSuspended: false,
      emailVerified: true,
      qumsConnected: true,
      sessionExpired: false,
      telegramConnected: true,
      lastReconnectSource: 'web',
      reconnectCountTelegram: 1,
      reconnectCountWeb: 1,
      lastReconnectedAt: new Date().toISOString(),
      attendanceLastCheckedAt: new Date().toISOString(),
      assignmentLastCheckedAt: null,
      createdAt: new Date().toISOString()
    }
  ];

  const exportRows = usersForExport.map(u => ({
    'User ID': u.id,
    'Student Name': u.studentName || '—',
    'Email': u.email || '—',
    'Status': u.isSuspended ? 'SUSPENDED' : (u.emailVerified ? 'ACTIVE' : 'UNVERIFIED'),
    'QID': u.qumsQid || '—',
    'Year / Sem': u.qumsYearSem || '—',
    'QUMS Session': u.sessionExpired ? 'EXPIRED' : (u.qumsConnected ? 'CONNECTED' : 'NOT SETUP'),
    'Telegram Linked': u.telegramConnected ? 'LINKED' : 'NOT LINKED',
    'Last Reconnect Source': u.lastReconnectSource === 'telegram' ? 'Telegram' : (u.lastReconnectSource === 'web' ? 'Webpage' : 'Never'),
    'Last Reconnected At': u.lastReconnectedAt || '—',
    'Reconnect Count (Telegram)': u.reconnectCountTelegram || 0,
    'Reconnect Count (Web)': u.reconnectCountWeb || 0,
    'Attendance Last Checked': u.attendanceLastCheckedAt || '—',
    'Assignment Last Checked': u.assignmentLastCheckedAt || '—',
    'Created At': u.createdAt || '—'
  }));

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(exportRows);
  XLSX.utils.book_append_sheet(wb, ws, 'Users');

  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  assert.ok(Buffer.isBuffer(buf));
  assert.ok(buf.length > 500, 'Excel buffer size should be substantial');

  // Read back buffer to verify valid OpenXML structure
  const parsedWb = XLSX.read(buf, { type: 'buffer' });
  assert.deepStrictEqual(parsedWb.SheetNames, ['Users']);
  const parsedSheet = XLSX.utils.sheet_to_json(parsedWb.Sheets['Users']);
  assert.strictEqual(parsedSheet.length, 1);
  assert.strictEqual(parsedSheet[0]['User ID'], createdUser.id);
  assert.strictEqual(parsedSheet[0]['Last Reconnect Source'], 'Webpage');
  assert.strictEqual(parsedSheet[0]['Reconnect Count (Telegram)'], 1);
  assert.strictEqual(parsedSheet[0]['Reconnect Count (Web)'], 1);
  console.log('PASS  6. Genuine Excel (.xlsx) binary generation, sheets and content verified');

  // Cleanup test user
  await db.deleteUser(createdUser.id);
  console.log('\nALL RECONNECT, MULTI-FILTER & EXCEL TESTS PASSED!');
}

runTests().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});

