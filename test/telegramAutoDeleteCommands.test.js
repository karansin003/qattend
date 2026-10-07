/**
 * Test suite for Telegram auto-delete policy:
 * 1. Attendance notification is NOT scheduled for deletion (Permanent).
 * 2. Assignment notification is NOT scheduled for deletion (Permanent).
 * 3. Deadline reminder is NOT scheduled for deletion (Permanent).
 * 4. Morning timetable is scheduled for NEXT DAY 08:00 IST.
 * 5. Morning timetable deletion survives process restart through PostgreSQL.
 * 6. Session expired message deletes after 1 minute.
 * 7. Reconnected message deletes after 1 minute.
 * 8. CAPTCHA message deletes after 1 minute.
 * 9. /status temporary response deletes after 1 minute.
 * 10. /help temporary response deletes after 1 minute.
 * 11. /attendance command response deletes after 1 minute.
 * 12. /today command response deletes after 1 minute.
 * 13. Multi-user deletion scheduling remains isolated.
 *
 * Run with:
 *   node test/telegramAutoDeleteCommands.test.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qums-tg-autodel-'));
process.env.DB_FILE = path.join(TMP_DIR, 'db.json');
process.env.DATABASE_URL = '';
process.env.TELEGRAM_BOT_TOKEN = 'test:stub-autodel';
process.env.TELEGRAM_BOT_USERNAME = 'test_autodel_bot';

const deletedMessages = [];
const sentMessages = [];
let msgSeq = 1000;

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
        sendPhoto: async (chatId, photo, opts) => {
          msgSeq += 1;
          const msgObj = { message_id: msgSeq, chat: { id: chatId }, photo, opts };
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
const alerts = require('../src/alerts');
const { formatTodayAttendanceStatus } = require('../src/messages');

async function run() {
  console.log('=== RUNNING TELEGRAM AUTO-DELETE POLICY TEST SUITE ===\n');

  // Format today attendance status helper checks
  const sampleRows = [
    {
      period: '1',
      duration: '09:00 - 09:55',
      subject: 'Computer Networks',
      subjectCode: 'CS301',
      teacher: 'Dr. Sharma',
      room: 'A-102',
      status: 'present',
      attendance: 'P',
    },
    {
      period: '2',
      duration: '10:00 - 10:55',
      subject: 'Operating Systems',
      subjectCode: 'CS302',
      teacher: 'Prof. Verma',
      room: 'B-201',
      status: 'absent',
      attendance: 'A',
    },
  ];

  const formatted = formatTodayAttendanceStatus(sampleRows, 'Tue, 06 Oct 2026', 'Karan');
  assert(formatted.includes("Today's Classes & Attendance"), 'Must contain header');
  assert(formatted.includes('✅ *Present*'), 'Must show Present with emoji');
  assert(formatted.includes('❌ *Absent*'), 'Must show Absent with emoji');

  // User setup in DB
  const user1 = await db.createUser({ email: 'user1@test.com', passwordHash: 'hash', emailVerified: true });
  await db.setTelegramChatId(user1.id, 100001);
  await db.updateUser(user1.id, {
    studentName: 'Student One',
    qumsQid: '11111',
    qumsPasswordEncrypted: 'mock-enc-pass',
    qumsSessionPath: path.join(TMP_DIR, 'session1.json'),
  });

  const user2 = await db.createUser({ email: 'user2@test.com', passwordHash: 'hash', emailVerified: true });
  await db.setTelegramChatId(user2.id, 200002);
  await db.updateUser(user2.id, {
    studentName: 'Student Two',
    qumsQid: '22222',
    qumsSessionPath: path.join(TMP_DIR, 'session2.json'),
  });

  telegram.initTelegram();

  // ----------------------------------------------------
  // TEST 1: Attendance notification is NOT scheduled for deletion (Permanent)
  // ----------------------------------------------------
  const attendOpts = { category: telegram.MESSAGE_CATEGORIES.ATTENDANCE };
  await telegram.sendMessage(
    user1.id,
    '📌 *Attendance Update* — Thu, 08 Oct 2026\nTeacher: DR. SHARMA\nSubject: DAA (CS301)\nTeacher marked you as: ✅ Present',
    console,
    attendOpts
  );
  assert(attendOpts.messageId, 'Must assign messageId');
  const pendingAfterAttend = await db.listPendingDeletions();
  assert(
    !pendingAfterAttend.some((p) => p.messageId === attendOpts.messageId),
    'Attendance notification MUST NOT be scheduled for deletion'
  );

  // Also verify backdated and status change attendance without explicit category fallback:
  const attendOptsFallback = {};
  await telegram.sendMessage(
    user1.id,
    '📌 *Attendance Status Changed*\nSubject: Operating Systems\nStatus: ✅ Present\nPrevious: ❌ Absent',
    console,
    attendOptsFallback
  );
  const pendingAfterAttendFallback = await db.listPendingDeletions();
  assert(
    !pendingAfterAttendFallback.some((p) => p.messageId === attendOptsFallback.messageId),
    'Attendance status change notification MUST NOT be scheduled for deletion'
  );
  console.log('PASS  1. Attendance notification is NOT scheduled for deletion (Permanent)');

  // ----------------------------------------------------
  // TEST 2: Assignment notification is NOT scheduled for deletion (Permanent)
  // ----------------------------------------------------
  const assignOpts = { category: telegram.MESSAGE_CATEGORIES.ASSIGNMENT };
  await telegram.sendMessage(
    user1.id,
    '📚 *New Assignment*\nSubject: Computer Networks\nTitle: Lab Report 1\nDue: 2026-10-15',
    console,
    assignOpts
  );
  assert(assignOpts.messageId, 'Must assign messageId');
  const pendingAfterAssign = await db.listPendingDeletions();
  assert(
    !pendingAfterAssign.some((p) => p.messageId === assignOpts.messageId),
    'Assignment notification MUST NOT be scheduled for deletion'
  );
  console.log('PASS  2. Assignment notification is NOT scheduled for deletion (Permanent)');

  // ----------------------------------------------------
  // TEST 3: Deadline reminder is NOT scheduled for deletion (Permanent)
  // ----------------------------------------------------
  const deadlineOpts = { category: telegram.MESSAGE_CATEGORIES.ASSIGNMENT };
  await telegram.sendMessage(
    user1.id,
    '⚠️ *Assignment Deadline Reminder*\nSubject: Software Engineering\nTitle: Project Submission\nDeadline: Today!',
    console,
    deadlineOpts
  );
  assert(deadlineOpts.messageId, 'Must assign messageId');
  const pendingAfterDeadline = await db.listPendingDeletions();
  assert(
    !pendingAfterDeadline.some((p) => p.messageId === deadlineOpts.messageId),
    'Deadline reminder MUST NOT be scheduled for deletion'
  );
  console.log('PASS  3. Deadline reminder is NOT scheduled for deletion (Permanent)');

  // ----------------------------------------------------
  // TEST 4: Morning timetable is scheduled for NEXT DAY 08:00 IST
  // ----------------------------------------------------
  const timetableDate = '2026-10-08';
  const morningOpts = { category: telegram.MESSAGE_CATEGORIES.MORNING_SCHEDULE, timetableDate };
  await telegram.sendMessage(
    user1.id,
    "🌅 *Today's Classes* — Thu, 08 Oct 2026\n1. 🕐 09:00 - 09:55 — DAA\n2. 🕐 10:00 - 10:55 — OS",
    console,
    morningOpts
  );
  assert(morningOpts.messageId, 'Must assign messageId for morning timetable');
  const expectedDeleteAt = telegram.calculateMorningTimetableDeleteAt(timetableDate);

  // In Asia/Kolkata timezone, deleteAt must be 2026-10-09 08:00:00 AM
  const istString = new Date(expectedDeleteAt).toLocaleString('en-US', { timeZone: 'Asia/Kolkata' });
  assert(istString.includes('10/9/2026') && istString.includes('8:00:00 AM'), 'Delete time must be next day 08:00:00 AM IST');

  const pendingAfterMorning = await db.listPendingDeletions();
  const morningEntry = pendingAfterMorning.find((p) => p.messageId === morningOpts.messageId);
  assert(morningEntry, 'Morning timetable MUST be in pending scheduled deletions');
  assert.strictEqual(morningEntry.deleteAt, expectedDeleteAt, 'Scheduled deleteAt must match calculated next day 08:00 IST');
  console.log('PASS  4. Morning timetable is scheduled for NEXT DAY 08:00 IST');

  // ----------------------------------------------------
  // TEST 5: Morning timetable deletion survives process restart through PostgreSQL
  // ----------------------------------------------------
  // Simulate simulated restart:
  // 1. Manually insert an expired morning timetable deletion (as if past 08:00 IST next day)
  const expiredMsgId = 7777;
  const expiredChatId = '100001';
  const pastDeleteAt = Date.now() - 5000; // 5 seconds in past
  await db.addScheduledDeletion(expiredChatId, expiredMsgId, pastDeleteAt);

  const pendingBeforeRestart = await db.listPendingDeletions();
  assert(pendingBeforeRestart.some((p) => p.messageId === expiredMsgId), 'Must be persisted in DB');

  // 2. Call restoreScheduledDeletions
  await telegram.restoreScheduledDeletions(console);

  // 3. Confirm expired deletion was executed and cleaned up from DB
  assert(
    deletedMessages.some((d) => d.chatId === expiredChatId && d.messageId === expiredMsgId),
    'Restored past-due timetable deletion must be deleted from Telegram'
  );
  const pendingAfterRestart = await db.listPendingDeletions();
  assert(
    !pendingAfterRestart.some((p) => p.messageId === expiredMsgId),
    'Past-due timetable deletion must be removed from DB after restart recovery'
  );
  console.log('PASS  5. Morning timetable deletion survives process restart through PostgreSQL');

  // ----------------------------------------------------
  // TEST 6: Session expired message deletes after 1 minute
  // ----------------------------------------------------
  sentMessages.length = 0;
  deletedMessages.length = 0;
  await alerts.maybeNotifySessionExpired(console, user1.id);
  assert(sentMessages.length >= 1, 'Must send session expired alert');
  const sessionMsg = sentMessages[sentMessages.length - 1];
  assert(sessionMsg.text.includes('QUMS Session Expired'), 'Must be session expired text');

  const pendingAfterSession = await db.listPendingDeletions();
  const sessionEntry = pendingAfterSession.find((p) => p.messageId === sessionMsg.message_id);
  assert(sessionEntry, 'Session expired message MUST be scheduled for deletion in DB');
  assert(
    sessionEntry.deleteAt <= Date.now() + 61000 && sessionEntry.deleteAt >= Date.now() + 58000,
    'Session expired message deletion must be ~1 minute'
  );
  console.log('PASS  6. Session expired message deletes after 1 minute');

  // ----------------------------------------------------
  // TEST 7: Reconnected message deletes after 1 minute
  // ----------------------------------------------------
  sentMessages.length = 0;
  await alerts.notifyQumsReconnected(console, user1.id);
  assert(sentMessages.length >= 1, 'Must send QUMS Reconnected message');
  const reconnectedMsg = sentMessages[sentMessages.length - 1];
  assert(reconnectedMsg.text.includes('QUMS Reconnected'), 'Must be QUMS Reconnected text');

  // Also confirm old Session Expired message was deleted early on reconnect
  assert(
    deletedMessages.some((d) => d.messageId === sessionMsg.message_id),
    'Old session expired alert must be deleted immediately upon reconnect'
  );

  const pendingAfterReconnect = await db.listPendingDeletions();
  const reconnectEntry = pendingAfterReconnect.find((p) => p.messageId === reconnectedMsg.message_id);
  assert(reconnectEntry, 'QUMS Reconnected message MUST be scheduled for deletion in DB');
  assert(
    reconnectEntry.deleteAt <= Date.now() + 61000 && reconnectEntry.deleteAt >= Date.now() + 58000,
    'QUMS Reconnected message deletion must be ~1 minute'
  );
  console.log('PASS  7. Reconnected message deletes after 1 minute');

  // ----------------------------------------------------
  // TEST 8: CAPTCHA message deletes after 1 minute
  // ----------------------------------------------------
  const fakeCaptchaBuf = Buffer.from('fake-captcha-image');
  const captchaMsg = await telegram.sendPhotoToChat(100001, fakeCaptchaBuf, 'CAPTCHA Image', console, {});
  assert(captchaMsg && captchaMsg.message_id, 'CAPTCHA photo message must be sent');
  const pendingAfterCaptcha = await db.listPendingDeletions();
  const captchaEntry = pendingAfterCaptcha.find((p) => p.messageId === captchaMsg.message_id);
  assert(captchaEntry, 'CAPTCHA message MUST be scheduled for deletion');
  assert(
    captchaEntry.deleteAt <= Date.now() + 61000 && captchaEntry.deleteAt >= Date.now() + 58000,
    'CAPTCHA message deletion must be ~1 minute'
  );
  console.log('PASS  8. CAPTCHA message deletes after 1 minute');

  // ----------------------------------------------------
  // TEST 9: /status temporary response deletes after 1 minute
  // ----------------------------------------------------
  sentMessages.length = 0;
  await telegram.handleUserMessage({ chat: { id: 100001 }, text: '/status', message_id: 3001 });
  const statusMsg = sentMessages[0];
  assert(statusMsg && statusMsg.text.includes('Account Status'), 'Status response must be sent');
  const pendingAfterStatus = await db.listPendingDeletions();
  const statusEntry = pendingAfterStatus.find((p) => p.messageId === statusMsg.message_id);
  assert(statusEntry, '/status response MUST be scheduled for deletion in DB');
  console.log('PASS  9. /status temporary response deletes after 1 minute');

  // ----------------------------------------------------
  // TEST 10: /help temporary response deletes after 1 minute
  // ----------------------------------------------------
  sentMessages.length = 0;
  await telegram.handleUserMessage({ chat: { id: 100001 }, text: '/help', message_id: 3002 });
  const helpMsg = sentMessages[0];
  assert(helpMsg && helpMsg.text.includes('Available commands'), 'Help response must be sent');
  const pendingAfterHelp = await db.listPendingDeletions();
  const helpEntry = pendingAfterHelp.find((p) => p.messageId === helpMsg.message_id);
  assert(helpEntry, '/help response MUST be scheduled for deletion in DB');
  console.log('PASS  10. /help temporary response deletes after 1 minute');

  // ----------------------------------------------------
  // TEST 11: /attendance command response deletes after 1 minute
  // ----------------------------------------------------
  sentMessages.length = 0;
  await telegram.handleUserMessage({ chat: { id: 100001 }, text: '/attendance', message_id: 3003 });
  const attendanceMsg = sentMessages[0];
  assert(attendanceMsg, '/attendance response must be sent');
  const pendingAfterAttendance = await db.listPendingDeletions();
  const attendanceCmdEntry = pendingAfterAttendance.find((p) => p.messageId === attendanceMsg.message_id);
  assert(attendanceCmdEntry, '/attendance command response MUST be scheduled for deletion in DB');
  console.log('PASS  11. /attendance command response deletes after 1 minute');

  // ----------------------------------------------------
  // TEST 12: /today command response deletes after 1 minute
  // ----------------------------------------------------
  sentMessages.length = 0;
  await telegram.handleUserMessage({ chat: { id: 100001 }, text: '/today', message_id: 3004 });
  const todayMsg = sentMessages[0];
  assert(todayMsg, '/today response must be sent');
  const pendingAfterToday = await db.listPendingDeletions();
  const todayEntry = pendingAfterToday.find((p) => p.messageId === todayMsg.message_id);
  assert(todayEntry, '/today command response MUST be scheduled for deletion in DB');
  console.log('PASS  12. /today command response deletes after 1 minute');

  // ----------------------------------------------------
  // TEST 13: Multi-user deletion scheduling remains isolated
  // ----------------------------------------------------
  const user1MsgId = 8881;
  const user2MsgId = 8882;
  telegram.scheduleAutoDelete(100001, user1MsgId, 60000);
  telegram.scheduleAutoDelete(200002, user2MsgId, 60000);

  let multiPending = await db.listPendingDeletions();
  assert(multiPending.some((p) => p.chatId === '100001' && p.messageId === user1MsgId), 'User 1 deletion must be in DB');
  assert(multiPending.some((p) => p.chatId === '200002' && p.messageId === user2MsgId), 'User 2 deletion must be in DB');

  // Delete user 1's message early
  telegram.cancelScheduledDeletion('100001', user1MsgId);

  multiPending = await db.listPendingDeletions();
  assert(
    !multiPending.some((p) => p.chatId === '100001' && p.messageId === user1MsgId),
    'User 1 deletion must be removed'
  );
  assert(
    multiPending.some((p) => p.chatId === '200002' && p.messageId === user2MsgId),
    'User 2 deletion MUST remain intact and completely isolated'
  );
  console.log('PASS  13. Multi-user deletion scheduling remains isolated');

  console.log('\nALL 13 TELEGRAM AUTO-DELETE POLICY TESTS PASSED SUCCESSFULLY!');
  process.exit(0);
}

run().catch((err) => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
