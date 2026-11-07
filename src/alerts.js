/**
 * Telegram alerts for operational problems (QUMS session expiry).
 *
 * Contract:
 *   - sent ONLY when Telegram is configured AND that user linked their account
 *     (telegramChatId) — otherwise silently skipped, never a crash;
 *   - at most ONE alert per REAL expiry event, per user. The state lives in
 *     PostgreSQL (session_expiry_state) so a Render/Supabase restart cannot
 *     re-send it; the cooldown is per user, never global;
 *   - the alert carries a single inline button "🔄 Reconnect QUMS" that opens
 *     {APP_BASE_URL}/qums-setup?reconnect=1 (production host from env, never
 *     localhost). The user solves the QUMS captcha manually — QAttend never
 *     bypasses or automates it, and no credential/session data goes to Telegram;
 *   - a successful reconnect clears the state, so a LATER expiry alerts again.
 */
require('dotenv').config();
const telegram = require('./telegram');
const isConfigured = (...args) => telegram.isConfigured(...args);
const sendMessage = (...args) => telegram.sendMessage(...args);
const deleteMessage = (...args) => telegram.deleteMessage(...args);
const scheduleAutoDelete = (...args) => telegram.scheduleAutoDelete(...args);
const db = require('./db');

const COOLDOWN_MS = db.SESSION_ALERT_COOLDOWN_MS;
// In-flight mutex per user to prevent concurrent duplicate session-expiry alerts
const alertInFlight = new Set();

/** Public base URL (same resolution order as server.js — Render-safe, HTTPS compliant). */
function baseUrl() {
  const explicit = String(process.env.APP_BASE_URL || '').trim();
  const render = String(process.env.RENDER_EXTERNAL_URL || '').trim();
  const fallback = 'https://qattend.onrender.com';
  return (explicit || render || fallback).replace(/\/+$/, '');
}

/** Reconnect page (GET) — the existing authenticated QUMS setup page. */
function reconnectUrl() {
  const base = baseUrl();
  // Telegram Bot API strictly requires HTTPS URLs for inline keyboard buttons
  const secureBase = /^https:\/\//i.test(base) ? base : 'https://qattend.onrender.com';
  return `${secureBase}/qums-setup?reconnect=1`;
}

// ---- exact user-facing copy (English only; single source of truth) ----
const SESSION_EXPIRED_TEXT = [
  '⚠️ *QUMS Session Expired*',
  '',
  'Your QUMS session has expired. Please reconnect QUMS to resume attendance and assignment updates.',
  '',
  '🔐 Reconnect QUMS',
].join('\n');

const RECONNECTED_TEXT = [
  '✅ *QUMS Reconnected*',
  '',
  'Your QUMS session has been restored. Attendance and assignment monitoring has resumed.',
].join('\n');

const NEW_ERP_RECONNECTED_TEXT = [
  '✅ *New ERP Reconnected*',
  '',
  'Your New ERP session has been successfully restored. Live tracking and notifications have resumed.',
  '',
  '⏳ _This message will automatically delete in 1 minute._',
].join('\n');

/** Inline keyboard with the Reconnect button. */
function reconnectButton(canTelegramReconnect = false) {
  const url = reconnectUrl();
  if (canTelegramReconnect) {
    return {
      inline_keyboard: [
        [
          { text: '🔄 Reconnect QUMS', callback_data: 'qums_start_reconnect' },
          { text: '🔐 Dashboard', url },
        ],
      ],
    };
  }
  return {
    inline_keyboard: [[{ text: '🔐 Reconnect QUMS', url }]],
  };
}

/**
 * Delete previous session-expired alert from Telegram chat.
 * Requirement: Reconnect hone ke baad session expired wala massage delete krdo.
 */
async function deleteSessionExpiredAlert(userId, log = console) {
  try {
    if (!userId) return false;
    const { deleteMessage } = require('./telegram');
    const messageIds = await db.getSessionExpiryMessageIds(userId).catch(() => []);
    let deletedCount = 0;
    for (const msgId of messageIds) {
      if (msgId && typeof deleteMessage === 'function') {
        const res = await deleteMessage(userId, msgId, log).catch(() => false);
        if (res) deletedCount++;
      }
    }
    await db.clearSessionExpiryTelegramMessage(userId).catch(() => {});
    if (deletedCount > 0) {
      log.log(`[alerts] 🗑️ Deleted ${deletedCount} session-expired message(s) for user=${userId}.`);
      return true;
    }
    return false;
  } catch (err) {
    log.log(`[alerts] deleteSessionExpiredAlert warning: ${err.message}`);
    return false;
  }
}

/**
 * Send the session-expired Telegram alert to ONE user — but only if:
 *   1. Telegram is configured (token present), and
 *   2. that user has linked their Telegram (telegramChatId), and
 *   3. no alert was already sent for THIS expiry event.
 *
 * State is persisted in PostgreSQL (session_expiry_state) — restart-safe — and
 * is always per user, so one user's expiry can never silence another's.
 * `evidence` should only be set when the portal really returned a login page
 * (SessionExpiredError). Network failures must call this with evidence=false,
 * which records the error but sends nothing.
 */
async function maybeNotifySessionExpired(log = console, userId, { evidence = true, isManualAdminAlert = false } = {}) {
  try {
    const logger = (log && typeof log.log === 'function') ? log : console;
    if (!userId || typeof userId !== 'string' || !userId.trim()) {
      const diag = typeof userId === 'object' && userId !== null ? JSON.stringify(userId) : String(userId);
      const errMsg = `[alerts] maybeNotifySessionExpired rejected invalid userId (${typeof userId}): ${diag}`;
      if (typeof logger.error === 'function') logger.error(errMsg);
      else logger.log(errMsg);
      return false;
    }
    if (!evidence) {
      // Temporary QUMS outage: record it, never alert (avoids Telegram spam).
      await db.touchUserSync(userId, { error: 'qums-unreachable' }).catch(() => {});
      logger.log(`[alerts] user=${userId} QUMS unreachable — not treated as expiry, no alert sent.`);
      return false;
    }

    if (alertInFlight.has(userId)) {
      log.log(`[alerts] user=${userId} expiry alert already in flight — skip duplicate send.`);
      return false;
    }
    alertInFlight.add(userId);

    try {
      // Reliable expiry evidence: mark the event if this is a new one.
      const before = await db.getSessionExpiryState(userId);
      const isNewEvent = !before || !before.expiredAt || before.resolvedAt;
      if (isNewEvent) await db.markSessionExpired(userId, 'session-expired');
      const state = await db.getSessionExpiryState(userId);
      if (!isManualAdminAlert && state && state.lastAlertAt && Date.now() - state.lastAlertAt < COOLDOWN_MS) {
        log.log(`[alerts] user=${userId} expiry alert already sent for this event — skip.`);
        return false;
      }
      if (!isConfigured()) {
        log.log('[alerts] Telegram not configured (TELEGRAM_BOT_TOKEN missing) — expiry alert skipped.');
        return false;
      }

      // Check whether user has Telegram and credentials saved for Telegram reconnect button
      const user = await db.getUserById(userId);
      const savedEncrypted = user && (user.qumsPasswordEncrypted || (await db.getQumsEncryptedPassword(userId)));
      const canTelegramReconnect = Boolean(user && user.telegramChatId && user.qumsQid && savedEncrypted);

      // CRITICAL: Background watcher must NEVER automatically launch Chromium or call startTelegramCaptchaReconnect().
      // Instead, we attach an interactive reconnect action/button and wait for the USER to explicitly initiate reconnect.
      const sendOpts = {
        replyMarkup: reconnectButton(canTelegramReconnect),
        category: 'ALERT',
        autoDelete: false,
      };
      const sent = await sendMessage(userId, SESSION_EXPIRED_TEXT, log, sendOpts);
      if (!sent) {
        log.log('[alerts] user has not linked Telegram — expiry alert skipped (the next cycle retries).');
        return false;
      }
      const messageId = sendOpts.messageId || null;
      await db.recordSessionExpiryAlert(userId, messageId);
      await db.recordNotification(userId, 'session_expired', { messageId }, log).catch(() => {});
      log.log(`[alerts] 📲 session-expiry alert sent user=${userId} (msgId=${messageId || 'n/a'}, Reconnect button attached).`);
      return true;
    } finally {
      alertInFlight.delete(userId);
    }
  } catch (err) {
    log.error(`[alerts] session-expiry alert failed: ${err.message}`);
    return false;
  }
}

const RECONNECT_DELETE_DELAY_MS = Number(process.env.RECONNECT_DELETE_DELAY_MS || 60 * 1000); // 1 minute default

/**
 * Schedule a Telegram message to be deleted after a specified delay (default: 1 min / 60,000 ms).
 */
function scheduleMessageDeletion(userId, messageId, delayMs = RECONNECT_DELETE_DELAY_MS, log = console) {
  if (!userId || !messageId) return null;
  if (typeof scheduleAutoDelete === 'function') {
    db.getUserById(userId).then((user) => {
      if (user && user.telegramChatId) {
        scheduleAutoDelete(user.telegramChatId, messageId, delayMs, log);
      }
    }).catch(() => {});
  }
  const timer = setTimeout(async () => {
    try {
      if (typeof deleteMessage === 'function') {
        await deleteMessage(userId, messageId, log).catch(() => {});
        log.log(`[alerts] 🗑️ Reconnect confirmation message ${messageId} auto-deleted after 1 min for user=${userId}.`);
      }
    } catch (err) {
      log.log(`[alerts] auto-delete reconnect message warning: ${err.message}`);
    }
  }, Math.max(0, delayMs));

  if (timer && typeof timer.unref === 'function') {
    timer.unref();
  }
  return timer;
}

/**
 * "✅ QUMS Reconnected" confirmation — sent only after a SUCCESSFUL manual
 * reconnect (the user solved the captcha themselves). Never sent on failure.
 * Deletes any pending "Session Expired" alert message from Telegram,
 * and schedules the reconnect message itself to be deleted after 1 minute.
 */
async function notifyQumsReconnected(log = console, userId, opts = {}) {
  try {
    if (!userId) return false;
    // Reconnect hone ke baad session expired wala message delete krdo
    await deleteSessionExpiredAlert(userId, log);
    await db.clearSessionExpiry(userId);
    if (!isConfigured()) return false;
    const delayMs = opts && opts.deleteAfterMs !== undefined ? Number(opts.deleteAfterMs) : RECONNECT_DELETE_DELAY_MS;
    const sendOpts = {
      category: 'TEMPORARY',
      delayMs,
    };
    const sent = await sendMessage(userId, RECONNECTED_TEXT, log, sendOpts);
    if (sent) {
      const messageId = sendOpts.messageId || null;
      await db.recordNotification(userId, 'qums_reconnected', { messageId }, log).catch(() => {});
      log.log(`[alerts] 📲 QUMS reconnected confirmation sent user=${userId} (msgId=${messageId || 'n/a'}).`);
      // Requirement: Reconnect wala massage fir 1 min ke baad wo v delete ho jaye
      if (messageId) {
        scheduleMessageDeletion(userId, messageId, delayMs, log);
      }
    }
    return Boolean(sent);
  } catch (err) {
    log.error(`[alerts] reconnect confirmation failed: ${err.message}`);
    return false;
  }
}

/**
 * "✅ New ERP Reconnected" confirmation — sent after successful New ERP reconnect.
 * Accepts both (userId, log, opts) and (log, userId, opts).
 */
async function notifyNewErpReconnected(arg1 = console, arg2 = null, opts = {}) {
  try {
    const userId = typeof arg1 === 'string' ? arg1 : (typeof arg2 === 'string' ? arg2 : null);
    const log = (typeof arg1 === 'object' && arg1 !== null) ? arg1 : console;
    if (!userId) return false;
    await deleteSessionExpiredAlert(userId, log);
    await db.clearSessionExpiry(userId);
    if (!isConfigured()) return false;
    const delayMs = opts && opts.deleteAfterMs !== undefined ? Number(opts.deleteAfterMs) : RECONNECT_DELETE_DELAY_MS;
    const sendOpts = {
      category: 'TEMPORARY',
      delayMs,
    };
    const sent = await sendMessage(userId, NEW_ERP_RECONNECTED_TEXT, log, sendOpts);
    if (sent) {
      const messageId = sendOpts.messageId || null;
      await db.recordNotification(userId, 'new_erp_reconnected', { messageId }, log).catch(() => {});
      log.log(`[alerts] 📲 New ERP reconnected confirmation sent user=${userId} (msgId=${messageId || 'n/a'}).`);
      if (messageId) {
        scheduleMessageDeletion(userId, messageId, delayMs, log);
      }
    }
    return Boolean(sent);
  } catch (err) {
    const log = (typeof arg1 === 'object' && arg1 !== null) ? arg1 : console;
    log.error(`[alerts] New ERP reconnect confirmation failed: ${err.message}`);
    return false;
  }
}

/**
 * Clear one user's session-expiry state and delete stale Telegram alert — called
 * after a SUCCESSFUL reconnect so a later expiry alerts again.
 */
async function clearSessionAlert(userId, log = console) {
  try {
    await deleteSessionExpiredAlert(userId, log);
    await db.clearSessionExpiry(userId);
  } catch { /* clearing must never block the reconnect flow */ }
}

/**
 * Notify user of New ERP session expiry via Telegram
 */
async function notifyNewErpSessionExpired(userId, log = console) {
  try {
    if (!userId || !isConfigured()) return false;

    // Dedupe / Cooldown guard: if an alert was sent in this cooldown window (default 12 hours), do not flood Telegram
    const state = await db.getSessionExpiryState(userId).catch(() => null);
    const now = Date.now();
    const cooldownMs = db.SESSION_ALERT_COOLDOWN_MS || 12 * 60 * 60 * 1000;
    if (state && state.lastAlertAt && (now - Number(state.lastAlertAt) < cooldownMs)) {
      log.log(`[alerts] user=${userId} New ERP session expiry alert sent recently (${Math.round((now - Number(state.lastAlertAt)) / 1000)}s ago) — suppressing duplicate.`);
      return false;
    }

    // Delete any previous session alert so there is never more than 1 in chat
    await deleteSessionExpiredAlert(userId, log).catch(() => {});

    const base = baseUrl();
    const url = /^https:\/\//i.test(base) ? `${base}/dashboard?reconnect=1` : 'https://qattend.onrender.com/dashboard?reconnect=1';

    const text = [
      '⚠️ *QUMS Session Logged Out / Expired*',
      '',
      'Aapka New ERP session logout ho gaya hai (kisi aur device/portal par login hone ke karan ya session expire hone par).',
      '',
      'Neeche button dabayein: dusri device se logout ho jayega aur yahan 1-Click me turant reconnect ho jayega:',
    ].join('\n');

    const opts = {
      replyMarkup: {
        inline_keyboard: [
          [{ text: '⚡ 1-Click Reconnect', callback_data: 'new_erp_1click_reconnect' }],
          [{ text: '🔐 Reconnect QUMS', url }],
        ],
      },
      category: 'ALERT',
      autoDelete: false,
    };

    const sent = await sendMessage(userId, text, log, opts);
    if (sent) {
      const msgId = opts.messageId ? String(opts.messageId) : null;
      await db.recordNotification(userId, 'session_expired', { erpType: 'NEW', messageId: msgId }, log).catch(() => {});
      await db.recordSessionExpiryAlert(userId, msgId).catch(() => {});
    }
    return Boolean(sent);
  } catch (err) {
    log.error(`[alerts] New ERP session expiry notification failed: ${err.message}`);
    return false;
  }
}

/**
 * Notify user of failed reconnection attempt
 */
async function notifyReconnectionFailed(userId, errorMsg = '', log = console) {
  try {
    if (!userId || !isConfigured()) return false;
    const base = baseUrl();
    const url = /^https:\/\//i.test(base) ? `${base}/qums-setup` : 'https://qattend.onrender.com/qums-setup';

    const text = [
      '❌ *QUMS Reconnection Failed*',
      '',
      `Could not reconnect your QUMS session: ${errorMsg || 'Authentication failed or portal unreachable'}.`,
      '',
      'Please open QUMS Setup to reconnect.',
    ].join('\n');

    const opts = {
      replyMarkup: {
        inline_keyboard: [[{ text: '⚙️ Open QUMS Setup', url }]],
      },
      category: 'ALERT',
      autoDelete: false,
    };

    return Boolean(await sendMessage(userId, text, log, opts));
  } catch (err) {
    log.error(`[alerts] Reconnection failure notification failed: ${err.message}`);
    return false;
  }
}

/**
 * Notify user of attendance marked or updated, preserving original lecture date
 */
async function notifyAttendanceEvent({ userId, subject, originalDate, faculty, status, isUpdate = false, log = console } = {}) {
  try {
    if (!userId || !isConfigured()) return false;

    const icon = isUpdate ? '🔄' : '📌';
    const actionText = isUpdate ? 'Attendance Updated' : 'Attendance Marked';
    const statusFormatted = status === 'Present' ? '✅ Present' : status === 'Absent' ? '❌ Absent' : '⚪ Not Marked';

    const text = [
      `${icon} *${actionText}*`,
      '',
      `📅 *Lecture Date:* ${originalDate}`,
      `📚 *Subject:* ${subject || 'General'}`,
      `👨‍🏫 *Faculty:* ${faculty || 'Faculty'}`,
      `📊 *Status:* ${statusFormatted}`,
    ].join('\n');

    const opts = { category: 'ATTENDANCE', autoDelete: false };
    return Boolean(await sendMessage(userId, text, log, opts));
  } catch (err) {
    log.error(`[alerts] Attendance notification failed: ${err.message}`);
    return false;
  }
}

/**
 * Notify user of active session conflict on official portal
 */
async function notifySessionConflict(userId, log = console) {
  try {
    if (!userId || !isConfigured()) return false;

    // Dedupe / Cooldown guard: if an alert was sent in this cooldown window (default 12 hours), do not flood Telegram
    const state = await db.getSessionExpiryState(userId).catch(() => null);
    const now = Date.now();
    const cooldownMs = db.SESSION_ALERT_COOLDOWN_MS || 12 * 60 * 60 * 1000;
    if (state && state.lastAlertAt && (now - Number(state.lastAlertAt) < cooldownMs)) {
      log.log(`[alerts] user=${userId} session conflict alert sent recently — suppressing duplicate.`);
      return false;
    }

    // Delete any previous session alert so there is never more than 1 in chat
    await deleteSessionExpiredAlert(userId, log).catch(() => {});

    const base = baseUrl();
    const url = /^https:\/\//i.test(base) ? `${base}/dashboard?reconnect=1` : 'https://qattend.onrender.com/dashboard?reconnect=1';

    const text = [
      '⚠️ *QUMS Session Conflict Detected*',
      '',
      'Aapne official portal (my.quantumuniversity.edu.in) par kisi aur device se login kiya hai, isliye yahan session logout ho gaya.',
      '',
      'Neeche button dabayein: dusri device se logout ho jayega aur yahan 1-Click me turant reconnect ho jayega:',
    ].join('\n');

    const opts = {
      replyMarkup: {
        inline_keyboard: [
          [{ text: '⚡ 1-Click Reconnect', callback_data: 'new_erp_1click_reconnect' }],
          [{ text: '🔐 Reconnect QUMS', url }],
        ],
      },
      category: 'ALERT',
      autoDelete: false,
    };

    const sent = await sendMessage(userId, text, log, opts);
    if (sent) {
      const msgId = opts.messageId ? String(opts.messageId) : null;
      await db.recordNotification(userId, 'session_conflict', { erpType: 'NEW', messageId: msgId }, log).catch(() => {});
      await db.recordSessionExpiryAlert(userId, msgId).catch(() => {});
    }
    return Boolean(sent);
  } catch (err) {
    log.error(`[alerts] Session conflict notification failed: ${err.message}`);
    return false;
  }
}

module.exports = {
  maybeNotifySessionExpired,
  notifyQumsReconnected,
  notifyNewErpReconnected,
  deleteSessionExpiredAlert,
  scheduleMessageDeletion,
  clearSessionAlert,
  notifyNewErpSessionExpired,
  notifySessionConflict,
  notifyReconnectionFailed,
  notifyAttendanceEvent,
  reconnectUrl,
  reconnectButton,
  baseUrl,
  SESSION_EXPIRED_TEXT,
  RECONNECTED_TEXT,
  NEW_ERP_RECONNECTED_TEXT,
  COOLDOWN_MS,
  RECONNECT_DELETE_DELAY_MS,
};
