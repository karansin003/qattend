/**
 * Quantum University New ERP Client & Scraper
 * Official portal: https://my.quantumuniversity.edu.in/
 * Academic URL: https://my.quantumuniversity.edu.in/Student/Academic
 * Attendance URL: https://my.quantumuniversity.edu.in/Student/Academic/StudentAttendance
 *
 * Requirements:
 *  - Email + Password login (NO CAPTCHA)
 *  - Separate authentication & session management
 *  - Auto-detect student info (Name, QID, Year, Semester, Course)
 *  - Never use a globally fixed semester variable
 *  - Timetable (Daily, Weekly, Subject, Faculty, Time, Classroom, Date/Day)
 *  - Attendance (Overall, Subject-wise, Subject Details, Date Range, Horizontal Slider)
 *  - Calculation rules: Not Marked is NEVER counted as Absent, original lecture dates preserved
 *  - Session invalidation & reconnect detection
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const NEW_ERP_BASE_URL = (process.env.NEW_ERP_BASE_URL || 'https://my.quantumuniversity.edu.in').replace(/\/+$/, '');
const LOGIN_URL = `${NEW_ERP_BASE_URL}/`;
const ACADEMIC_URL = `${NEW_ERP_BASE_URL}/Student/Academic`;
const ATTENDANCE_URL = `${NEW_ERP_BASE_URL}/Student/Academic/StudentAttendance`;
const ASSESSMENTS_URL = `${NEW_ERP_BASE_URL}/Student/Student/Assessments`;
const ASSIGNMENTS_URL = `${NEW_ERP_BASE_URL}/Student/Student/Assignments`;
const LOGOUT_ALL_URL = `${NEW_ERP_BASE_URL}/Login/LogoutAllSessions`;

const SHARED_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

class NewErpAuthError extends Error {
  constructor(message = 'Invalid email or password on New ERP.') {
    super(message);
    this.name = 'NewErpAuthError';
    this.code = 'NEW_ERP_AUTH_FAILED';
  }
}

class NewErpSessionExpiredError extends Error {
  constructor(message = 'Your New ERP session has expired.') {
    super(message);
    this.name = 'NewErpSessionExpiredError';
    this.code = 'NEW_ERP_SESSION_EXPIRED';
    this.hint = 'Please reconnect your New ERP account to continue live synchronization.';
  }
}

class NewErpSessionConflictError extends Error {
  constructor(message = 'Your account has been logged in on another device or session.') {
    super(message);
    this.name = 'NewErpSessionConflictError';
    this.code = 'NEW_ERP_SESSION_CONFLICT';
  }
}

class NewErpPortalError extends Error {
  constructor(message, hint) {
    super(message);
    this.name = 'NewErpPortalError';
    this.hint = hint || null;
  }
}

/** Helper to clean and normalize text */
function cleanText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

/**
 * Extract anti-forgery token and cookies using fast native HTTP
 */
async function fetchLoginPageData() {
  const url = LOGIN_URL;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
  });
  const html = await res.text();
  const rawCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')].filter(Boolean);
  const cookieHeader = rawCookies.map((c) => c.split(';')[0]).join('; ');

  const tokenMatch = html.match(/name="__RequestVerificationToken"[^>]*value="([^"]+)"/i);
  const token = tokenMatch ? tokenMatch[1] : '';

  return { html, cookieHeader, token, cookies: rawCookies };
}

/**
 * Pure HTML parser for New ERP student profile & academic details
 */
function parseNewErpProfile(html) {
  if (!html || typeof html !== 'string') return {};
  const data = {
    studentName: '',
    qid: '',
    email: '',
    academicYear: '',
    semester: '',
    course: '',
  };

  // Strip scripts and styles so CSS rules don't pollute text matching
  const cleanHtml = html.replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<script[\s\S]*?<\/script>/gi, ' ');

  // 1. Sidebar profile link check (official portal: /Student/StudentProfile/StudentProfileNew)
  const profileLinkMatch = cleanHtml.match(/href=["'][^"']*StudentProfileNew[^"']*["'][^>]*>([\s\S]*?)<\/a>/i);
  if (profileLinkMatch) {
    const rawName = cleanText(profileLinkMatch[1].replace(/<[^>]+>/g, ''));
    if (rawName && rawName.length > 2) data.studentName = rawName;
  }

  // Name patterns fallback
  if (!data.studentName) {
    const nameMatch =
      cleanHtml.match(/class=["'][^"']*(?:user-name|student-name|profile-name|user_name)[^"']*["'][^>]*>([\s\S]*?)<\//i) ||
      cleanHtml.match(/Hello[,\s]+([A-Za-z\s]+)[\s<]/i) ||
      cleanHtml.match(/Welcome[,\s]+([A-Za-z\s]+)[\s<]/i) ||
      cleanHtml.match(/id=["']txtStuName["'][^>]*value=["']([^"']+)["']/i);
    if (nameMatch) {
      data.studentName = cleanText(nameMatch[1].replace(/<[^>]+>/g, ''));
    }
  }

  // QID / Roll No
  const qidMatch =
    cleanHtml.match(/Student ID:\s*([A-Za-z0-9]+)/i) ||
    cleanHtml.match(/(?:QID|Enrollment No|Roll No)[\s:]*([A-Za-z0-9]+)/i) ||
    cleanHtml.match(/data-qid=["']([^"']+)["']/i) ||
    cleanHtml.match(/class=["'][^"']*qid[^"']*["'][^>]*>([\s\S]*?)<\//i);
  if (qidMatch) {
    data.qid = cleanText(qidMatch[1].replace(/<[^>]+>/g, ''));
  }

  // Course / Degree from sidebar (follows Student ID: <p class="mb-0">Degree</p>)
  const degreeMatch = cleanHtml.match(/Student ID:\s*[0-9]+[\s\S]*?<p class=["']mb-0["']>([^<]+)<\/p>/i);
  if (degreeMatch) {
    data.course = cleanText(degreeMatch[1]);
  } else {
    const courseMatch =
      cleanHtml.match(/(?:Course|Program|Branch)[\s:]*([^<>\n\r\t]+?)(?:<|\n|\r|\t|$)/i) ||
      cleanHtml.match(/data-course=["']([^"']+)["']/i);
    if (courseMatch) {
      data.course = cleanText(courseMatch[1].replace(/<[^>]+>/g, ''));
    }
  }

  // Academic Year / Session
  const yearMatch =
    cleanHtml.match(/<strong>\s*([0-9]{4}\s*-\s*[0-9]{4})/i) ||
    cleanHtml.match(/(?:Academic Year|Session)[\s:]*([0-9]{4}\s*-\s*[0-9]{2,4})/i) ||
    cleanHtml.match(/data-academic-year=["']([^"']+)["']/i);
  if (yearMatch) {
    data.academicYear = cleanText(yearMatch[1]);
  }

  // Semester
  const semMatch =
    cleanHtml.match(/Semester[\s:]*(\d+|[IVXLCDM]+)/i) ||
    cleanHtml.match(/Sem[\s:]*(\d+|[IVXLCDM]+)/i) ||
    cleanHtml.match(/data-semester=["']([^"']+)["']/i);
  if (semMatch) {
    data.semester = cleanText(semMatch[1]);
  }

  return data;
}

/**
 * Pure HTML parser for New ERP Timetable (/Student/Academic)
 */
function parseNewErpTimetable(html) {
  if (!html || typeof html !== 'string') return { hasData: false, days: [], rows: [], todayClasses: [] };

  const days = [];
  const allRows = [];
  const dayNames = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

  // 1. Primary: Modern week calendar DOM (<header class="bg-blue-800 ..."> and <section class="bl-primary ...">)
  if (html.includes('bg-blue-800') || html.includes('bl-primary')) {
    const articles = html.split('<header class="bg-blue-800 text-white').slice(1);
    for (const art of articles) {
      const headerMatch = art.match(/>\s*([0-9-]+\s*\(([A-Za-z]+)\))\s*<\/header>/i);
      const fullDay = headerMatch ? headerMatch[1].trim() : '';
      const dayName = headerMatch ? headerMatch[2].trim() : '';
      const dowIndex = dayNames.indexOf(dayName);
      const dayOfWeek = dowIndex >= 0 ? dowIndex + 1 : 1;

      const dayPeriods = [];
      const sections = art.split('<section class="w-100 bl-primary').slice(1);
      for (const sec of sections) {
        const subMatch = sec.match(/<p class=["'][^"']*color-blue-800["']>([^<]+)<\/p>/i);
        const subjectName = subMatch ? cleanText(subMatch[1]) : '';

        const codeMatch = sec.match(/<span class=["'][^"']*pe-2 border-end[^"']*["']>([^<]+)<\/span>/i);
        const subjectCode = codeMatch ? cleanText(codeMatch[1]) : '';

        const pTags = [...sec.matchAll(/<p class=["'][^"']*mb-1["']>[\s\S]*?<span>([^<]+)<\/span>/gi)].map((m) =>
          cleanText(m[1])
        );
        let periodTime = '';
        let facultyName = '';
        let classroom = '';

        for (const p of pTags) {
          if (/AM|PM|\d{1,2}:\d{2}/i.test(p)) {
            periodTime = p;
          } else if (/Room|Building|Hall|Lab|Ground|Floor/i.test(p)) {
            classroom = p;
          } else if (!facultyName && /[A-Za-z]/.test(p)) {
            facultyName = p;
          }
        }

        const periodItem = {
          day: dayName || 'General',
          fullDay,
          dayOfWeek,
          periodTime: periodTime || 'N/A',
          subjectName: subjectName || 'Class',
          subjectCode: subjectCode || '',
          facultyName: facultyName || 'TBA',
          classroom: classroom || 'Classroom',
          // Compatibility with Old ERP schedule items
          period: periodTime || `P${dayPeriods.length + 1}`,
          duration: periodTime || 'N/A',
          subject: subjectName || 'Class',
          employee: facultyName || 'TBA',
          room: classroom || 'Classroom',
        };

        dayPeriods.push(periodItem);
        allRows.push(periodItem);
      }

      if (dayName || fullDay) {
        let dGroup = days.find((d) => d.day === (dayName || fullDay));
        if (!dGroup) {
          dGroup = { day: dayName || fullDay, fullDay, dayOfWeek, periods: [] };
          days.push(dGroup);
        }
        dGroup.periods.push(...dayPeriods);
      }
    }
  }

  // 2. Table row search fallback (if modern layout not found)
  if (allRows.length === 0) {
    const tableRowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let match;
    let currentDay = '';

    while ((match = tableRowRegex.exec(html)) !== null) {
      const rowHtml = match[1];
      if (rowHtml.includes('<th') && !rowHtml.includes('<td')) {
        // Check if header specifies a day
        for (const d of dayNames) {
          if (new RegExp(`\\b${d}\\b`, 'i').test(rowHtml)) {
            currentDay = d;
            break;
          }
        }
        continue;
      }

      const cells = [...rowHtml.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((c) =>
        cleanText(c[1].replace(/<[^>]+>/g, ''))
      );

      if (cells.length >= 3) {
        // Heuristic cell detection
        // Day, Time, Subject, Faculty, Classroom
        let day = currentDay;
        let time = '';
        let subject = '';
        let faculty = '';
        let room = '';

        for (const c of cells) {
          let isDay = false;
          for (const d of dayNames) {
            if (c.toLowerCase() === d.toLowerCase()) {
              day = d;
              isDay = true;
              break;
            }
          }
          if (isDay) continue;

          if (/\d{1,2}[:.]\d{2}\s*(?:AM|PM)?\s*[-–to]\s*\d{1,2}[:.]\d{2}\s*(?:AM|PM)?/i.test(c)) {
            time = c;
          } else if (/\b(?:Room|Lab|LH|LT|Hall|Block)\b/i.test(c) || (/^[A-Z0-9\-]{2,6}$/.test(c) && !room)) {
            room = c;
          } else if (/\b(?:Dr\.|Prof\.|Mr\.|Ms\.|Mrs\.)\b/i.test(c) && !faculty) {
            faculty = c;
          } else if (c.length > 3 && !subject) {
            subject = c;
          } else if (c.length > 3 && !faculty && subject) {
            faculty = c;
          }
        }

        if (!subject && cells[1]) subject = cells[1];
        if (!time && cells[0]) time = cells[0];

        if (subject) {
          const item = {
            day: day || 'General',
            dayOfWeek: dayNames.indexOf(day) >= 0 ? dayNames.indexOf(day) + 1 : 1,
            periodTime: time || 'N/A',
            subjectName: subject,
            facultyName: faculty || '',
            classroom: room || '',
            period: time || `P${allRows.length + 1}`,
            duration: time || 'N/A',
            subject,
            employee: faculty || '',
            room: room || '',
          };
          allRows.push(item);

          let dGroup = days.find((d) => d.day === item.day);
          if (!dGroup) {
            dGroup = { day: item.day, periods: [] };
            days.push(dGroup);
          }
          dGroup.periods.push({
            period: `P${dGroup.periods.length + 1}`,
            time: item.periodTime,
            subject: item.subjectName,
            faculty: item.facultyName,
            classroom: item.classroom,
          });
        }
      }
    }

    // Also check JSON payloads or data attributes embedded in scripts
    const scriptDataMatch = html.match(/(?:var|let|const)\s+(?:timetableData|timeTable|academicSchedule)\s*=\s*(\[\{[\s\S]*?\}\]);/i);
    if (scriptDataMatch) {
      try {
        const parsedJson = JSON.parse(scriptDataMatch[1]);
        if (Array.isArray(parsedJson) && parsedJson.length > 0) {
          for (const item of parsedJson) {
            allRows.push({
              day: item.day || item.Day || 'General',
              dayOfWeek: Number(item.dayOfWeek || item.DayOfWeek || 1),
              periodTime: item.time || item.Time || item.periodTime || '',
              subjectName: item.subject || item.Subject || item.subjectName || '',
              facultyName: item.faculty || item.Faculty || item.teacher || '',
              classroom: item.room || item.Room || item.classroom || '',
              period: item.time || item.Time || item.periodTime || '',
              duration: item.time || item.Time || item.periodTime || '',
              subject: item.subject || item.Subject || item.subjectName || '',
              employee: item.faculty || item.Faculty || item.teacher || '',
              room: item.room || item.Room || item.classroom || '',
            });
          }
        }
      } catch {}
    }
  }

  let istDayName = '';
  try {
    istDayName = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', weekday: 'long' }).format(new Date());
  } catch {
    istDayName = dayNames[new Date().getDay() === 0 ? 6 : new Date().getDay() - 1];
  }
  const dowIndex = dayNames.indexOf(istDayName);
  const istDow = dowIndex >= 0 ? dowIndex + 1 : 1;
  const todayClasses = allRows.filter((r) => r.day.toLowerCase() === istDayName.toLowerCase() || r.dayOfWeek === istDow);

  return {
    hasData: allRows.length > 0,
    days,
    rows: allRows,
    todayClasses,
  };
}

/**
 * Pure HTML parser for New ERP Attendance (/Student/Academic/StudentAttendance)
 *
 * Enforces mandatory calculation rules:
 *  - Not Marked is NEVER counted as Absent
 *  - Missing records never counted as Absent
 *  - Calculate subject-wise attendance independently
 *  - Calculate overall attendance using actual attendance records
 *  - Do not replace semester attendance with date-filtered attendance
 *  - Original lecture dates preserved
 */
function parseNewErpAttendance(html, extraLecturesHtml = '') {
  if (!html || typeof html !== 'string') {
    return {
      summary: { totalConducted: 0, totalAttended: 0, totalAbsent: 0, overallPercentage: 0 },
      subjectWise: [],
      dailyRecords: [],
      subjects: [],
    };
  }

  const subjectWise = [];
  const dailyRecords = [];

  // Parse overall summary metrics from official portal cards (.lectNum, .TPNum, .TANum)
  let totalConducted = 0;
  let totalAttended = 0;
  let totalAbsent = 0;
  let overallPercentage = 0;

  const condMatch = html.match(/class=["'][^"']*lectNum[^"']*["']>(\d+)<\/span>/i);
  if (condMatch) totalConducted = Number(condMatch[1]) || 0;

  const presMatch = html.match(/class=["'][^"']*TPNum[^"']*["']>(\d+)<\/span>/i);
  if (presMatch) totalAttended = Number(presMatch[1]) || 0;

  const absMatch = html.match(/class=["'][^"']*TANum[^"']*["']>(\d+)<\/span>/i);
  if (absMatch) totalAbsent = Number(absMatch[1]) || 0;

  const pctMatchModern =
    html.match(/item_value[^>]*>[\s\S]*?<span>\s*([0-9.]+)%\s*<\/span>/i) ||
    html.match(/data-progress=["']([0-9.]+)["']/i);
  if (pctMatchModern) overallPercentage = parseFloat(pctMatchModern[1]) || 0;

  // Fallbacks for older or alternative portal skins
  if (totalConducted === 0) {
    const totalClassesMatch =
      html.match(/(?:Total Classes Conducted|Total Conducted|Total Lectures)[\s:]*([0-9]+)/i) ||
      html.match(/(?:Total Classes Conducted|Total Conducted|Total Lectures)[\s\S]*?>\s*(\d+)\s*</i);
    if (totalClassesMatch) totalConducted = Number(totalClassesMatch[1]) || 0;
  }

  if (totalAttended === 0) {
    const attendedClassesMatch =
      html.match(/(?:Total Attended|Classes Attended|Present)[\s:]*([0-9]+)/i) ||
      html.match(/(?:Total Attended|Classes Attended|Present)[\s\S]*?>\s*(\d+)\s*</i);
    if (attendedClassesMatch) totalAttended = Number(attendedClassesMatch[1]) || 0;
  }

  if (totalAbsent === 0) {
    const absentClassesMatch =
      html.match(/(?:Total Absent|Classes Absent|Absent)[\s:]*([0-9]+)/i) ||
      html.match(/(?:Total Absent|Classes Absent|Absent)[\s\S]*?>\s*(\d+)\s*</i);
    if (absentClassesMatch) totalAbsent = Number(absentClassesMatch[1]) || 0;
  }

  if (overallPercentage === 0) {
    const overallPctMatch =
      html.match(/(?:Overall Attendance|Percentage|Total Attendance)[\s:]*([0-9]+(?:\.[0-9]+)?)\s*%/i) ||
      html.match(/(?:Overall Attendance|Percentage|Total Attendance)[\s\S]*?>\s*([0-9]+(?:\.[0-9]+)?)\s*%/i);
    if (overallPctMatch) overallPercentage = parseFloat(overallPctMatch[1]) || 0;
  }

  // 1. Primary parser: Modern portal card-based layout (.course-section)
  const seenCourseKeys = new Set();
  const sections = html.split('<div class="course-section">').slice(1);

  for (const rawSec of sections) {
    const sec = rawSec.split('<div class="course-section">')[0];
    const titleMatch = sec.match(/<span class=["']course-title["']>([\s\S]*?)<\/span>/i);
    if (!titleMatch) continue;
    const title = cleanText(
      titleMatch[1]
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&#39;/g, "'")
        .replace(/&quot;/g, '"')
    );
    if (!title) continue;

    const courseIdM = sec.match(/data-courseid=["']([^"']+)["']/i);
    const courseId = courseIdM ? courseIdM[1] : '';
    const dedupeKey = courseId || title.toLowerCase();
    if (seenCourseKeys.has(dedupeKey)) continue;
    seenCourseKeys.add(dedupeKey);

    const tagMatch = sec.match(/<span class=["']mandatory-tag["']>([\s\S]*?)<\/span>/i);
    const tag = tagMatch ? cleanText(tagMatch[1].replace(/<[^>]+>/g, '')) : 'Mandatory';

    const presM = sec.match(/icon-text-present["']>(\d+)<\/span>/i);
    const present = presM ? Number(presM[1]) : 0;

    const absM = sec.match(/icon-text-absent["']>(\d+)<\/span>/i);
    const absent = absM ? Number(absM[1]) : 0;

    const condM = sec.match(/Lecture Conducted<\/span>\s*<span class=["']schedule-value["']>(\d+)<\/span>/i);
    const conducted = condM ? Number(condM[1]) : (present + absent);

    const schedM = sec.match(/Lecture Schedule<\/span>\s*<span class=["']schedule-value["']>(\d+)<\/span>/i);
    const scheduled = schedM ? Number(schedM[1]) : conducted;

    const canvasM = sec.match(/data-presentpercentage=["']([0-9.]+)["']/i);
    let pct = canvasM ? parseFloat(canvasM[1]) : (conducted > 0 ? (present / conducted) * 100 : 0);
    pct = Math.round(pct * 10) / 10;

    const pbsmM = sec.match(/data-pbsm=["']([^"']+)["']/i);
    const pbsm = pbsmM ? pbsmM[1] : '';

    let isBelow = pct < 75;
    let guidance = '';
    if (conducted === 0) {
      isBelow = false;
      guidance = 'No classes conducted yet';
    } else if (isBelow) {
      const needed = Math.max(1, Math.ceil(3 * conducted - 4 * present));
      guidance = 'Need ' + needed + ' more class' + (needed > 1 ? 'es' : '') + ' to reach 75%';
    } else {
      const canMiss = Math.max(0, Math.floor((4 * present / 3) - conducted));
      guidance = canMiss > 0 ? 'Safe to miss ' + canMiss + ' class' + (canMiss > 1 ? 'es' : '') : 'On margin: attend next class';
    }

    subjectWise.push({
      subjectId: courseId || title,
      subjectCode: tag,
      subjectName: title,
      courseId,
      pbsm,
      totalLectures: conducted,
      presentLectures: present,
      absentLectures: absent,
      scheduledLectures: scheduled,
      attendancePercentage: pct,
      status: isBelow ? 'below-75' : 'ok',
      guidance,
      hasDetails: true,
      // Old ERP table format compatibility
      subject: title,
      attendedEstimate: present,
      totalClassesAssumed: conducted,
      percentage: pct,
    });
  }

  // 2. Fallback: Parse Subject-wise table rows (<tr><td>) if .course-section was not present
  if (subjectWise.length === 0) {
    const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];
    for (const r of rows) {
      const rowHtml = r[1];
      if (rowHtml.includes('<th') || !rowHtml.includes('<td')) continue;

      const cells = [...rowHtml.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((c) =>
        cleanText(c[1].replace(/<[^>]+>/g, ''))
      );

      if (cells.length >= 4) {
        const subjectName = cells[0] || cells[1];
        const numbers = cells.filter((c) => /^\d+$/.test(c)).map(Number);
        if (subjectName && numbers.length >= 2) {
          const total = numbers[0];
          const present = numbers[1];
          const absent = numbers.length >= 3 ? numbers[2] : Math.max(0, total - present);
          const percentage = total > 0 ? Math.round((present / total) * 1000) / 10 : 0;
          const codeMatch = subjectName.match(/\(([A-Za-z0-9\-]+)\)/);
          const subjectCode = codeMatch ? codeMatch[1] : 'Mandatory';

          const detailsIdMatch = rowHtml.match(/data-subject-id=["']([^"']+)["']/i) || rowHtml.match(/onclick=["'][^"']*viewDetails\(['"]?([^'"\)]+)['"]?\)/i);
          const subjectId = detailsIdMatch ? detailsIdMatch[1] : subjectCode || subjectName;

          const isBelow = percentage < 75;
          let guidance = '';
          if (isBelow) {
            const needed = Math.max(1, Math.ceil(3 * total - 4 * present));
            guidance = 'Need ' + needed + ' more class' + (needed > 1 ? 'es' : '') + ' to reach 75%';
          } else {
            const canMiss = Math.max(0, Math.floor((4 * present / 3) - total));
            guidance = canMiss > 0 ? 'Safe to miss ' + canMiss + ' class' + (canMiss > 1 ? 'es' : '') : 'On margin: attend next class';
          }

          subjectWise.push({
            subjectId,
            subjectCode,
            subjectName: subjectName.replace(/\([A-Za-z0-9\-]+\)/, '').trim(),
            totalLectures: total,
            presentLectures: present,
            absentLectures: absent,
            attendancePercentage: percentage,
            status: isBelow ? 'below-75' : 'ok',
            guidance,
            hasDetails: true,
            subject: subjectName.replace(/\([A-Za-z0-9\-]+\)/, '').trim(),
            attendedEstimate: present,
            totalClassesAssumed: total,
            percentage,
          });
        }
      }
    }
  }

  // 3. Parse Daily Attendance records from modern date cards (.lectDateCard)
  const combinedLectHtml = html + '\n' + extraLecturesHtml;
  const dateCards = combinedLectHtml.split('<div class="lectDateCard').slice(1);
  for (const dc of dateCards) {
    const dateMatch = dc.match(/<div class=["']dateText["']>\s*<span>([^<]+)<\/span>/i);
    const rawDate = dateMatch ? dateMatch[1].trim() : '';
    let dateIso = '';
    const parts = rawDate.match(/(\d{2})-(\d{2})-(\d{4})/);
    if (parts) {
      dateIso = parts[3] + '-' + parts[2] + '-' + parts[1];
    }

    const lectInfos = dc.split('class="lectInfo').slice(1);
    for (const info of lectInfos) {
      const statusM = info.match(/stdStatus[^>]*>[\s\S]*?<span[^>]*>([^<]+)<\/span>/i);
      const rawStatus = statusM ? statusM[1].trim() : 'Present';
      let status = 'Present';
      if (/absent/i.test(rawStatus)) status = 'Absent';
      else if (/not\s*marked/i.test(rawStatus)) status = 'Not Marked';

      const timeM = info.match(/lectTime[^>]*>[\s\S]*?<span>(\d{2}:\d{2})<\/span>\s*<span>([A-Z]{2})<\/span>/i);
      const time = timeM ? (timeM[1] + ' ' + timeM[2]) : '';

      const facultyM = info.match(/facultyNameText["']>([^<]+)<\/span>/i);
      const faculty = facultyM ? cleanText(facultyM[1]) : '';

      dailyRecords.push({
        lectureDate: dateIso || rawDate,
        rawDate,
        lectureTime: time,
        facultyName: faculty,
        attendanceStatus: status,
        isNotMarked: status === 'Not Marked',
      });
    }
  }

  // Fallback for older table-based daily attendance records
  if (dailyRecords.length === 0) {
    const dailyRowRegex = /<tr[^>]*data-record-date=["']?([^"'>]*)["']?[^>]*>([\s\S]*?)<\/tr>/gi;
    let dMatch;
    while ((dMatch = dailyRowRegex.exec(html)) !== null) {
      const rDate = dMatch[1];
      const rHtml = dMatch[2];
      const cells = [...rHtml.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((c) =>
        cleanText(c[1].replace(/<[^>]+>/g, ''))
      );

      if (cells.length >= 3) {
        const statusRaw = cells.find((c) => /present|absent|not marked|n\.m\.|p|a/i.test(c)) || 'Not Marked';
        let status = 'Not Marked';
        if (/^p(resent)?$/i.test(statusRaw)) status = 'Present';
        else if (/^a(bsent)?$/i.test(statusRaw)) status = 'Absent';

        dailyRecords.push({
          lectureDate: rDate || cells[0],
          subjectName: cells[1] || '',
          facultyName: cells[2] || '',
          lectureTime: cells[3] || '',
          attendanceStatus: status,
          isNotMarked: status === 'Not Marked',
        });
      }
    }
  }

  // If summary totals were not explicitly in top cards, compute faithfully from subject-wise items
  if (totalConducted === 0 && subjectWise.length > 0) {
    totalConducted = subjectWise.reduce((acc, s) => acc + s.totalLectures, 0);
    totalAttended = subjectWise.reduce((acc, s) => acc + s.presentLectures, 0);
    totalAbsent = subjectWise.reduce((acc, s) => acc + s.absentLectures, 0);
    overallPercentage = totalConducted > 0 ? Math.round((totalAttended / totalConducted) * 1000) / 10 : 0;
  }

  return {
    summary: {
      totalConducted,
      totalAttended,
      totalAbsent,
      overallPercentage,
    },
    subjectWise,
    dailyRecords,
    subjects: subjectWise,
  };
}

/**
 * Filter attendance records by Date Range
 */
function filterAttendanceByDateRange(records, startDateStr, endDateStr) {
  if (!Array.isArray(records)) return [];
  if (!startDateStr && !endDateStr) return records.slice();

  const start = startDateStr ? new Date(startDateStr).getTime() : 0;
  const end = endDateStr ? new Date(endDateStr).getTime() : Infinity;

  return records.filter((r) => {
    const recDate = new Date(r.lectureDate).getTime();
    if (isNaN(recDate)) return true;
    return recDate >= start && recDate <= end;
  });
}

/**
 * Perform login against Quantum University New ERP
 *
 * Uses Playwright with TLS bypass and full DOM extraction.
 */
async function loginNewErp({ email, password, logoutOtherSessions = false }, log = console) {
  const normEmail = String(email || '').trim().toLowerCase();
  const rawPassword = String(password || '');

  if (!normEmail || !rawPassword) {
    throw new NewErpAuthError('Email and password are required for New ERP login.');
  }

  let browser = null;
  let context = null;

  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-extensions',
        '--no-first-run',
        '--no-default-browser-check',
        '--mute-audio',
      ],
    });

    context = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 1280, height: 800 },
      userAgent: SHARED_USER_AGENT,
    });

    const page = await context.newPage();

    log.log(`[new-erp] Navigating to ${LOGIN_URL}...`);
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 35000 });

    // Wait for the login form elements
    await page.waitForSelector('#txtStuID', { timeout: 15000 });
    await page.fill('#txtStuID', normEmail);
    await page.fill('#password-field', rawPassword);

    log.log(`[new-erp] Submitting credentials for ${normEmail}...`);
    // Click submit and wait for navigation or inline error
    await Promise.all([
      page.click('button[type="submit"].login-btn, form#login-form button[type="submit"]'),
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null),
    ]);

    // Check for inline error messages and active session conflicts
    const statusInfo = await page.evaluate(() => {
      const el = document.querySelector('#spanerrror, #otpErrorText, .field-validation-error, .alert-danger');
      const text = el ? el.innerText.trim() : '';
      const html = el ? el.innerHTML : '';
      const swal = document.querySelector('.swal2-title, .swal2-content');
      const swalText = swal ? swal.innerText.trim() : '';
      const combined = (text + ' ' + swalText).trim();

      const hasConflict =
        /user session is already active/i.test(combined) ||
        /already active/i.test(combined) ||
        /logout all session/i.test(combined) ||
        /logoutSessions/i.test(html) ||
        /another device|logged in on another|another session/i.test(combined);

      const hasInvalidCreds =
        /invalid user/i.test(combined) ||
        /wrong password/i.test(combined) ||
        /invalid username or password/i.test(combined);

      return {
        text: combined,
        html,
        hasConflict,
        hasInvalidCreds,
      };
    });

    if (statusInfo.hasInvalidCreds) {
      log.log(`[new-erp] Login failed: Invalid credentials`);
      throw new NewErpAuthError('Invalid UserName or Password. Please check your credentials.');
    }

    if (statusInfo.hasConflict) {
      log.log(`[new-erp] Detected portal active session conflict: "${statusInfo.text}"`);

      if (!logoutOtherSessions) {
        // Do NOT automatically logout without explicit user consent
        const conflictErr = new NewErpSessionConflictError('Your QUMS account is already active on another session.');
        conflictErr.canLogoutAll = true;
        conflictErr.code = 'PORTAL_ACTIVE_SESSION_CONFLICT';
        throw conflictErr;
      }

      // User confirmed: execute official Logout All Session on portal
      log.log('[new-erp] User confirmed Logout All Sessions. Triggering official portal logout...');

      const logoutTriggered = await page.evaluate(() => {
        const btn = document.querySelector('a[onclick*="logoutSessions"], button[onclick*="logoutSessions"], [onclick*="logoutSessions"]');
        if (btn) {
          btn.click();
          return true;
        }
        const links = Array.from(document.querySelectorAll('a, button'));
        const match = links.find((l) => /logout all session/i.test(l.innerText || ''));
        if (match) {
          match.click();
          return true;
        }
        return false;
      });

      if (!logoutTriggered) {
        log.log('[new-erp] Could not find clickable logout element on portal');
        throw new NewErpSessionConflictError(
          'Could not find official "Logout All Session" button on portal. Please log in directly at https://my.quantumuniversity.edu.in/ to reset your session.'
        );
      }

      // Wait for official portal to verify session logout
      log.log('[new-erp] Waiting for portal to confirm session invalidation...');
      const confirmed = await page.waitForFunction(() => {
        const span = document.querySelector('#spanerrror, #otpErrorText');
        const txt = span ? span.innerText.trim() : '';
        return /logged out from all devices|successfully logged out/i.test(txt);
      }, { timeout: 15000 }).catch(() => null);

      if (!confirmed) {
        const currentMsg = await page.evaluate(() => {
          const s = document.querySelector('#spanerrror, #otpErrorText');
          return s ? s.innerText.trim() : '';
        });
        log.log(`[new-erp] Logout verification status: "${currentMsg}"`);
        if (!/logged out from all devices|successfully/i.test(currentMsg)) {
          throw new NewErpSessionConflictError(
            'Official portal did not confirm session logout. Please try again or log in directly at https://my.quantumuniversity.edu.in/'
          );
        }
      }

      log.log('[new-erp] Official portal confirmed: Previous session invalidated. Retrying authentication once...');
      await page.waitForTimeout(1000);

      // Retry authentication ONCE
      await page.fill('#txtStuID', normEmail);
      await page.fill('#password-field', rawPassword);
      await Promise.all([
        page.click('button[type="submit"].login-btn, form#login-form button[type="submit"]'),
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null),
      ]);

      // Check for errors after retry
      const retryError = await page.evaluate(() => {
        const el = document.querySelector('#spanerrror, #otpErrorText, .field-validation-error, .alert-danger');
        if (el && el.innerText.trim()) return el.innerText.trim();
        return '';
      });

      if (retryError && !/logged out from all devices/i.test(retryError)) {
        log.log(`[new-erp] Post-logout retry login failed: "${retryError}"`);
        if (/already active|logout all session/i.test(retryError)) {
          throw new NewErpSessionConflictError(
            'Your QUMS account is already active on another session. Please log in directly at https://my.quantumuniversity.edu.in/'
          );
        }
        throw new NewErpAuthError(`Login failed: ${retryError}`);
      }
    } else if (statusInfo.text) {
      log.log(`[new-erp] Login failed with error message: "${statusInfo.text}"`);
      throw new NewErpAuthError(`Login failed: ${statusInfo.text}`);
    }

    const currentUrl = page.url();
    log.log(`[new-erp] Navigated to: ${currentUrl}`);

    // If still on the login page without error, check if redirected back
    if (currentUrl === LOGIN_URL || currentUrl.endsWith('/Login') || currentUrl.endsWith('/Login/')) {
      const bodyHtml = await page.content();
      if (/user session is already active|already active/i.test(bodyHtml)) {
        throw new NewErpSessionConflictError('Your QUMS account is already active on another session.');
      }
      if (bodyHtml.includes('Invalid UserName Or Password')) {
        throw new NewErpAuthError('Invalid UserName or Password.');
      }
      throw new NewErpAuthError('Login unsuccessful — remained on login page.');
    }

    // Extract storage state (cookies + localStorage)
    const storageState = await context.storageState();

    // Extract student profile info
    const pageHtml = await page.content();
    let profile = parseNewErpProfile(pageHtml);

    // If profile details (year/sem) were not on the landing page, navigate to Academic page
    if (!profile.semester || !profile.academicYear) {
      try {
        log.log(`[new-erp] Navigating to ${ACADEMIC_URL} to detect student semester and academic year...`);
        await page.goto(ACADEMIC_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
        const academicHtml = await page.content();
        const academicProfile = parseNewErpProfile(academicHtml);
        profile = { ...profile, ...academicProfile };
      } catch (navErr) {
        log.log(`[new-erp] Note: Could not auto-detect academic page info: ${navErr.message}`);
      }
    }

    profile.email = normEmail;

    return {
      ok: true,
      storageState,
      studentInfo: profile,
    };
  } finally {
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }
}

/**
 * Verify if a New ERP session file is still valid
 */
async function verifyNewErpSession(sessionPath, log = console) {
  if (!sessionPath || !fs.existsSync(sessionPath)) {
    return { active: false, reason: 'Session file not found' };
  }

  let browser = null;
  let context = null;

  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });

    context = await browser.newContext({
      storageState: sessionPath,
      ignoreHTTPSErrors: true,
      viewport: { width: 1280, height: 800 },
      userAgent: SHARED_USER_AGENT,
    });

    const page = await context.newPage();
    const res = await page.goto(ACADEMIC_URL, { waitUntil: 'domcontentloaded', timeout: 25000 });
    const finalUrl = page.url();

    // If redirected to login page or response is 401/403/302, session is expired
    if (
      finalUrl === LOGIN_URL ||
      finalUrl.endsWith('/Login') ||
      finalUrl.endsWith('/Login/') ||
      !res ||
      res.status() === 401 ||
      res.status() === 403
    ) {
      log.log(`[new-erp] Session verification failed (redirected to ${finalUrl})`);
      return { active: false, reason: 'Session expired (redirected to login)' };
    }

    const html = await page.content();
    if (html.includes('id="txtStuID"') && html.includes('id="password-field"')) {
      return { active: false, reason: 'Login form detected' };
    }

    return { active: true, profile: parseNewErpProfile(html) };
  } catch (err) {
    log.log(`[new-erp] Session verification error: ${err.message}`);
    return { active: false, reason: err.message };
  } finally {
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }
}

/**
 * Scrape Timetable from New ERP (/Student/Academic)
 */
async function scrapeNewErpTimetable({ sessionPath, startDate = null, endDate = null }, log = console) {
  if (!sessionPath || !fs.existsSync(sessionPath)) {
    throw new Error('New ERP session not found on disk.');
  }

  let browser = null;
  let context = null;

  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });

    context = await browser.newContext({
      storageState: sessionPath,
      ignoreHTTPSErrors: true,
      viewport: { width: 1280, height: 800 },
      userAgent: SHARED_USER_AGENT,
    });

    const page = await context.newPage();
    let ttAjaxHtml = '';
    page.on('response', async (response) => {
      try {
        if (response.url().includes('GetWeekCalendarStudentData')) {
          ttAjaxHtml = await response.text();
        }
      } catch {}
    });

    log.log(`[new-erp] Fetching timetable from ${ACADEMIC_URL}...`);
    const res = await page.goto(ACADEMIC_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

    if (page.url() === LOGIN_URL || (res && (res.status() === 401 || res.status() === 403))) {
      const pageHtml = await page.content().catch(() => '');
      if (/user session is already active|already active/i.test(pageHtml)) {
        throw new NewErpSessionConflictError('Your QUMS account is already active on another session.');
      }
      throw new NewErpSessionExpiredError();
    }

    // Wait for the AJAX timetable call to finish populating #timetablediv
    await page.waitForFunction(() => {
      const el = document.getElementById('timetablediv');
      return el && el.innerHTML.includes('bg-blue-800');
    }, { timeout: 15000 }).catch(() => {});

    // If custom date range was requested, trigger the official AJAX with specified attendanceDate & attendanceEndDate
    if (startDate && endDate) {
      log.log(`[new-erp] Querying timetable for date range: ${startDate} to ${endDate}`);
      const customTt = await page.evaluate(async ({ start, end }) => {
        const pbsmId = document.querySelector('#filter_pbsmID')?.value || '';
        const fd = new FormData();
        fd.append('SessionId', pbsmId);
        fd.append('CoursesGuids', '');
        fd.append('attendanceDate', start);
        fd.append('attendanceEndDate', end);

        const r = await fetch('/Student/StudentAtt/GetWeekCalendarStudentData', {
          method: 'POST',
          body: fd,
        });
        return await r.text();
      }, { start: startDate, end: endDate });

      if (customTt && customTt.length > 100) {
        ttAjaxHtml = customTt;
      }
    }

    const divHtml = await page.$eval('#timetablediv', (el) => el.innerHTML).catch(() => '');
    const pageHtml = await page.content();
    const combinedHtml = (ttAjaxHtml ? ttAjaxHtml + '\n' : '') + (divHtml ? divHtml + '\n' : '') + pageHtml;

    const timetable = parseNewErpTimetable(combinedHtml);
    const profile = parseNewErpProfile(pageHtml);

    return {
      success: true,
      updatedAt: new Date().toISOString(),
      studentInfo: profile,
      ...timetable,
    };
  } finally {
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }
}

/**
 * Pure parser for New ERP Date Cards (.lectDateCard)
 */
function parseNewErpLectureCards(html, subjectName = '', subjectCode = '') {
  if (!html || typeof html !== 'string') return [];
  const cards = html.split('<div class="lectDateCard').slice(1);
  const records = [];
  for (const card of cards) {
    const dateM = card.match(/<div class=["']dateText["']>\s*<span>([^<]+)<\/span>/i);
    const rawDate = dateM ? dateM[1].trim() : '';
    let dateIso = '';
    const parts = rawDate.match(/(\d{2})-(\d{2})-(\d{4})/);
    if (parts) {
      dateIso = `${parts[3]}-${parts[2]}-${parts[1]}`;
    }

    const infos = card.split('class="lectInfo').slice(1);
    for (const info of infos) {
      const statusM = info.match(/stdStatus[^>]*>[\s\S]*?<span[^>]*>([^<]+)<\/span>/i);
      const rawStatus = statusM ? statusM[1].trim() : 'Present';
      let status = 'unmarked';
      if (/present/i.test(rawStatus)) status = 'present';
      else if (/absent/i.test(rawStatus)) status = 'absent';
      else if (/not\s*marked/i.test(rawStatus)) status = 'unmarked';

      const timeM = info.match(/lectTime[^>]*>[\s\S]*?<span>(\d{2}:\d{2})<\/span>\s*<span>([A-Z]{2})<\/span>/i);
      const time = timeM ? `${timeM[1]} ${timeM[2]}` : '';

      const facM = info.match(/facultyNameText["']>([^<]+)<\/span>/i);
      const faculty = facM ? facM[1].replace(/\s+/g, ' ').trim() : '';

      const normDate = dateIso || rawDate;
      const cleanSubCode = (subjectCode || subjectName).replace(/[^A-Za-z0-9]/g, '');
      const cleanTime = time.replace(/\s+/g, '');
      const key = `${normDate}-${cleanSubCode}-${cleanTime}`;

      records.push({
        date: normDate,
        rawDate,
        time,
        teacher: faculty,
        facultyName: faculty,
        status,
        statusRaw: rawStatus,
        attendanceStatus: rawStatus,
        subject: subjectName,
        subjectName,
        subjectCode: subjectCode || subjectName,
        key,
      });
    }
  }
  return records;
}

/**
 * Scrape ALL backdated lecture records across all active courses
 */
async function scrapeAllNewErpLectureRecords({ sessionPath, startDate = '2026-01-01', endDate = '2026-12-31' }, log = console) {
  if (!sessionPath || !fs.existsSync(sessionPath)) {
    throw new Error('New ERP session not found on disk.');
  }

  let browser = null;
  let context = null;

  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });

    context = await browser.newContext({
      storageState: sessionPath,
      ignoreHTTPSErrors: true,
      viewport: { width: 1280, height: 800 },
      userAgent: SHARED_USER_AGENT,
    });

    const page = await context.newPage();
    log.log(`[new-erp] Navigating to ${ATTENDANCE_URL} to scrape lecture records...`);
    const res = await page.goto(ATTENDANCE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

    if (page.url() === LOGIN_URL || (res && (res.status() === 401 || res.status() === 403))) {
      const pageHtml = await page.content().catch(() => '');
      if (/user session is already active|already active/i.test(pageHtml)) {
        throw new NewErpSessionConflictError('Your QUMS account is already active on another session.');
      }
      throw new NewErpSessionExpiredError();
    }

    // Wait for .tab-toggle buttons to load
    await page.waitForFunction(() => {
      return document.querySelectorAll('.tab-toggle').length > 0 || (document.getElementById('contentDiv') && document.getElementById('contentDiv').innerHTML.includes('course-section'));
    }, { timeout: 15000 }).catch(() => {});

    // Batch fetch lecture history across all courses
    const allCoursesLectures = await page.evaluate(async ({ sDate, eDate }) => {
      const buttons = document.querySelectorAll('.tab-toggle');
      const courses = [];
      buttons.forEach((btn) => {
        const section = btn.closest('.course-section');
        const title = section && section.querySelector('.course-title') ? section.querySelector('.course-title').innerText.trim() : '';
        const tag = section && section.querySelector('.mandatory-tag') ? section.querySelector('.mandatory-tag').innerText.trim() : '';
        const courseId = btn.getAttribute('data-courseid') || btn.dataset.courseid;
        const pbsm = btn.getAttribute('data-pbsm') || btn.dataset.pbsm;
        if (courseId && !courses.some((c) => c.courseId === courseId)) {
          courses.push({ title, tag, courseId, pbsm });
        }
      });

      const results = await Promise.all(
        courses.map(async (c) => {
          const fd = new URLSearchParams();
          fd.append('CourseGuid', c.courseId);
          fd.append('PBSMRecordID', c.pbsm);
          fd.append('startOfMonth', sDate);
          fd.append('endOfMonth', eDate);
          try {
            const r = await fetch('/Student/StudentAtt/GetCourseWiseLectureListingOnStudPortalWeekView', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                'X-Requested-With': 'XMLHttpRequest',
              },
              body: fd.toString(),
            });
            const html = await r.text();
            return { course: c, html };
          } catch (e) {
            return { course: c, html: '', error: e.message };
          }
        })
      );
      return results;
    }, { sDate: startDate, eDate: endDate });

    const allRecords = [];
    for (const item of allCoursesLectures) {
      if (!item.html) continue;
      const parsedRecords = parseNewErpLectureCards(item.html, item.course.title, item.course.tag || item.course.title);
      allRecords.push(...parsedRecords);
    }

    log.log(`[new-erp] Scraped ${allRecords.length} historical lecture records across ${allCoursesLectures.length} courses.`);

    return {
      success: true,
      records: allRecords,
      totalCount: allRecords.length,
    };
  } finally {
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }
}

/**
 * Scrape Attendance from New ERP (/Student/Academic/StudentAttendance)
 */
async function scrapeNewErpAttendance({ sessionPath, startDate = null, endDate = null }, log = console) {
  if (!sessionPath || !fs.existsSync(sessionPath)) {
    throw new Error('New ERP session not found on disk.');
  }

  let browser = null;
  let context = null;

  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });

    context = await browser.newContext({
      storageState: sessionPath,
      ignoreHTTPSErrors: true,
      viewport: { width: 1280, height: 800 },
      userAgent: SHARED_USER_AGENT,
    });

    const page = await context.newPage();
    let courseWiseHtml = '';
    page.on('response', async (response) => {
      try {
        if (response.url().includes('GetStudentCourseWiseLectureInfo')) {
          courseWiseHtml = await response.text();
        }
      } catch {}
    });

    log.log(`[new-erp] Fetching attendance from ${ATTENDANCE_URL}...`);
    const res = await page.goto(ATTENDANCE_URL, { waitUntil: 'load', timeout: 35000 });

    if (page.url() === LOGIN_URL || (res && (res.status() === 401 || res.status() === 403))) {
      const pageHtml = await page.content().catch(() => '');
      if (/user session is already active|already active/i.test(pageHtml)) {
        throw new NewErpSessionConflictError('Your QUMS account is already active on another session.');
      }
      throw new NewErpSessionExpiredError();
    }

    // Wait for the asynchronous AJAX call /Student/StudentAtt/GetStudentCourseWiseLectureInfo to populate #contentDiv
    await page.waitForFunction(() => {
      const el = document.getElementById('contentDiv');
      return el && el.innerHTML.trim().length > 50;
    }, { timeout: 15000 }).catch(() => {});

    // Batch-fetch real lecture logs across all courses for the requested date range (or full semester)
    log.log(`[new-erp] Batch-fetching course lecture records (range: ${startDate || 'semester-start'} to ${endDate || 'semester-end'})...`);
    const courseLecturesData = await page.evaluate(async ({ sDate, eDate }) => {
      const buttons = document.querySelectorAll('.tab-toggle');
      const courses = [];
      buttons.forEach((btn) => {
        const section = btn.closest('.course-section');
        const title = section && section.querySelector('.course-title') ? section.querySelector('.course-title').innerText.trim() : '';
        const tag = section && section.querySelector('.mandatory-tag') ? section.querySelector('.mandatory-tag').innerText.trim() : '';
        const courseId = btn.getAttribute('data-courseid') || btn.dataset.courseid;
        const pbsm = btn.getAttribute('data-pbsm') || btn.dataset.pbsm;
        if (courseId && !courses.some((c) => c.courseId === courseId)) {
          courses.push({ title, tag, courseId, pbsm });
        }
      });

      const results = await Promise.all(
        courses.map(async (c) => {
          const fd = new URLSearchParams();
          fd.append('CourseGuid', c.courseId);
          fd.append('PBSMRecordID', c.pbsm);
          fd.append('startOfMonth', sDate || '2026-08-01');
          fd.append('endOfMonth', eDate || '2026-12-31');

          try {
            const r = await fetch('/Student/StudentAtt/GetCourseWiseLectureListingOnStudPortalWeekView', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                'X-Requested-With': 'XMLHttpRequest',
              },
              body: fd.toString(),
            });
            const html = await r.text();
            return { course: c, html };
          } catch (e) {
            return { course: c, html: '', error: e.message };
          }
        })
      );
      return results;
    }, { sDate: startDate, eDate: endDate });

    const html = await page.content();
    const combinedHtml = (courseWiseHtml ? courseWiseHtml + '\n' : '') + html;
    const result = parseNewErpAttendance(combinedHtml);
    const profile = parseNewErpProfile(html);

    // Parse all lectures across all courses
    const allRecords = [];
    if (Array.isArray(courseLecturesData)) {
      for (const item of courseLecturesData) {
        if (!item.html) continue;
        const parsed = parseNewErpLectureCards(item.html, item.course.title, item.course.tag || item.course.title);
        allRecords.push(...parsed);
      }
    }

    // Sort by date ascending
    allRecords.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

    result.dailyRecords = (startDate || endDate)
      ? filterAttendanceByDateRange(allRecords, startDate, endDate)
      : allRecords;

    log.log(`[new-erp] Extracted ${result.subjectWise.length} subjects, ${allRecords.length} total lecture records (${result.dailyRecords.length} in range).`);

    return {
      success: true,
      updatedAt: new Date().toISOString(),
      profile,
      studentInfo: profile,
      ...result,
    };
  } finally {
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }
}

/**
 * Scrape individual subject lecture records on-demand
 */
async function scrapeNewErpSubjectLectures({ sessionPath, courseId, pbsm, startDate, endDate, subjectName = '', subjectCode = '' }, log = console) {
  if (!sessionPath || !fs.existsSync(sessionPath)) {
    throw new Error('New ERP session not found on disk.');
  }

  let browser = null;
  let context = null;

  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });

    context = await browser.newContext({
      storageState: sessionPath,
      ignoreHTTPSErrors: true,
      viewport: { width: 1280, height: 800 },
      userAgent: SHARED_USER_AGENT,
    });

    const page = await context.newPage();
    await page.goto(ATTENDANCE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

    if (page.url() === LOGIN_URL) {
      throw new NewErpSessionExpiredError();
    }

    const sDate = startDate || '2026-08-01';
    const eDate = endDate || '2026-12-31';

    const lectureHtml = await page.evaluate(async ({ cId, pId, start, end }) => {
      const formData = new URLSearchParams();
      formData.append('CourseGuid', cId);
      formData.append('PBSMRecordID', pId);
      formData.append('startOfMonth', start);
      formData.append('endOfMonth', end);

      const res = await fetch('/Student/StudentAtt/GetCourseWiseLectureListingOnStudPortalWeekView', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: formData.toString(),
      });
      return await res.text();
    }, { cId: courseId, pId: pbsm, start: sDate, end: eDate });

    const parsedRecords = parseNewErpLectureCards(lectureHtml, subjectName, subjectCode);
    log.log(`[new-erp] Scraped ${parsedRecords.length} lecture records for subject "${subjectName || courseId}".`);

    return {
      success: true,
      courseId,
      pbsm,
      dailyRecords: parsedRecords,
    };
  } finally {
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }
}

/**
 * Scrape both Assignments and Assessments from New ERP
 * URL: https://my.quantumuniversity.edu.in/Student/Student/Assessments
 * Endpoints:
 *   GET /Student/Student/GetMyAssessmentsData
 *   GET /Student/Student/GetMyAssignmentsData
 */
async function scrapeNewErpAssignments({ sessionPath }, log = console) {
  if (!sessionPath || !fs.existsSync(sessionPath)) {
    throw new Error('New ERP session not found on disk.');
  }

  let browser = null;
  let context = null;

  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });

    context = await browser.newContext({
      storageState: sessionPath,
      ignoreHTTPSErrors: true,
      viewport: { width: 1280, height: 800 },
      userAgent: SHARED_USER_AGENT,
    });

    const page = await context.newPage();

    log.log(`[new-erp] Fetching assessments from ${ASSESSMENTS_URL}...`);
    const res = await page.goto(ASSESSMENTS_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

    if (page.url() === LOGIN_URL || (res && (res.status() === 401 || res.status() === 403))) {
      const pageHtml = await page.content().catch(() => '');
      if (/user session is already active|already active/i.test(pageHtml)) {
        throw new NewErpSessionConflictError('Your QUMS account is already active on another session.');
      }
      throw new NewErpSessionExpiredError();
    }

    const { assessments, assignments } = await page.evaluate(async () => {
      let assessments = [];
      let assignments = [];
      try {
        const r1 = await fetch('/Student/Student/GetMyAssessmentsData');
        if (r1.ok) assessments = await r1.json();
      } catch {}
      try {
        const r2 = await fetch('/Student/Student/GetMyAssignmentsData');
        if (r2.ok) assignments = await r2.json();
      } catch {}
      return { assessments: assessments || [], assignments: assignments || [] };
    });

    const normalized = [];

    // Helper for normalizing dates to YYYY-MM-DD
    function toYMD(dStr) {
      if (!dStr || typeof dStr !== 'string') return null;
      const m1 = dStr.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/);
      if (m1) return `${m1[1]}-${String(m1[2]).padStart(2, '0')}-${String(m1[3]).padStart(2, '0')}`;
      const m2 = dStr.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})/);
      if (m2) return `${m2[3]}-${String(m2[2]).padStart(2, '0')}-${String(m2[1]).padStart(2, '0')}`;
      return null;
    }

    // 1. Map Assessments (Formative, Summative, Practical, Viva, Quiz)
    (assessments || []).forEach((item, idx) => {
      const isSub = Boolean(item.isSubmitted);
      normalized.push({
        id: item.lessonPlanFilesGuid || item.id || `assessment-${idx + 1}`,
        title: item.title || 'Untitled Assessment',
        subject: item.courseName || 'General',
        deadlineRaw: item.dueDate || 'N/A',
        deadlineYMD: toYMD(item.dueDate),
        maxMarks: item.maxMarks || 'N/A',
        passMarks: item.marksToPass || 'N/A',
        type: item.assessmentType || 'Assessment',
        category: 'assessment',
        isSubmitted: isSub,
        isUploaded: isSub,
        uploadFlag: isSub ? 1 : 0,
        status: isSub ? 'submitted' : 'pending',
        lessonPlanName: item.lessonPlanName || '',
        portalUrl: ASSESSMENTS_URL,
      });
    });

    // 2. Map Assignments
    (assignments || []).forEach((item, idx) => {
      const isSub = Boolean(item.submission);
      normalized.push({
        id: item.lessonPlanFilesGuid || item.id || `assignment-${idx + 1}`,
        title: item.title || 'Untitled Assignment',
        subject: item.courseName || 'General',
        deadlineRaw: item.submissionDate || 'N/A',
        deadlineYMD: toYMD(item.submissionDate),
        maxMarks: item.maxMarks || 'N/A',
        passMarks: item.marksToPass || 'N/A',
        type: 'Assignment',
        category: 'assignment',
        isSubmitted: isSub,
        status: isSub ? 'submitted' : 'pending',
        fileName: item.fileName || '',
        submittedFileName: item.submittedFileName || '',
        downloadUrl: item.fileName
          ? `/Student/Student/DownloadAssignmentFile?fileId=${item.lessonPlanFilesGuid}&fileName=${encodeURIComponent(item.fileName)}`
          : '',
        portalUrl: ASSIGNMENTS_URL,
      });
    });

    log.log(`[new-erp] Extracted ${assessments.length} assessments and ${assignments.length} assignments.`);

    return {
      success: true,
      updatedAt: new Date().toISOString(),
      assessments,
      assignments,
      totalCount: normalized.length,
      pendingCount: normalized.filter((a) => !a.isSubmitted).length,
      submittedCount: normalized.filter((a) => a.isSubmitted).length,
      items: normalized,
    };
  } finally {
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }
}

module.exports = {
  NEW_ERP_BASE_URL,
  LOGIN_URL,
  ACADEMIC_URL,
  ATTENDANCE_URL,
  ASSESSMENTS_URL,
  ASSIGNMENTS_URL,
  LOGOUT_ALL_URL,
  NewErpAuthError,
  NewErpSessionExpiredError,
  NewErpSessionConflictError,
  NewErpPortalError,
  cleanText,
  parseNewErpProfile,
  parseNewErpTimetable,
  parseNewErpAttendance,
  filterAttendanceByDateRange,
  loginNewErp,
  verifyNewErpSession,
  scrapeNewErpTimetable,
  scrapeNewErpAttendance,
  scrapeNewErpSubjectLectures,
  parseNewErpLectureCards,
  scrapeAllNewErpLectureRecords,
  scrapeNewErpAssignments,
};
