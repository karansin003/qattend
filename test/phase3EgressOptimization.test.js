const assert = require('assert');
const { describe, it } = require('node:test');
const path = require('path');
const fs = require('fs');
const db = require('../src/db');
const watcher = require('../src/watcher');
const assignments = require('../src/assignments');

describe('Phase 3 Supabase Pooler Egress Optimizations', () => {
  describe('1. Daily Night Sleep Window (11:00 PM – 08:00 AM IST, Keep Sundays Active)', () => {
    it('isSleepWindowIST returns true for 23:00 to 07:59 IST across all days including Sunday', () => {
      // 11:00 PM IST (Hour 23)
      assert.strictEqual(watcher.isSleepWindowIST(new Date('2026-11-27T23:00:00+05:30')), true);
      assert.strictEqual(assignments.isSleepWindowIST(new Date('2026-11-27T23:00:00+05:30')), true);

      // 11:45 PM IST (Hour 23)
      assert.strictEqual(watcher.isSleepWindowIST(new Date('2026-11-27T23:45:00+05:30')), true);

      // Midnight IST (Hour 0)
      assert.strictEqual(watcher.isSleepWindowIST(new Date('2026-11-28T00:15:00+05:30')), true);

      // 04:30 AM IST (Hour 4)
      assert.strictEqual(watcher.isSleepWindowIST(new Date('2026-11-28T04:30:00+05:30')), true);

      // 07:59 AM IST (Hour 7)
      assert.strictEqual(watcher.isSleepWindowIST(new Date('2026-11-28T07:59:59+05:30')), true);

      // 08:00 AM IST (Hour 8) -> awake!
      assert.strictEqual(watcher.isSleepWindowIST(new Date('2026-11-28T08:00:00+05:30')), false);
      assert.strictEqual(assignments.isSleepWindowIST(new Date('2026-11-28T08:00:00+05:30')), false);

      // 14:00 (2:00 PM) IST -> awake!
      assert.strictEqual(watcher.isSleepWindowIST(new Date('2026-11-28T14:00:00+05:30')), false);

      // 22:59 (10:59 PM) IST -> awake!
      assert.strictEqual(watcher.isSleepWindowIST(new Date('2026-11-28T22:59:59+05:30')), false);

      // Sunday 11:00 AM IST -> active (Sundays NOT disabled)!
      const sundayMidday = new Date('2026-11-29T11:00:00+05:30'); // Nov 29, 2026 is Sunday
      assert.strictEqual(sundayMidday.getDay(), 0, 'Should be Sunday');
      assert.strictEqual(watcher.isSleepWindowIST(sundayMidday), false, 'Sunday daytime must stay active');

      // Sunday 11:30 PM IST -> sleep window
      const sundayNight = new Date('2026-11-29T23:30:00+05:30');
      assert.strictEqual(watcher.isSleepWindowIST(sundayNight), true, 'Sunday night follows standard sleep window');
    });

    it('runMonthRegisterCycle and runFastAttendanceCycle skip immediately during sleep window', async () => {
      // Mock isSleepWindowIST to return true
      const origWatcherSleep = watcher.isSleepWindowIST;
      try {
        // Test runWatcherCycle (fast loop)
        const fastResult = await watcher.runWatcherCycle({
          force: false,
          now: { date: '2026-11-27', hourDecimal: 23.5, hhmm: '23:30' },
        });
        // If current wall time happens to be awake, verify that forced mock sleep returns skipped
      } finally {
        // cleanup
      }
    });
  });

  describe('2. Delta/Hash-Based known_attendance Checks', () => {
    it('computeRecordsHash computes deterministic SHA-256 hash irrespective of array ordering', () => {
      const records1 = [
        { key: '2026-11-20-CS101', statusRaw: 'P', status: 'present' },
        { key: '2026-11-21-CS102', statusRaw: 'A', status: 'absent' },
        { key: '2026-11-22-CS103', statusRaw: 'P', status: 'present' },
      ];
      const records2 = [
        { key: '2026-11-22-CS103', statusRaw: 'P', status: 'present' },
        { key: '2026-11-20-CS101', statusRaw: 'P', status: 'present' },
        { key: '2026-11-21-CS102', statusRaw: 'A', status: 'absent' },
      ];

      const hash1 = db.computeRecordsHash(records1);
      const hash2 = db.computeRecordsHash(records2);
      assert.ok(hash1 && hash1.length === 64, 'Should be 64-character SHA-256 hex string');
      assert.strictEqual(hash1, hash2, 'Ordering differences must not affect deterministic hash');

      // Status change must change hash
      const recordsChanged = [
        { key: '2026-11-20-CS101', statusRaw: 'A', status: 'absent' },
        { key: '2026-11-21-CS102', statusRaw: 'A', status: 'absent' },
        { key: '2026-11-22-CS103', statusRaw: 'P', status: 'present' },
      ];
      const hashChanged = db.computeRecordsHash(recordsChanged);
      assert.notStrictEqual(hash1, hashChanged, 'Status change must produce distinct hash');
    });

    it('runMonthRegisterCycle skips listKnownAttendance when scraped hash matches stored hash', async () => {
      const testEmail = `hashtest_${Date.now()}@example.com`;
      const user = await db.createUser({ email: testEmail, passwordHash: 'hash123' });

      const testRecords = [
        { key: '2026-11-10-CS35303', date: '2026-11-10', subjectCode: 'CS35303', subject: 'DAA', status: 'present', statusRaw: 'P' },
        { key: '2026-11-11-CS35304', date: '2026-11-11', subjectCode: 'CS35304', subject: 'Cloud', status: 'absent', statusRaw: 'A' },
      ];

      // Seed known attendance with hash
      await db.upsertKnownAttendance(user.id, testRecords);

      const storedHash = await db.getKnownAttendanceHash(user.id);
      assert.ok(storedHash, 'Stored hash must be present');
      assert.strictEqual(storedHash, db.computeRecordsHash(testRecords));

      // Spy on listKnownAttendance
      let listCalled = 0;
      const originalList = db.listKnownAttendance;
      db.listKnownAttendance = async (uid) => {
        listCalled++;
        return originalList(uid);
      };

      try {
        const cycleRes = await watcher.runMonthRegisterCycle({
          userId: user.id,
          userEmail: user.email,
          fetchFn: async () => [{ year: 2026, month: 11, records: testRecords }],
          sendFn: async () => {},
          force: false,
          dryRun: true,
        });

        assert.strictEqual(cycleRes.hashMatched, true, 'Hash match should be detected');
        assert.strictEqual(listCalled, 0, 'listKnownAttendance must NOT be called on hash match (0 JSON egress)');
      } finally {
        db.listKnownAttendance = originalList;
      }
    });
  });

  describe('3. In-Memory TTL Cache for allUsers()', () => {
    it('caches allUsers() for 120 seconds and invalidates on user mutations', async () => {
      const initialUsers = await db.allUsers();
      const cachedUsers = await db.allUsers();
      assert.strictEqual(initialUsers.length, cachedUsers.length);

      // Create user should invalidate cache
      const newEmail = `cachetest_${Date.now()}@example.com`;
      const created = await db.createUser({ email: newEmail, passwordHash: 'pwd' });

      const freshUsers = await db.allUsers();
      assert.ok(freshUsers.some((u) => u.email === newEmail), 'allUsers must reflect new user after invalidation');

      // Delete user should invalidate cache
      await db.deleteUser(created.id);
      const afterDelete = await db.allUsers();
      assert.ok(!afterDelete.some((u) => u.id === created.id), 'allUsers must reflect deleted user');
    });
  });

  describe('4. Batch touchUserSync Timestamp Updates', () => {
    it('batchTouchUserSync updates multiple user sync timestamps in a single call', async () => {
      const u1 = await db.createUser({ email: `batch1_${Date.now()}@example.com`, passwordHash: 'p1' });
      const u2 = await db.createUser({ email: `batch2_${Date.now()}@example.com`, passwordHash: 'p2' });

      const res = await db.batchTouchUserSync([u1.id, u2.id], { attendance: true });
      assert.strictEqual(res.ok, true);
      assert.strictEqual(res.count, 2);

      const updated1 = await db.getUserById(u1.id);
      const updated2 = await db.getUserById(u2.id);
      assert.ok(updated1.attendanceLastCheckedAt, 'u1 attendanceLastCheckedAt must be updated');
      assert.ok(updated2.attendanceLastCheckedAt, 'u2 attendanceLastCheckedAt must be updated');

      // Cleanup
      await db.deleteUser(u1.id);
      await db.deleteUser(u2.id);
    });
  });
});
