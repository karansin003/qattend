/**
 * Shared message builders (watcher + scheduler use these; Telegram pe jaate hain).
 */
const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();

/** 'Thu, 11 Sep 2026' in IST */
function dateLabelIST(d = new Date()) {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(d);
}

function statusEmoji(status, raw) {
  if (status === 'present') return '✅ Present';
  if (status === 'absent') return '❌ Absent';
  return `ℹ️ ${norm(raw) || 'Marked'}`;
}

/**
 * Per-class alert — spec: teacher name + marked you as present/absent +
 * subject + date (kis din ka). Room timetable enrichment se aata hai (optional).
 */
function formatAttendanceUpdate(row, dateLabel = dateLabelIST()) {
  const lines = [
    `📌 *Attendance Update* — ${dateLabel}`,
    `Teacher: ${row.employee || '—'}`,
    `Subject: ${row.subject} (${row.subjectCode})`,
    `Period: ${row.period} (${row.duration})`,
  ];
  if (row.room) lines.push(`Room: ${row.room}`);
  lines.push(`${row.employee || 'Teacher'} marked you as: ${statusEmoji(row.status, row.attendance)}`);
  return lines.join('\n');
}

/**
 * Morning schedule (daily 8:30 AM IST): all of today's classes + time + room + teacher.
 */
function formatMorningSchedule(rows, dateLabel = dateLabelIST(), studentName = '') {
  const list = (rows || []).filter((r) => r.period || r.subject);
  const hi = studentName ? `Hi ${studentName}! ` : '';
  const lines = [`🌅 *Today's Classes* — ${dateLabel}`, ''];
  if (!list.length) {
    lines.push(`🎉 ${hi}No classes are scheduled today. Enjoy your day!`);
  } else if (list.some((r) => 'room' in r)) {
    // Timetable mode — period time + ROOM + teacher available hai
    if (studentName) lines.push(`${hi}Here is your schedule for today:`, '');
    list.forEach((r, i) => {
      lines.push(`${i + 1}. 🕐 *${r.duration || r.period}* — ${r.subject}${r.subjectCode ? ` (${r.subjectCode})` : ''}`);
      const extras = [];
      if (r.room) extras.push(`Room: ${r.room}`);
      if (r.teacher) extras.push(r.teacher);
      if (extras.length) lines.push(`    ${extras.join(' • ')}`);
    });
    lines.push('');
    lines.push('_You will get an attendance update as soon as marks are entered 📲_');
  } else {
    // Attendance-rows mode (fallback — isme room nahi hota)
    if (studentName) lines.push(`${hi}Here is your schedule for today:`, '');
    list.forEach((r, i) => {
      lines.push(`${i + 1}. *${r.period}* (${r.duration})`);
      lines.push(`    ${r.subject} (${r.subjectCode}) — ${r.employee || 'TBA'}`);
    });
    lines.push('');
    lines.push('_You will get an attendance update as soon as marks are entered 📲_');
  }
  return lines.join('\n');
}

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 'YYYY-MM-DD' -> '12 Sep 2026' (civil date — TZ-independent label). */
function dateLabelFromYMD(ymd) {
  const m = String(ymd || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return String(ymd || '');
  return `${m[3]} ${MONTHS_SHORT[Number(m[2]) - 1] || '?'} ${m[1]}`;
}

/**
 * Backdated month-register alert — English only, real class date, per-lecture
 * detail when the portal cell holds 2+ lectures.
 *
 * NEW record (nothing stored before):
 *   📌 Attendance Update
 *
 *   Subject: Java
 *   Code: CS35303
 *   Class Date: 22 September 2026
 *   Status: ✅ Present
 *
 * EXISTING record whose status changed:
 *   📌 Attendance Updated
 *
 *   Subject: Java
 *   Code: CS35303
 *   Class Date: 22 September 2026
 *   Previous Status: ❌ Absent
 *   Current Status: ✅ Present
 *
 * `Teacher:` is added ONLY when a real teacher value was cross-matched from the
 * user's own timetable — never invented.
 */
function formatBackdatedUpdate(rec, prev = null) {
  const changed = Boolean(prev);
  const code = rec.subjectCode || '';
  const lines = [changed ? '📌 *Attendance Updated*' : '📌 *Attendance Update*', ''];
  lines.push(`Subject: ${rec.subject || code}`);
  if (code) lines.push(`Code: ${code}`);
  lines.push(`Class Date: ${fullDateLabelFromYMD(rec.date)}`);

  const multi = (rec.lectures || []).length > 1;
  if (changed) {
    if (multi) {
      const prevLectures = prev.lectures || [];
      const label = (l, i) => `L${i + 1} ${statusEmoji(l.status, l.statusRaw)}`;
      lines.push(`Previous Status: ${prevLectures.length ? prevLectures.map(label).join(' | ') : statusEmoji(prev.status, prev.statusRaw)}`);
      lines.push(`Current Status: ${rec.lectures.map(label).join(' | ')}`);
    } else {
      lines.push(`Previous Status: ${statusEmoji(prev.status, prev.statusRaw)}`);
      lines.push(`Current Status: ${statusEmoji(rec.status, rec.statusRaw)}`);
    }
  } else if (multi) {
    lines.push(`Status: ${rec.lectures.map((l, i) => `L${i + 1} ${statusEmoji(l.status, l.statusRaw)}`).join(' | ')}`);
  } else {
    lines.push(`Status: ${statusEmoji(rec.status, rec.statusRaw)}`);
  }

  if (rec.teacher) lines.push(`Teacher: ${rec.teacher}`);
  lines.push('');
  lines.push('QUMS attendance was updated for a previous class.');
  return lines.join('\n');
}

/** 'YYYY-MM-DD' -> '22 September 2026' (full month name — spec format). */
function fullDateLabelFromYMD(ymd) {
  const m = String(ymd || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return String(ymd || '');
  const MONTHS_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return `${Number(m[3])} ${MONTHS_FULL[Number(m[2]) - 1] || '?'} ${m[1]}`;
}

/**
 * Attendance summary message (on-demand; the daily 9 PM cron was removed —
 * this builder stays for the manual summary trigger).
 */
function formatAttendanceMessage(analysis) {
  const lines = [];
  lines.push('*\u{1F4CA} QUMS Attendance Report*');
  const stamp = new Date(analysis.generatedAt).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  lines.push(`_${stamp} (IST)_`);
  lines.push('');
  for (const s of analysis.subjects) {
    const emoji = s.status === 'below-75' ? '\u26A0\uFE0F' : '\u2705';
    lines.push(`${emoji} *${s.subject}*${s.subjectCode ? ` (${s.subjectCode})` : ''}: ${s.percentage}%`);
    lines.push(`     ${s.guidance}`);
  }
  lines.push('');
  lines.push(
    `Subjects: ${analysis.summary.totalSubjects} | Below 75%: ${analysis.summary.below75} | Status: ${analysis.summary.overallStatus}`
  );
  if (analysis.demoData) {
    lines.push('_(DEMO data — live scrape nahi hua)_');
  }
  lines.push('_Auto-sent by QUMS Attendance Bot \u{1F916}_');
  return lines.join('\n');
}

// ---- Assignment notifications (Parts 5/6/7) ----

const QUMS_ASSIGNMENT_URL =
  'https://qums.quantumuniversity.edu.in/Web_StudentAcademic/Cyborg_StudentAssignment?id=Assignment';

/**
 * 📚 New Assignment
 *
 * Subject: Java
 * Assignment: OOP Assignment
 * Last Date: 25 September 2026
 *
 * 🔗 Open QUMS: <url>
 */
function formatNewAssignment(a) {
  const lines = [
    '📚 *New Assignment*',
    '',
    `Subject: ${a.subject || '—'}`,
    `Assignment: ${a.title || '—'}`,
  ];
  if (a.deadlineYMD) lines.push(`Last Date: ${fullDateLabelFromYMD(a.deadlineYMD)}`);
  if (a.teacher) lines.push(`Faculty: ${a.teacher}`);
  lines.push('');
  lines.push(`🔗 Open QUMS: ${QUMS_ASSIGNMENT_URL}`);
  return lines.join('\n');
}

/**
 * ⚠️ Assignment Deadline Reminder
 *
 * Subject: Java
 * Assignment: OOP Assignment
 *
 * Today is the last date to submit this assignment.
 * Please submit it before the deadline.
 *
 * 🔗 Open QUMS
 */
function formatAssignmentDeadlineReminder(a) {
  return [
    '⚠️ *Assignment Deadline Reminder*',
    '',
    `Subject: ${a.subject || '—'}`,
    `Assignment: ${a.title || '—'}`,
    '',
    'Today is the last date to submit this assignment.',
    'Please submit it before the deadline.',
    '',
    `🔗 Open QUMS: ${QUMS_ASSIGNMENT_URL}`,
  ].join('\n');
}

module.exports = { dateLabelIST, dateLabelFromYMD, fullDateLabelFromYMD, statusEmoji, formatAttendanceUpdate, formatBackdatedUpdate, formatMorningSchedule, formatAttendanceMessage, formatNewAssignment, formatAssignmentDeadlineReminder, QUMS_ASSIGNMENT_URL, norm };

