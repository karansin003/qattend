/**
 * Admin dashboard & API tests (Phases 20, 21, 22).
 *   node test/admin.test.js
 */
const assert = require('assert');
const path = require('path');
const fs = require('fs');

// Ensure isolated testing
process.env.NODE_ENV = 'test';
process.env.ADMIN_EMAILS = 'admin@example.com,super@college.edu';

const db = require('../src/db');

async function run() {
  console.log('=== ADMIN DASHBOARD & HEALTH TESTS ===\n');

  // Test 1: safeAdminUser never leaks sensitive fields
  const mockUser = {
    id: 'usr123',
    email: 'student@example.com',
    passwordHash: '$2a$10$abcdefghijklmnopqrstuvwxyz123456',
    qumsPasswordEncrypted: 'sensitive_encrypted_password',
    qumsSessionPath: '/tmp/test-session.json',
    qumsQid: 'Q12345',
    studentName: 'TEST STUDENT',
    qumsYearSem: 'SEM 5',
    telegramChatId: '987654321',
    telegramLinkCode: 'secret_code',
    isAdmin: false,
    createdAt: new Date().toISOString(),
    attendanceLastCheckedAt: new Date().toISOString(),
    assignmentLastCheckedAt: null,
  };

  const safe = db.safeAdminUser(mockUser, []);
  assert.strictEqual(safe.id, 'usr123');
  assert.strictEqual(safe.studentName, 'TEST STUDENT');
  assert.strictEqual(safe.qumsYearSem, 'SEM 5');
  assert.strictEqual(safe.qumsQid, 'Q12345');
  assert.strictEqual(safe.email, 'student@example.com');
  assert.strictEqual(safe.telegramConnected, true);
  assert.strictEqual(safe.sessionExpired, false);
  assert.strictEqual(safe.assignmentLastCheckedAt, '');

  // Sensitive fields must NOT exist on safeAdminUser
  assert.strictEqual(safe.passwordHash, undefined, 'passwordHash must not leak');
  assert.strictEqual(safe.qumsPasswordEncrypted, undefined, 'qumsPasswordEncrypted must not leak');
  assert.strictEqual(safe.telegramChatId, undefined, 'telegramChatId must not leak');
  assert.strictEqual(safe.telegramLinkCode, undefined, 'telegramLinkCode must not leak');
  console.log('PASS  1. safeAdminUser removes all passwords, tokens, and hashes');

  // Test 2: applyAdminFilters
  const mockRows = [
    { studentName: 'Alice Smith', email: 'alice@uni.edu', qumsQid: 'Q1001', qumsConnected: true, sessionExpired: false, telegramConnected: true },
    { studentName: 'Bob Jones', email: 'bob@uni.edu', qumsQid: 'Q1002', qumsConnected: true, sessionExpired: true, telegramConnected: false },
    { studentName: 'Charlie Brown', email: 'charlie@uni.edu', qumsQid: 'Q1003', qumsConnected: false, sessionExpired: false, telegramConnected: false },
  ];

  const searchRes = db.applyAdminFilters(mockRows, { search: 'alice' });
  assert.strictEqual(searchRes.length, 1);
  assert.strictEqual(searchRes[0].studentName, 'Alice Smith');

  const qidRes = db.applyAdminFilters(mockRows, { search: 'Q1002' });
  assert.strictEqual(qidRes.length, 1);
  assert.strictEqual(qidRes[0].studentName, 'Bob Jones');

  const filterExpired = db.applyAdminFilters(mockRows, { filter: 'session_expired' });
  assert.strictEqual(filterExpired.length, 1);
  assert.strictEqual(filterExpired[0].studentName, 'Bob Jones');

  const filterConnected = db.applyAdminFilters(mockRows, { filter: 'qums_connected' });
  assert.strictEqual(filterConnected.length, 2);

  const filterTg = db.applyAdminFilters(mockRows, { filter: 'telegram_connected' });
  assert.strictEqual(filterTg.length, 1);
  assert.strictEqual(filterTg[0].studentName, 'Alice Smith');
  console.log('PASS  2. applyAdminFilters handles search (name, email, QID) and all filter presets');

  // Test 3: admin.html exists and contains necessary elements
  const adminHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin.html'), 'utf8');
  assert.ok(adminHtml.includes('id="statTotalUsers"'), 'Total users stat element present');
  assert.ok(adminHtml.includes('id="statQumsConnected"'), 'QUMS connected stat element present');
  assert.ok(adminHtml.includes('id="statSessionExpired"'), 'Session expired stat element present');
  assert.ok(adminHtml.includes('id="statTelegramConnected"'), 'Telegram connected stat element present');
  assert.ok(adminHtml.includes('id="healthDbBadge"'), 'Database health element present');
  assert.ok(adminHtml.includes('id="healthTgBadge"'), 'Telegram health element present');
  assert.ok(adminHtml.includes('id="healthWatcherBadge"'), 'Watcher health element present');
  assert.ok(adminHtml.includes('id="healthAssignmentBadge"'), 'Assignment watcher health element present');
  assert.ok(adminHtml.includes('id="searchInput"'), 'Search input element present');
  assert.ok(adminHtml.includes('id="filterSelect"'), 'Filter dropdown present');
  assert.ok(adminHtml.includes('Not synced yet'), 'Not synced yet fallback present');
  console.log('PASS  3. public/admin.html contains all required UI components');

  console.log('\nALL ADMIN TESTS PASSED!');
}

run().catch((err) => {
  console.error('\nADMIN TEST FAILED:', err);
  process.exit(1);
});
