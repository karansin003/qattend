const assert = require('assert');

// Test the status resolution and normalization logic used for today's classes
console.log('🧪 Running today status badges tests...');

// 1. Status mapping verification
function resolveStatusAndAttendance(rawStatus, att) {
  let status = (rawStatus || '').toLowerCase();
  const a = String(att || '').trim();
  if (!status || status === 'other') {
    if (/present|^p$/i.test(a)) status = 'present';
    else if (/absent|^a$/i.test(a)) status = 'absent';
    else status = 'unmarked';
  }
  const attendance = (status === 'present')
    ? 'Present'
    : (status === 'absent')
      ? 'Absent'
      : (a && !/^(n\.?m\.?|-|not\s*marked)$/i.test(a) ? a : 'Not Marked');
  return { status, attendance };
}

// Check Present
{
  const r1 = resolveStatusAndAttendance('present', 'P');
  assert.strictEqual(r1.status, 'present');
  assert.strictEqual(r1.attendance, 'Present');

  const r2 = resolveStatusAndAttendance('', 'Present');
  assert.strictEqual(r2.status, 'present');
  assert.strictEqual(r2.attendance, 'Present');
}

// Check Absent
{
  const r1 = resolveStatusAndAttendance('absent', 'A');
  assert.strictEqual(r1.status, 'absent');
  assert.strictEqual(r1.attendance, 'Absent');

  const r2 = resolveStatusAndAttendance('', 'Absent');
  assert.strictEqual(r2.status, 'absent');
  assert.strictEqual(r2.attendance, 'Absent');
}

// Check Unmarked / Not Mentioned
{
  const r1 = resolveStatusAndAttendance('unmarked', 'N.M.');
  assert.strictEqual(r1.status, 'unmarked');
  assert.strictEqual(r1.attendance, 'Not Marked');

  const r2 = resolveStatusAndAttendance('', 'Not Marked');
  assert.strictEqual(r2.status, 'unmarked');
  assert.strictEqual(r2.attendance, 'Not Marked');

  const r3 = resolveStatusAndAttendance('', '-');
  assert.strictEqual(r3.status, 'unmarked');
  assert.strictEqual(r3.attendance, 'Not Marked');

  const r4 = resolveStatusAndAttendance('', '');
  assert.strictEqual(r4.status, 'unmarked');
  assert.strictEqual(r4.attendance, 'Not Marked');
}

// 2. New ERP matching algorithm test
function matchNewErpTimetableWithAttendance(todayRows, todayRecords) {
  const matchedIndices = new Set();
  const normalizeCode = (s) => String(s || '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
  const normalizeTitle = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();

  const periods = todayRows.map((r, i) => {
    const rowCode = normalizeCode(r.subjectCode || r.rawData?.subjectCode);
    const rowTitle = normalizeTitle(r.subjectName);
    const rowTime = String(r.periodTime || '').replace(/\s+/g, '');

    let match = null;

    if (rowCode) {
      const idx = todayRecords.findIndex((rec, idx) => {
        if (matchedIndices.has(idx)) return false;
        const recCode = normalizeCode(rec.subjectCode);
        return recCode && (recCode === rowCode || recCode.includes(rowCode) || rowCode.includes(recCode));
      });
      if (idx !== -1) {
        matchedIndices.add(idx);
        match = todayRecords[idx];
      }
    }

    if (!match && rowTitle) {
      const idx = todayRecords.findIndex((rec, idx) => {
        if (matchedIndices.has(idx)) return false;
        const recTitle = normalizeTitle(rec.subjectName || rec.subject);
        return recTitle && (recTitle === rowTitle || recTitle.includes(rowTitle) || rowTitle.includes(recTitle));
      });
      if (idx !== -1) {
        matchedIndices.add(idx);
        match = todayRecords[idx];
      }
    }

    if (!match && rowTime) {
      const idx = todayRecords.findIndex((rec, idx) => {
        if (matchedIndices.has(idx)) return false;
        const recTime = String(rec.time || rec.lectureTime || '').replace(/\s+/g, '');
        return recTime && (rowTime.includes(recTime) || recTime.includes(rowTime));
      });
      if (idx !== -1) {
        matchedIndices.add(idx);
        match = todayRecords[idx];
      }
    }

    let status = 'unmarked';
    let attendance = 'Not Marked';

    if (match) {
      const rawStatus = String(match.attendanceStatus || match.statusRaw || match.status || '').toLowerCase();
      if (rawStatus.includes('present') || rawStatus === 'p') {
        status = 'present';
        attendance = 'Present';
      } else if (rawStatus.includes('absent') || rawStatus === 'a') {
        status = 'absent';
        attendance = 'Absent';
      } else {
        status = 'unmarked';
        attendance = 'Not Marked';
      }
    }

    return {
      period: `P${i + 1}`,
      duration: r.periodTime || (match && (match.time || match.lectureTime)) || '',
      subject: r.subjectName || (match && (match.subjectName || match.subject)) || 'Class',
      subjectCode: r.subjectCode || (match && match.subjectCode) || '',
      employee: r.facultyName || (match && (match.facultyName || match.faculty)) || 'TBA',
      teacher: r.facultyName || (match && (match.facultyName || match.faculty)) || 'TBA',
      room: r.classroom || (match && match.room) || 'Classroom',
      status,
      attendance,
    };
  });

  return periods;
}

const sampleTimetable = [
  { subjectName: 'Design and Analysis of Algorithm', subjectCode: 'BCSE0001', periodTime: '09:00 - 09:55', classroom: 'A-004', facultyName: 'Dr. Sharma' },
  { subjectName: 'Scala for Data Science', subjectCode: 'BCSE0002', periodTime: '09:55 - 10:50', classroom: 'A-010', facultyName: 'Dr. Gupta' },
  { subjectName: 'Mini Project - III', subjectCode: 'BCSE0003', periodTime: '13:35 - 14:30', classroom: 'A-213', facultyName: 'Prof. Verma' },
];

const sampleAttendance = [
  { subjectName: 'Design and Analysis of Algorithm', subjectCode: 'BCSE0001', status: 'present', attendanceStatus: 'Present' },
  { subjectName: 'Scala for Data Science', subjectCode: 'BCSE0002', status: 'absent', attendanceStatus: 'Absent' },
  // Mini Project not marked yet
];

const result = matchNewErpTimetableWithAttendance(sampleTimetable, sampleAttendance);
assert.strictEqual(result.length, 3);
assert.strictEqual(result[0].status, 'present');
assert.strictEqual(result[0].attendance, 'Present');
assert.strictEqual(result[1].status, 'absent');
assert.strictEqual(result[1].attendance, 'Absent');
assert.strictEqual(result[2].status, 'unmarked');
assert.strictEqual(result[2].attendance, 'Not Marked');

// 3. Verify HTML badge generation logic
function renderBadge(p) {
  const status = String(p.status || '').toLowerCase();
  const att = String(p.attendance || '').toLowerCase();

  if (status === 'present' || att === 'present' || att === 'p') {
    return { class: 'badge-present', text: '✅ Present' };
  } else if (status === 'absent' || att === 'absent' || att === 'a') {
    return { class: 'badge-absent', text: '❌ Absent' };
  } else {
    return { class: 'badge-not-marked', text: '⏳ Not Marked' };
  }
}

assert.deepStrictEqual(renderBadge(result[0]), { class: 'badge-present', text: '✅ Present' });
assert.deepStrictEqual(renderBadge(result[1]), { class: 'badge-absent', text: '❌ Absent' });
assert.deepStrictEqual(renderBadge(result[2]), { class: 'badge-not-marked', text: '⏳ Not Marked' });

// 4. Verify Close Button elements in public/index.html & public/style.css
const fs = require('fs');
const path = require('path');
const htmlContent = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf-8');
const cssContent = fs.readFileSync(path.join(__dirname, '../public/style.css'), 'utf-8');

assert.ok(htmlContent.includes('id="todayCloseBtn"'), 'index.html must contain todayCloseBtn');
assert.ok(htmlContent.includes('class="today-box-header"'), 'index.html must contain today-box-header');
assert.ok(htmlContent.includes('btn-close-today'), 'index.html must contain btn-close-today');
assert.ok(htmlContent.includes("box.classList.add('hidden')"), 'index.html must contain box close handler');

assert.ok(cssContent.includes('.today-box-header'), 'style.css must define .today-box-header');
assert.ok(cssContent.includes('.btn-close-today'), 'style.css must define .btn-close-today');

console.log('✅ All today status badges and close button tests passed!');
