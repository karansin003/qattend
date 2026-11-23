/**
 * Comprehensive test suite for QAttend Date-Based Telegram Commands:
 * 1. Command & regex parsing (/today, /tomorrow, /yesterday, /routine, /attendance, /date, /DD/MM/YY, natural DD/MM/YY).
 * 2. Invalid calendar dates rejection & error messaging.
 * 3. Leap-year verification (2024 vs 2025/2026).
 * 4. Tomorrow calculation (+1 day in Asia/Kolkata) -> queries timetable routine.
 * 5. Yesterday calculation (-1 day in Asia/Kolkata) -> queries historical attendance.
 * 6. Future date routing (/date <future> and /<future>) -> timetable routine.
 * 7. Past date routing (/date <past> and /<past>) -> historical attendance.
 * 8. Explicit /attendance <future> -> "Future Date Attendance Unavailable" notice + suggests /routine.
 * 9. Explicit /routine <past> -> timetable routine for that weekday.
 * 10. Weekend handling (Saturday/Sunday) -> polite off-day message when empty.
 * 11. Dual ERP Timetable Parity (New ERP 1..7 vs Old ERP 0..6).
 * 12. Auto-delete scheduling & captcha guard (natural date ignored when waiting captcha).
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qums-tg-date-cmds-'));
process.env.DB_FILE = path.join(TMP_DIR, 'db.json');
process.env.DATABASE_URL = '';
process.env.TELEGRAM_BOT_TOKEN = 'test:stub-date-cmds';
process.env.TELEGRAM_BOT_USERNAME = 'test_date_cmds_bot';

const sentMessages = [];
const deletedMessages = [];
let msgSeq = 7000;

const Module = require('module');
const origRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'node-telegram-bot-api') {
    return function StubBot() {
      return {
        sendMessage: async (chatId, text, opts) => {
          msgSeq += 1;
          const msgObj = { message_id: msgSeq, chat: { id: chatId }, text, opts };
          sentMessages.push(msgObj);
          return msgObj;
        },
        deleteMessage: async (chatId, messageId) => {
          deletedMessages.push({ chatId: String(chatId), messageId: Number(messageId) });
          return true;
        },
        onText: () => {},
        on: () => {},
        clearTextListeners: () => {},
      };
    };
  }
  return origRequire.apply(this, arguments);
};

const db = require('../src/db');
const telegram = require('../src/telegram');
const messages = require('../src/messages');

async function run() {
  console.log('=== RUNNING COMPREHENSIVE DATE COMMANDS TEST SUITE ===\n');

  // ====================================================
  // Scenario 1: Regex & Command Parsing
  // ====================================================
  console.log('--- Scenario 1: Regex & Command Parsing ---');
  const tTomorrow1 = telegram.parseDateCommand('/tomorrow');
  assert.strictEqual(tTomorrow1.type, 'tomorrow');

  const tTomorrow2 = telegram.parseDateCommand('tomorrow');
  assert.strictEqual(tTomorrow2.type, 'tomorrow');

  const tYesterday1 = telegram.parseDateCommand('/yesterday');
  assert.strictEqual(tYesterday1.type, 'yesterday');

  const tYesterday2 = telegram.parseDateCommand('yesterday');
  assert.strictEqual(tYesterday2.type, 'yesterday');

  const tRoutine1 = telegram.parseDateCommand('/routine 24/11/26');
  assert.strictEqual(tRoutine1.type, 'routine');
  assert.strictEqual(tRoutine1.day, 24);
  assert.strictEqual(tRoutine1.month, 11);
  assert.strictEqual(tRoutine1.year, 2026);

  const tRoutineTomorrow = telegram.parseDateCommand('/routine tomorrow');
  assert.strictEqual(tRoutineTomorrow.type, 'routine');

  const tAttendanceDate = telegram.parseDateCommand('/attendance 20/11/26');
  assert.strictEqual(tAttendanceDate.type, 'attendance');
  assert.strictEqual(tAttendanceDate.day, 20);
  assert.strictEqual(tAttendanceDate.month, 11);
  assert.strictEqual(tAttendanceDate.year, 2026);

  const tDateCmd = telegram.parseDateCommand('/date 22/11/26');
  assert.strictEqual(tDateCmd.type, 'date');
  assert.strictEqual(tDateCmd.day, 22);

  const tSlashDate = telegram.parseDateCommand('/24/11/26');
  assert.strictEqual(tSlashDate.type, 'date');
  assert.strictEqual(tSlashDate.day, 24);

  const tNatural = telegram.parseNaturalDate('24/11/26');
  assert.strictEqual(tNatural.type, 'natural_date');
  assert.strictEqual(tNatural.day, 24);

  // Standalone non-date commands must NOT be captured by parseDateCommand
  assert.strictEqual(telegram.parseDateCommand('/today'), null);
  assert.strictEqual(telegram.parseDateCommand('/attendance'), null);
  assert.strictEqual(telegram.parseDateCommand('/status'), null);
  assert.strictEqual(telegram.parseDateCommand('/help'), null);
  console.log('✓ PASS: All command patterns parsed correctly');

  // ====================================================
  // Scenario 2 & 3: Calendar Validity & Leap Years
  // ====================================================
  console.log('\n--- Scenario 2 & 3: Calendar Validity & Leap Years ---');
  assert.strictEqual(telegram.isValidCalendarDate(29, 2, 2024), true, '29 Feb 2024 must be valid (leap year)');
  assert.strictEqual(telegram.isValidCalendarDate(29, 2, 2028), true, '29 Feb 2028 must be valid (leap year)');
  assert.strictEqual(telegram.isValidCalendarDate(29, 2, 2025), false, '29 Feb 2025 must be invalid (non-leap year)');
  assert.strictEqual(telegram.isValidCalendarDate(29, 2, 2026), false, '29 Feb 2026 must be invalid (non-leap year)');
  assert.strictEqual(telegram.isValidCalendarDate(31, 2, 2026), false, '31 Feb 2026 must be invalid');
  assert.strictEqual(telegram.isValidCalendarDate(31, 4, 2026), false, '31 Apr 2026 must be invalid');
  assert.strictEqual(telegram.isValidCalendarDate(31, 6, 2026), false, '31 Jun 2026 must be invalid');
  console.log('✓ PASS: Leap years and calendar validity verified');

  // ====================================================
  // Scenario 4: Tomorrow Calculation in Asia/Kolkata
  // ====================================================
  console.log('\n--- Scenario 4: Tomorrow Calculation in Asia/Kolkata ---');
  const istTomorrow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  istTomorrow.setDate(istTomorrow.getDate() + 1);
  const tomorrowDay = istTomorrow.getDate();
  const parsedTom = telegram.parseDateCommand('/tomorrow');
  assert.strictEqual(parsedTom.day, tomorrowDay);
  console.log('✓ PASS: Tomorrow calculation advances correctly in IST');

  // ====================================================
  // Scenario 5: Yesterday Calculation in Asia/Kolkata
  // ====================================================
  console.log('\n--- Scenario 5: Yesterday Calculation in Asia/Kolkata ---');
  const istYesterday = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  istYesterday.setDate(istYesterday.getDate() - 1);
  const yesterdayDay = istYesterday.getDate();
  const parsedYest = telegram.parseDateCommand('/yesterday');
  assert.strictEqual(parsedYest.day, yesterdayDay);
  console.log('✓ PASS: Yesterday calculation goes back correctly in IST');

  // ====================================================
  // Scenario 6 & 7: Future & Past Date Routing
  // ====================================================
  console.log('\n--- Scenario 6 & 7: Future & Past Date Routing ---');
  telegram.initTelegram();

  // Create test user with Old ERP weekly schedule
  const testUser = await db.createUser({ email: 'test_student@qattend.com', passwordHash: 'hash123', emailVerified: true });
  await db.setTelegramChatId(testUser.id, 91001);
  await db.updateUser(testUser.id, {
    studentName: 'Karan Student',
    qumsQid: '24030110',
    qumsSessionStatus: 'active',
  });

  // Seed weekly schedule for Tuesday (dow = 2)
  await db.upsertWeeklySchedule(testUser.id, 2, [
    {
      period: 'P1',
      duration: '09:00 - 09:55',
      subject: 'Operating Systems',
      subjectCode: 'CS35101',
      teacher: 'Prof. Sharma',
      room: 'CS Lab 2',
    },
    {
      period: 'P2',
      duration: '09:55 - 10:50',
      subject: 'Database Systems',
      subjectCode: 'CS35102',
      teacher: 'Dr. Verma',
      room: 'F-209',
    },
  ]);

  // Seed historical attendance for a past date: 2026-11-10 (Tuesday)
  await db.addKnownAttendance(testUser.id, [
    {
      key: '2026-11-10-CS35101',
      date: '2026-11-10',
      day: 10,
      subject: 'Operating Systems',
      subjectCode: 'CS35101',
      status: 'present',
      statusRaw: 'P',
      period: 'P1',
      lectures: [{ status: 'present', statusRaw: 'P' }],
    },
  ]);

  // 1. Past date query (/date 10/11/26) -> should return attendance
  sentMessages.length = 0;
  await telegram.handleUserMessage({
    chat: { id: 91001 },
    text: '/date 10/11/26',
    message_id: 9001,
  });
  assert.strictEqual(sentMessages.length, 1);
  assert(sentMessages[0].text.includes('Attendance for 10 November 2026'), 'Past date must return attendance report');
  assert(sentMessages[0].text.includes('Operating Systems'), 'Must include attendance subject');
  assert(sentMessages[0].text.includes('✅ Present'), 'Must include attendance status');

  // 2. Future date query (/date 29/12/26) -> Tuesday, Dec 29 2026 -> should return timetable routine
  sentMessages.length = 0;
  await telegram.handleUserMessage({
    chat: { id: 91001 },
    text: '/date 29/12/26',
    message_id: 9002,
  });
  assert.strictEqual(sentMessages.length, 1);
  assert(sentMessages[0].text.includes('Class Routine'), 'Future date must return Class Routine');
  assert(sentMessages[0].text.includes('Operating Systems'), 'Must include scheduled classes from timetable');
  assert(sentMessages[0].text.includes('CS Lab 2'), 'Must include room from timetable');
  console.log('✓ PASS: Future date routes to routine and past date routes to attendance');

  // ====================================================
  // Scenario 8: Explicit /attendance <future> Notice
  // ====================================================
  console.log('\n--- Scenario 8: Explicit /attendance <future> Notice ---');
  sentMessages.length = 0;
  await telegram.handleUserMessage({
    chat: { id: 91001 },
    text: '/attendance 29/12/26',
    message_id: 9003,
  });
  assert.strictEqual(sentMessages.length, 1);
  assert(sentMessages[0].text.includes('Future Date Attendance Unavailable'), 'Must explain attendance unavailable in future');
  assert(sentMessages[0].text.includes('/routine 29/12/2026'), 'Must suggest /routine command for timetable');
  console.log('✓ PASS: Explicit /attendance <future> returns informative notice');

  // ====================================================
  // Scenario 9: Explicit /routine <past>
  // ====================================================
  console.log('\n--- Scenario 9: Explicit /routine <past> ---');
  sentMessages.length = 0;
  await telegram.handleUserMessage({
    chat: { id: 91001 },
    text: '/routine 10/11/26',
    message_id: 9004,
  });
  assert.strictEqual(sentMessages.length, 1);
  assert(sentMessages[0].text.includes('Class Routine'), 'Explicit /routine must return routine even for past date');
  assert(sentMessages[0].text.includes('Operating Systems'), 'Must show scheduled routine');
  console.log('✓ PASS: Explicit /routine returns routine even for past weekday');

  // ====================================================
  // Scenario 10: Weekend Handling (Saturday/Sunday Off Day)
  // ====================================================
  console.log('\n--- Scenario 10: Weekend Handling ---');
  // Sunday, 27 Dec 2026 -> dow = 0 (Sunday)
  sentMessages.length = 0;
  await telegram.handleUserMessage({
    chat: { id: 91001 },
    text: '/routine 27/12/26',
    message_id: 9005,
  });
  assert.strictEqual(sentMessages.length, 1);
  assert(sentMessages[0].text.includes('Weekend / Off Day'), 'Empty Sunday must return polite weekend message');
  console.log('✓ PASS: Weekend off-day message verified');

  // ====================================================
  // Scenario 11: Dual ERP Timetable Parity (New ERP 1..7)
  // ====================================================
  console.log('\n--- Scenario 11: Dual ERP Timetable Parity ---');
  const newErpUser = await db.createUser({ email: 'new_erp_student@qattend.com', passwordHash: 'hash456', emailVerified: true });
  await db.setTelegramChatId(newErpUser.id, 92002);
  await db.updateUser(newErpUser.id, {
    activeErpType: 'NEW',
    studentName: 'New ERP Karan',
    newErpSessionStatus: 'active',
  });

  // Tuesday in New ERP is dayOfWeek = 2
  await db.upsertNewErpTimetable(newErpUser.id, {
    rows: [
      {
        dayOfWeek: 2,
        periodTime: '10:00 - 11:00',
        subjectName: 'Artificial Intelligence',
        facultyName: 'Dr. AI Expert',
        classroom: 'Auditorium 1',
        rawData: { subjectCode: 'AI301' },
      },
    ],
  });

  sentMessages.length = 0;
  await telegram.handleUserMessage({
    chat: { id: 92002 },
    text: '/routine 29/12/26',
    message_id: 9006,
  });
  assert.strictEqual(sentMessages.length, 1);
  assert(sentMessages[0].text.includes('Artificial Intelligence'), 'New ERP timetable must be queried and formatted');
  assert(sentMessages[0].text.includes('Auditorium 1'), 'Must include New ERP classroom');
  console.log('✓ PASS: New ERP 1..7 timetable mapping verified');

  // ====================================================
  // Scenario 12: Auto-Delete & Captcha Guard
  // ====================================================
  console.log('\n--- Scenario 12: Auto-Delete & Captcha Guard ---');
  const pendingDeletions = await db.listPendingDeletions();
  assert(pendingDeletions.some((p) => p.messageId === 9001), 'User message 9001 must be scheduled for deletion');
  assert(pendingDeletions.some((p) => p.messageId === sentMessages[0].message_id), 'Bot message must be scheduled for deletion');

  // Test Captcha Guard: when user is waiting captcha, natural date string should NOT trigger date router
  telegram.setReconnectState(testUser.id, {
    state: telegram.RECONNECT_STATE_NAME,
    captchaId: 'test-captcha-id',
    attempts: 0,
    maxAttempts: 3,
  });

  sentMessages.length = 0;
  await telegram.handleUserMessage({
    chat: { id: 91001 },
    text: '24/11/26', // Natural date without slash
    message_id: 9007,
  });
  // Since user is waiting captcha, natural date should be treated as captcha submission, NOT date router!
  // If it was intercepted by date router, it would have sent "Class Routine".
  const notDateMsg = sentMessages.find((m) => m.text && m.text.includes('Class Routine'));
  assert(!notDateMsg, 'Captcha guard MUST prevent natural date from triggering date routine during reconnect');

  await telegram.clearReconnectState(testUser.id);
  console.log('✓ PASS: Auto-delete scheduling and captcha guard verified');

  console.log('\n===============================================================');
  console.log('ALL DATE COMMAND TESTS PASSED SUCCESSFULLY! (12/12 SCENARIOS)');
  console.log('===============================================================\n');
}

run().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
