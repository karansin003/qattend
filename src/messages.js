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

const QUMS_STANDARD_PERIOD_DURATIONS = {
  P1: '09:00 - 09:55',
  P2: '09:55 - 10:50',
  P3: '10:50 - 11:45',
  P4: '11:45 - 12:40',
  P5: '12:40 - 13:35',
  P6: '13:35 - 14:30',
  P7: '14:30 - 15:25',
  P8: '15:25 - 16:20',
};

function resolveDuration(duration, period) {
  if (duration && String(duration).trim()) return norm(duration);
  const fromPeriod = (period || '').match(/\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}/);
  if (fromPeriod) return norm(fromPeriod[0]);
  const cp = (period || '').match(/\b(P\d+|\d+)\b/i);
  if (cp) {
    const key = cp[1].toUpperCase().startsWith('P') ? cp[1].toUpperCase() : `P${cp[1]}`;
    if (QUMS_STANDARD_PERIOD_DURATIONS[key]) return QUMS_STANDARD_PERIOD_DURATIONS[key];
  }
  return '';
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
      const dur = resolveDuration(r.duration, r.period);
      const timeLabel = dur || r.period;
      lines.push(`${i + 1}. 🕐 *${timeLabel}* — ${r.subject}${r.subjectCode ? ` (${r.subjectCode})` : ''}`);
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
      const dur = resolveDuration(r.duration, r.period);
      lines.push(`${i + 1}. *${r.period}* (${dur || r.duration || 'TBA'})`);
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

/**
 * Today's attendance report: breakdown of all classes today with
 * Present / Absent / Not Marked status, room, and teacher.
 */
function formatTodayAttendanceStatus(rows, dateLabel = dateLabelIST(), studentName = '') {
  const list = (rows || []).filter((r) => r.period || r.subject);
  const hi = studentName ? `Hi ${studentName}! ` : '';
  const lines = [`📅 *Today's Classes & Attendance* — ${dateLabel}`, ''];

  if (!list.length) {
    lines.push(`🎉 ${hi}No classes found for today or Sunday/Holiday. Enjoy your day!`);
    return lines.join('\n');
  }

  if (studentName) {
    lines.push(`${hi}Here is your period-wise attendance for today:`, '');
  } else {
    lines.push('Here is your period-wise attendance for today:', '');
  }

  let presentCount = 0;
  let absentCount = 0;
  let unmarkedCount = 0;
  let otherCount = 0;

  list.forEach((r, i) => {
    const dur = resolveDuration(r.duration, r.period);
    const periodLabel = dur ? `🕐 *${dur}* (Period ${r.period})` : `🕐 *Period ${r.period}*`;
    lines.push(`${i + 1}. ${periodLabel}`);
    lines.push(`   📚 *${r.subject || 'Class'}*${r.subjectCode ? ` (${r.subjectCode})` : ''}`);

    let statusText = '⏳ *Not Marked Yet*';
    if (r.status === 'present') {
      statusText = '✅ *Present*';
      presentCount++;
    } else if (r.status === 'absent') {
      statusText = '❌ *Absent*';
      absentCount++;
    } else if (r.status === 'unmarked' || !r.status) {
      statusText = '⏳ *Not Marked Yet*';
      unmarkedCount++;
    } else {
      statusText = `ℹ️ *${norm(r.attendance) || 'Marked'}*`;
      otherCount++;
    }
    lines.push(`   Status: ${statusText}`);

    const details = [];
    if (r.room) details.push(`📍 Room: ${r.room}`);
    const teacher = r.teacher || r.employee;
    if (teacher) details.push(`👨‍🏫 ${teacher}`);
    if (details.length) {
      lines.push(`   ${details.join(' • ')}`);
    }
    lines.push('');
  });

  lines.push('📊 *Today\'s Summary:*');
  lines.push(`• ✅ Present: ${presentCount}`);
  lines.push(`• ❌ Absent: ${absentCount}`);
  if (unmarkedCount > 0) {
    lines.push(`• ⏳ Not Marked: ${unmarkedCount}`);
  }
  if (otherCount > 0) {
    lines.push(`• ℹ️ Other: ${otherCount}`);
  }
  lines.push(`• 📚 Total Classes: ${list.length}`);

  return lines.join('\n');
}

module.exports = { dateLabelIST, dateLabelFromYMD, fullDateLabelFromYMD, statusEmoji, formatAttendanceUpdate, formatBackdatedUpdate, formatMorningSchedule, formatAttendanceMessage, formatTodayAttendanceStatus, formatNewAssignment, formatAssignmentDeadlineReminder, QUMS_ASSIGNMENT_URL, norm };

