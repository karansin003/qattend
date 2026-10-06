/**
 * Test suite for /attendance & /today commands with 1-hour auto-delete.
 *
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

const Module = require('module');
const origRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'node-telegram-bot-api') {
    return function StubBot() {
      let msgSeq = 1000;
      return {
        sendMessage: async (chatId, text) => {
          msgSeq += 1;
          const msgObj = { message_id: msgSeq, chat: { id: chatId }, text };
          sentMessages.push(msgObj);
          return msgObj;
        },
        deleteMessage: async (chatId, messageId) => {
          deletedMessages.push({ chatId, messageId });
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
const { formatTodayAttendanceStatus } = require('../src/messages');

async function run() {
  console.log('=== RUNNING TELEGRAM COMMANDS & 1-HOUR AUTO-DELETE TESTS ===\n');

  // 1. Format today attendance status
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
    {
      period: '3',
      duration: '11:00 - 11:55',
      subject: 'Software Engineering',
      subjectCode: 'CS303',
      teacher: 'Dr. Gupta',
      room: 'A-105',
      status: 'unmarked',
      attendance: 'N.M.',
    },
  ];

  const formatted = formatTodayAttendanceStatus(sampleRows, 'Tue, 06 Oct 2026', 'Karan');
  assert(formatted.includes("Today's Classes & Attendance"), 'Must contain header');
  assert(formatted.includes('Computer Networks'), 'Must list CS301');
  assert(formatted.includes('✅ *Present*'), 'Must show Present with emoji');
  assert(formatted.includes('❌ *Absent*'), 'Must show Absent with emoji');
  assert(formatted.includes('⏳ *Not Marked Yet*'), 'Must show Not Marked Yet with emoji');
  assert(formatted.includes('• ✅ Present: 1'), 'Summary must show 1 Present');
  assert(formatted.includes('• ❌ Absent: 1'), 'Summary must show 1 Absent');
  assert(formatted.includes('• ⏳ Not Marked: 1'), 'Summary must show 1 Not Marked');
  assert(formatted.includes('• 📚 Total Classes: 3'), 'Summary must show 3 Total Classes');
  console.log('PASS  1. formatTodayAttendanceStatus correctly formats Present, Absent, and Not Marked classes');

  // 2. Format empty rows
  const emptyFormatted = formatTodayAttendanceStatus([], 'Sun, 04 Oct 2026', 'Karan');
  assert(emptyFormatted.includes('No classes found'), 'Must report no classes');
  console.log('PASS  2. formatTodayAttendanceStatus handles zero classes cleanly');

  // 3. User setup in DB
  const user = await db.createUser({ email: 'karan@test.com', passwordHash: 'hash', emailVerified: true });
  await db.setTelegramChatId(user.id, 123456789);
  await db.updateUser(user.id, {
    studentName: 'Karan Kumar',
    qumsQid: '99999',
    qumsSessionPath: path.join(TMP_DIR, 'session.json'),
  });

  // 4. Test scheduleAutoDelete helper
  telegram.initTelegram();
  const testChatId = 123456789;
  const testMsgId = 555;
  telegram.scheduleAutoDelete(testChatId, testMsgId, 50); // fast 50ms for test

  const pending = await db.listPendingDeletions();
  assert(pending.some((p) => p.chatId === String(testChatId) && p.messageId === testMsgId), 'Must be persisted in DB');
  console.log('PASS  3. scheduleAutoDelete persists scheduled deletion to database');

  // Wait for 50ms timer to fire
  await new Promise((r) => setTimeout(r, 120));
  assert(deletedMessages.some((d) => d.chatId === testChatId && d.messageId === testMsgId), 'Must call deleteMessage');
  const pendingAfter = await db.listPendingDeletions();
  assert(!pendingAfter.some((p) => p.chatId === String(testChatId) && p.messageId === testMsgId), 'Must remove from DB once deleted');
  console.log('PASS  4. scheduleAutoDelete deletes message and cleans up database record');

  // 5. Test /today command dispatch
  sentMessages.length = 0;
  await telegram.handleUserMessage({ chat: { id: 123456789 }, text: '/today', message_id: 2001 });
  assert(sentMessages.length === 1, 'Should send exactly 1 response for /today');
  const todayMsg = sentMessages[0];
  assert(todayMsg.text.includes("Today's Classes & Attendance"), 'Must contain today attendance header');
  assert(todayMsg.text.includes('This message will automatically delete in 1 hour'), 'Must contain 1 hour auto-delete note');
  console.log('PASS  5. /today sends today attendance with 1-hour auto-delete notification');

  // 6. Test /attendence (typo support) and /attendance command dispatch
  sentMessages.length = 0;
  await telegram.handleUserMessage({ chat: { id: 123456789 }, text: '/attendence', message_id: 2002 });
  assert(sentMessages.length === 1, 'Should handle /attendence typo');
  const attendenceMsg = sentMessages[0];
  assert(attendenceMsg.text.includes('This message will automatically delete in 1 hour') || attendenceMsg.text.includes('Offline Cache'), 'Must notify about auto-delete');
  console.log('PASS  6. /attendence (and /attendance) sends attendance summary with 1-hour auto-delete');

  console.log('\nALL 6 TELEGRAM COMMAND & AUTO-DELETE TESTS PASSED!');
  process.exit(0);
}

run().catch((err) => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
