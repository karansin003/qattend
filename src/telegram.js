/**
 * Telegram module — node-telegram-bot-api, POLLING mode (koi public webhook URL
 * nahi chahiye). Purane WhatsApp (whatsapp-web.js) channel ko replace karta hai.
 *
 * SINGLE /start HANDLER  -> is file me sirf EK `/start` handler register hota hai
 *   (initTelegram ke andar). Register karne se pehle purane text-listeners clear
 *   kiye jaate hain, isliye ek update ka jawab exactly ek baar jaata hai.
 *   Saari user-facing copy `MSG` me hai (English only, single source).
 *   Plain `/start` -> sirf MSG.WELCOME.
 *
 * SINGLE POLLING INSTANCE -> polling sirf EK baar arm hoti hai per process
 *   (globalThis state: import karne ka koi side effect nahi, sirf initTelegram()
 *   se chalti hai). Machine-level pid lock (`data/telegram-polling.lock`) dusre
 *   process ko polling se rokta hai (wo send-only bot bana leta hai). Send-only
 *   instance chahiye to TELEGRAM_POLLING=off. Alag host ka duplicate poller
 *   Telegram se 409 Conflict layega — hum use loud log karte hain.
 *
 * EXACTLY-ONCE -> har message ka (chatId + message_id) dedupe window me jaata
 *   hai; dobara deliver hua update silently ignore hota hai.
 *
 * Standalone check (token valid? kaun linked hai? — koi polling NAHI):
 *   npm run telegram-test
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');
const db = require('./db');

const BOT_USERNAME = (process.env.TELEGRAM_BOT_USERNAME || 'qums_attendance_bot').replace(/^@/, '');
const DEEP_LINK_BASE = `https://t.me/${BOT_USERNAME}`;

// ---- exact user-facing copy (English only — single source of truth) ----
const MSG = {
  WELCOME:
    '👋 Welcome to the QUMS Attendance Bot!\nOpen the web dashboard and press "Connect Telegram" to connect your account.',
  LINK_INVALID:
    '❌ This connection link is invalid or expired.\nPlease open the dashboard and press "Connect Telegram" again.',
  LINK_USAGE: 'Usage: /link <code> — the code is in the "Connect Telegram" section of the dashboard.',
  STATUS_NONE: '❌ No account is linked to this chat. Press "Connect Telegram" on the dashboard.',
  // Greeting me student ka QUMS/ERP naam dynamic — email KABHI Telegram pe nahi jaata.
  connected: (name) => `✅ Connected!\nHello ${name} 👋\nYou will now receive attendance updates here.`,
  alreadyConnected: (name) =>
    `✅ Already Connected!\nHello ${name} 👋\nYou will continue to receive attendance updates here.`,
};

// Process-wide state (globalThis) — module dobara load hone par bhi polling,
// handlers aur dedupe window duplicate nahi hote.
const STATE_KEY = '__qumsTelegramState__';
const state = globalThis[STATE_KEY] || (globalThis[STATE_KEY] = {
  bot: null, // TelegramBot instance (polling ya send-only)
  sendOnly: false, // true = is process me getUpdates NAHI chal raha
  initAttempted: false, // initTelegram() ek hi baar kaam karta hai
  pollingArmed: false,
  lockPid: null, // polling lock jis pid ne liya (sirf usi ko release karna hai)
  seenMessages: new Map(), // `${chatId}:${messageId}` -> ts (dedupe window)
});

function isConfigured() {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN);
}

function isReady() {
  return Boolean(state.bot);
}

function getBotUsername() {
  return BOT_USERNAME;
}

/** linkCode -> https://t.me/<bot>?start=<code> */
function deepLink(linkCode) {
  return `${DEEP_LINK_BASE}?start=${encodeURIComponent(linkCode)}`;
}

// ---- formatting: WhatsApp-style *bold* / _italic_ -> Telegram HTML ----
function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function toTelegramHtml(text) {
  const escaped = escapeHtml(text);
  return escaped
    .replace(/\*(?=\S)(.+?)(?<=\S)\*/gs, '<b>$1</b>')
    .replace(/_(?=\S)(.+?)(?<=\S)_/gs, '<i>$1</i>');
}

/**
 * Per-user send: user ka saved telegramChatId nikal ke message bhejo.
 * Not linked / not configured -> silently skip (false), koi crash nahi.
 * HTML parse fail (rare) -> plain-text fallback.
 *
 * 15I — safe logs: sirf booleans + userId. TELEGRAM_BOT_TOKEN / chatId /
 * connection token KABHI log nahi hota.
 */
async function sendMessage(userId, text, log = console, opts = {}) {
  if (!userId) return false;
  // Optional inline keyboard (e.g. the "🔐 Reconnect QUMS" button on a
  // session-expiry alert). URLs only — never credentials, never tokens.
  const replyMarkup = (opts && opts.replyMarkup) || null;
  const user = await db.getUserById(userId);
  log.log(`[Telegram] Chat ID available: ${Boolean(user && user.telegramChatId)}`); // boolean only — chatId log NAHI
  if (!user || !user.telegramChatId) return false; // Telegram linked nahi hai
  // Polling instance ka bot reuse hota hai; standalone/duplicate process me
  // send-only bot banta hai — koi getUpdates nahi -> koi 409 conflict nahi,
  // koi duplicate /start reply nahi.
  if (!isConfigured()) {
    log.log('[Telegram] Telegram connected: false (TELEGRAM_BOT_TOKEN missing) — send skip.');
    return false;
  }
  if (!state.bot) ensureSendOnlyBot(log);
  log.log('[Telegram] Telegram connected: true');
  try {
    log.log(`[Telegram] Sending notification for user: ${userId}`);
    const payload = { parse_mode: 'HTML', disable_web_page_preview: true };
    if (replyMarkup) payload.reply_markup = replyMarkup;
    const sentMsg = await state.bot.sendMessage(user.telegramChatId, toTelegramHtml(text), payload);
    if (opts && typeof opts === 'object' && sentMsg && sentMsg.message_id) {
      opts.messageId = sentMsg.message_id;
    }
    log.log(`[Telegram] Notification sent successfully for user: ${userId}`);
    return true;
  } catch (err) {
    try {
      // plain-text fallback (markup HTML parse fail hone par bhi button intact)
      const fallback = replyMarkup ? { reply_markup: replyMarkup } : {};
      const sentMsg = await state.bot.sendMessage(user.telegramChatId, text, fallback);
      if (opts && typeof opts === 'object' && sentMsg && sentMsg.message_id) {
        opts.messageId = sentMsg.message_id;
      }
      log.log(`[Telegram] Notification sent successfully for user: ${userId} (plain-text fallback)`);
      return true;
    } catch (err2) {
      log.error(`[Telegram] Notification FAILED for user: ${userId}: ${err.message}`);
      throw err; // watcher/scheduler rollback-retry kar sake
    }
  }
}

/**
 * Delete a previously sent message from a user's Telegram chat.
 * Used to clean up stale alerts (e.g. delete "Session Expired" alert on reconnect).
 */
async function deleteMessage(userId, messageId, log = console) {
  if (!userId || !messageId) return false;
  const user = await db.getUserById(userId);
  if (!user || !user.telegramChatId) return false;
  if (!isConfigured()) return false;
  if (!state.bot) ensureSendOnlyBot(log);
  try {
    log.log(`[Telegram] Deleting message ${messageId} for user: ${userId}`);
    await state.bot.deleteMessage(user.telegramChatId, Number(messageId));
    log.log(`[Telegram] Message ${messageId} deleted successfully for user: ${userId}`);
    return true;
  } catch (err) {
    // If message is already deleted or expired (>48h), silently ignore
    log.log(`[Telegram] deleteMessage failed for user ${userId} msg=${messageId}: ${err.message}`);
    return false;
  }
}

/**
 * Delete a message directly by chatId and messageId.
 */
async function deleteMessageFromChat(chatId, messageId, log = console) {
  if (!chatId || !messageId) return false;
  if (!isConfigured()) return false;
  if (!state.bot) ensureSendOnlyBot(log);
  try {
    await state.bot.deleteMessage(chatId, Number(messageId));
    log.log(`[telegram] Deleted message ${messageId} from chat ${chatId}`);
    return true;
  } catch (err) {
    log.log(`[telegram] deleteMessageFromChat failed for chat ${chatId} msg=${messageId}: ${err.message}`);
    return false;
  }
}

const AUTO_DELETE_DELAY_MS = 1 * 60 * 1000; // 1 minute (60,000 ms)
const AUTO_DELETE_FOOTNOTE = '\n\n⏳ _This message will automatically delete in 1 minute._';

const scheduledTimers = new Map(); // `${chatId}:${messageId}` -> Timeout

/**
 * Schedule a message to be automatically deleted after a delay (default 1 minute).
 * Persists to DB so server restarts don't lose the deletion.
 */
function scheduleAutoDelete(chatId, messageId, delayMs = AUTO_DELETE_DELAY_MS, log = console) {
  if (!chatId || !messageId) return null;
  const key = `${chatId}:${messageId}`;
  if (scheduledTimers.has(key)) {
    return scheduledTimers.get(key);
  }
  const deleteAt = Date.now() + delayMs;

  if (db && typeof db.addScheduledDeletion === 'function') {
    db.addScheduledDeletion(chatId, messageId, deleteAt).catch((err) => {
      log.log(`[telegram] addScheduledDeletion error: ${err.message}`);
    });
  }

  const timer = setTimeout(async () => {
    scheduledTimers.delete(key);
    try {
      await deleteMessageFromChat(chatId, messageId, log);
      if (db && typeof db.removeScheduledDeletion === 'function') {
        await db.removeScheduledDeletion(chatId, messageId).catch(() => {});
      }
    } catch (err) {
      log.log(`[telegram] scheduleAutoDelete execution error: ${err.message}`);
    }
  }, delayMs);

  if (timer && typeof timer.unref === 'function') {
    timer.unref();
  }
  scheduledTimers.set(key, timer);
  return timer;
}

/**
 * Restore pending message auto-deletions on startup.
 */
async function restoreScheduledDeletions(log = console) {
  try {
    if (!db || typeof db.listPendingDeletions !== 'function') return;
    const pending = await db.listPendingDeletions();
    if (!pending || !pending.length) return;
    const now = Date.now();
    for (const item of pending) {
      const remainingMs = Math.max(0, item.deleteAt - now);
      if (remainingMs <= 0) {
        await deleteMessageFromChat(item.chatId, item.messageId, log).catch(() => {});
        await db.removeScheduledDeletion(item.chatId, item.messageId).catch(() => {});
      } else {
        const timer = setTimeout(async () => {
          try {
            await deleteMessageFromChat(item.chatId, item.messageId, log);
            await db.removeScheduledDeletion(item.chatId, item.messageId).catch(() => {});
          } catch (err) {
            log.log(`[telegram] restored auto-delete error: ${err.message}`);
          }
        }, remainingMs);
        if (timer && typeof timer.unref === 'function') timer.unref();
      }
    }
    log.log(`[telegram] Restored ${pending.length} scheduled message deletion(s).`);
  } catch (err) {
    log.log(`[telegram] restoreScheduledDeletions error: ${err.message}`);
  }
}


/**
 * Convert base64 Data URL or string to Buffer.
 */
function toPhotoBuffer(photo) {
  if (Buffer.isBuffer(photo)) return photo;
  if (typeof photo === 'string') {
    const match = photo.match(/^data:image\/[a-zA-Z]+;base64,(.+)$/);
    if (match) {
      return Buffer.from(match[1], 'base64');
    }
    if (/^[A-Za-z0-9+/=]+$/.test(photo.trim()) && photo.trim().length > 100) {
      return Buffer.from(photo.trim(), 'base64');
    }
  }
  return photo;
}

/**
 * Send a photo directly to a chat ID.
 */
async function sendPhotoToChat(chatId, photo, caption = '', log = console, opts = {}) {
  if (!chatId) return false;
  if (!isConfigured()) return false;
  if (!state.bot) ensureSendOnlyBot(log);

  const photoBuf = toPhotoBuffer(photo);
  const payload = {};
  if (caption) {
    payload.caption = toTelegramHtml(caption);
    payload.parse_mode = 'HTML';
  }
  if (opts && opts.replyMarkup) {
    payload.reply_markup = opts.replyMarkup;
  }

  try {
    const sentMsg = await state.bot.sendPhoto(chatId, photoBuf, payload);
    if (opts && typeof opts === 'object' && sentMsg && sentMsg.message_id) {
      opts.messageId = sentMsg.message_id;
    }
    return sentMsg;
  } catch (err) {
    log.error(`[Telegram] sendPhotoToChat FAILED for chat ${chatId}: ${err.message}`);
    try {
      const fbPayload = {};
      if (caption) fbPayload.caption = caption;
      if (opts && opts.replyMarkup) fbPayload.reply_markup = opts.replyMarkup;
      const sentMsg = await state.bot.sendPhoto(chatId, photoBuf, fbPayload);
      if (opts && typeof opts === 'object' && sentMsg && sentMsg.message_id) {
        opts.messageId = sentMsg.message_id;
      }
      return sentMsg;
    } catch (err2) {
      throw err;
    }
  }
}

/**
 * Send a photo to a user by QAttend user ID.
 */
async function sendPhoto(userId, photo, caption = '', log = console, opts = {}) {
  if (!userId) return false;
  const user = await db.getUserById(userId);
  if (!user || !user.telegramChatId) return false;
  const res = await sendPhotoToChat(user.telegramChatId, photo, caption, log, opts);
  return Boolean(res);
}

// ---- Telegram-based CAPTCHA Reconnect State Machine ----
const RECONNECT_STATE_NAME = 'QUMS_RECONNECT_WAITING_CAPTCHA';
const RECONNECT_TTL_MS = 5 * 60 * 1000; // 5 min TTL
const MAX_CAPTCHA_ATTEMPTS = 5;

// userId -> { state, chatId, attempts, maxAttempts, startedAt, expiresAt, timer, alertMessageId, captchaMessageId, submitting }
const reconnectStates = new Map();
// Synchronous guard sets for in-flight captcha regeneration to prevent concurrent browser spawns
const regeneratingChats = new Set();
const regeneratingUsers = new Set();

const TELEGRAM_SESSION_EXPIRED_TEXT = [
  '⚠️ *QUMS Session Expired*',
  '',
  'Your QUMS session has expired. Please reconnect to continue receiving attendance and assignment updates.',
].join('\n');

const MSG_INCORRECT_CAPTCHA = [
  '❌ *Incorrect CAPTCHA*',
  '',
  'Please try again.',
].join('\n');

const MSG_RECONNECT_CANCELLED = '❌ Reconnect cancelled.';
const MSG_TOO_MANY_ATTEMPTS = '❌ Too many failed attempts. Reconnect cancelled.';

function captchaKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '🔄 Regenerate CAPTCHA', callback_data: 'qums_regen_captcha' }],
      [{ text: '❌ Cancel Reconnect', callback_data: 'qums_cancel_reconnect' }],
    ],
  };
}

function setReconnectState(userId, data = {}, log = console) {
  if (!userId) return;
  const prev = reconnectStates.get(userId);
  if (prev && prev.timer) clearTimeout(prev.timer);

  const expiresAt = Date.now() + RECONNECT_TTL_MS;
  const timer = setTimeout(async () => {
    log.log(`[telegram-reconnect] reconnect session expired for user ${userId}`);
    await clearReconnectState(userId, log);
  }, RECONNECT_TTL_MS);

  reconnectStates.set(userId, {
    state: RECONNECT_STATE_NAME,
    chatId: data.chatId || (prev && prev.chatId),
    attempts: data.attempts !== undefined ? data.attempts : (prev ? prev.attempts : 0),
    maxAttempts: data.maxAttempts || MAX_CAPTCHA_ATTEMPTS,
    startedAt: data.startedAt || Date.now(),
    expiresAt,
    timer,
    alertMessageId: data.alertMessageId || (prev && prev.alertMessageId) || null,
    captchaMessageId: data.captchaMessageId || (prev && prev.captchaMessageId) || null,
    userMessageIds: data.userMessageIds || (prev && prev.userMessageIds) || [],
    submitting: false,
  });
}

function getReconnectState(userId) {
  if (!userId) return null;
  const s = reconnectStates.get(userId);
  if (!s) return null;
  if (Date.now() > s.expiresAt) {
    clearReconnectState(userId);
    return null;
  }
  return s;
}

function isWaitingCaptcha(userId) {
  const s = getReconnectState(userId);
  return Boolean(s && s.state === RECONNECT_STATE_NAME);
}

async function clearReconnectState(userId, log = console) {
  const s = reconnectStates.get(userId);
  if (!s) return;
  if (s.timer) clearTimeout(s.timer);
  reconnectStates.delete(userId);

  try {
    const qumsLogin = require('./qums-login-web');
    if (typeof qumsLogin.disposePending === 'function') {
      await qumsLogin.disposePending(userId);
    }
  } catch (err) {
    log.log(`[telegram-reconnect] clearReconnectState dispose warning: ${err.message}`);
  }
}

/**
 * Initiates the Telegram CAPTCHA-only reconnect flow for a user whose QUMS session expired.
 */
async function startTelegramCaptchaReconnect(userId, log = console, opts = {}) {
  if (!userId) return { ok: false, error: 'no-user' };
  const user = await db.getUserById(userId);
  if (!user || !user.telegramChatId) return { ok: false, error: 'not-linked' };

  const savedEncrypted = user.qumsPasswordEncrypted || (await db.getQumsEncryptedPassword(userId));
  if (!user.qumsQid || !savedEncrypted) {
    log.log(`[telegram-reconnect] user ${userId} has no saved QUMS credentials`);
    return { ok: false, error: 'no-credentials' };
  }

  // Clear any existing reconnect state
  await clearReconnectState(userId, log);

  let alertMsgId = opts.alertMessageId || null;
  if (!alertMsgId) {
    const expiryState = await db.getSessionExpiryState(userId).catch(() => null);
    if (expiryState && expiryState.telegramMessageId) {
      alertMsgId = expiryState.telegramMessageId;
    }
  }

  if (!alertMsgId && !opts.skipAlertText) {
    const alertOpts = {};
    await sendMessage(userId, TELEGRAM_SESSION_EXPIRED_TEXT, log, alertOpts);
    alertMsgId = alertOpts.messageId || null;
  }

  try {
    const qumsLogin = require('./qums-login-web');
    const res = await qumsLogin.startQumsLogin(userId, undefined, log);
    if (!res || !res.captchaImage) {
      throw new Error('No captcha image returned from QUMS login');
    }

    const photoOpts = { replyMarkup: captchaKeyboard() };
    await sendPhoto(userId, res.captchaImage, '', log, photoOpts);
    const captchaMsgId = photoOpts.messageId || null;
    if (captchaMsgId && user.telegramChatId) {
      scheduleAutoDelete(user.telegramChatId, captchaMsgId, AUTO_DELETE_DELAY_MS, log);
    }

    setReconnectState(userId, {
      chatId: user.telegramChatId,
      alertMessageId: alertMsgId,
      captchaMessageId: captchaMsgId,
      attempts: 0,
    }, log);

    return { ok: true, alertMessageId: alertMsgId, captchaMessageId: captchaMsgId };
  } catch (err) {
    log.error(`[telegram-reconnect] failed to start QUMS login for user ${userId}: ${err.message}`);
    const errCode = (err.code === 'CONCURRENT_LOGIN_LIMIT' || err.name === 'ConcurrentLoginError')
      ? 'concurrent-limit'
      : (err.code || err.name || err.message);
    return { ok: false, error: errCode, alertMessageId: alertMsgId };
  }
}

/**
 * Handle incoming user text messages (processes CAPTCHA when user is in reconnect state).
 */
async function handleUserMessage(msg, log = console) {
  if (!msg || !msg.text) return;
  const text = msg.text.trim();
  if (isDuplicateUpdate(msg)) return;

  const chatId = msg.chat && msg.chat.id;
  if (!chatId) return;

  const lower = text.toLowerCase();

  // Auto-delete incoming command messages after 1 minute, except for /assignments
  if (msg.message_id && !/^\/assignments(?:@\w+)?/i.test(text) && !['assignment', 'assignments'].includes(lower)) {
    scheduleAutoDelete(chatId, msg.message_id, AUTO_DELETE_DELAY_MS, log);
  }

  if (/^\/reconnect(?:@\w+)?/i.test(text) || lower === 'reconnect') {
    await handleReconnectCommand(chatId, log);
    return;
  }

  if (/^\/attend[ae]nce(?:@\w+)?/i.test(text) || ['attendance', 'attendence'].includes(lower)) {
    await handleAttendance(chatId, log);
    return;
  }

  if (/^\/today(?:@\w+)?/i.test(text) || ['today', 'timetable', 'classes', 'schedule'].includes(lower)) {
    await handleToday(chatId, log);
    return;
  }

  if (/^\/assignments(?:@\w+)?/i.test(text) || ['assignment', 'assignments'].includes(lower)) {
    await handleAssignments(chatId, log);
    return;
  }

  if (/^\/status(?:@\w+)?/i.test(text) || lower === 'status') {
    await handleStatus(chatId, log);
    return;
  }

  if (/^\/help(?:@\w+)?/i.test(text) || ['help', 'hi', 'hello', 'hey'].includes(lower)) {
    await handleHelp(chatId, log);
    return;
  }

  const startMatch = text.match(/^\/start(?:@\w+)?(?:\s+(\S+))?/i);
  if (startMatch) {
    await handleStart(chatId, startMatch[1], log);
    return;
  }

  const linkMatch = text.match(/^\/link(?:@\w+)?(?:\s+(\S+))?/i);
  if (linkMatch) {
    await handleLinkCommand(chatId, linkMatch[1], log);
    return;
  }

  if (text.startsWith('/')) {
    await reply(chatId, `❓ Unknown command: ${text}\n\nSend /help to see all available commands.`, log);
    return;
  }

  // Strict multi-user mapping: only the user who owns this chat
  const user = await db.getUserByTelegramChatId(chatId);
  if (!user) return;

  if (!isWaitingCaptcha(user.id)) {
    // User is not in reconnect mode and text was not a recognized greeting/command — ignore
    return;
  }

  const rState = getReconnectState(user.id);
  if (!rState) return;

  if (rState.submitting || regeneratingUsers.has(user.id)) {
    return; // avoid parallel submissions or submitting while regenerating
  }

  // Rate limiting / brute-force protection
  if (rState.attempts >= rState.maxAttempts) {
    await clearReconnectState(user.id, log);
    await reply(chatId, MSG_TOO_MANY_ATTEMPTS, log);
    return;
  }

  if (msg.message_id) {
    if (!rState.userMessageIds) rState.userMessageIds = [];
    if (!rState.userMessageIds.includes(msg.message_id)) {
      rState.userMessageIds.push(msg.message_id);
    }
  }

  rState.submitting = true;
  rState.attempts += 1;

  try {
    const qumsLogin = require('./qums-login-web');
    const result = await qumsLogin.submitQumsCaptcha(user.id, text, log);

    if (result && result.ok) {
      log.log(`[telegram-reconnect] ✅ CAPTCHA validated successfully for user ${user.id}`);
      const oldCaptchaMsgId = rState.captchaMessageId;
      const userMsgIds = [...(rState.userMessageIds || [])];
      if (msg.message_id && !userMsgIds.includes(msg.message_id)) {
        userMsgIds.push(msg.message_id);
      }
      await clearReconnectState(user.id, log);

      // Clean up the captcha photo message from chat on successful reconnect
      if (oldCaptchaMsgId) {
        await deleteMessage(user.id, oldCaptchaMsgId, log).catch(() => {});
      }

      // Clean up the user's typed captcha message(s) from chat on successful reconnect
      for (const uMsgId of userMsgIds) {
        await deleteMessage(user.id, uMsgId, log).catch(() => {});
      }

      // Note: submitQumsCaptcha -> runReconnectCatchup -> notifyQumsReconnected
      // sends "✅ QUMS Reconnected", deletes the old session-expired alert, and schedules auto-delete after 1 min!
      return;
    }

    // Wrong CAPTCHA
    log.log(`[telegram-reconnect] ❌ Incorrect CAPTCHA for user ${user.id} (attempt ${rState.attempts}/${rState.maxAttempts})`);

    if (rState.attempts >= rState.maxAttempts) {
      await clearReconnectState(user.id, log);
      await reply(chatId, MSG_TOO_MANY_ATTEMPTS, log);
      return;
    }

    // Send incorrect captcha message
    await reply(chatId, MSG_INCORRECT_CAPTCHA, log);

    // Provide the new captcha image
    if (result && result.captchaImage) {
      const photoOpts = { replyMarkup: captchaKeyboard() };
      await sendPhoto(user.id, result.captchaImage, '', log, photoOpts);
      rState.captchaMessageId = photoOpts.messageId || null;
      if (rState.captchaMessageId && chatId) {
        scheduleAutoDelete(chatId, rState.captchaMessageId, AUTO_DELETE_DELAY_MS, log);
      }
      setReconnectState(user.id, {
        chatId,
        attempts: rState.attempts,
        alertMessageId: rState.alertMessageId,
        captchaMessageId: rState.captchaMessageId,
      }, log);
    }
  } catch (err) {
    log.error(`[telegram-reconnect] captcha submission error for user ${user.id}: ${err.message}`);
    await reply(chatId, MSG_INCORRECT_CAPTCHA, log);
  } finally {
    if (reconnectStates.has(user.id)) {
      reconnectStates.get(user.id).submitting = false;
    }
  }
}

/**
 * Handle inline button clicks (🔄 Regenerate CAPTCHA, ❌ Cancel Reconnect).
 */
async function handleCallbackQuery(query, log = console) {
  if (!query || !query.data) return;
  const bot = state.bot;
  const data = String(query.data).trim();

  if (data !== 'qums_regen_captcha' && data !== 'qums_cancel_reconnect' && data !== 'qums_start_reconnect') {
    if (bot && typeof bot.answerCallbackQuery === 'function') {
      await bot.answerCallbackQuery(query.id).catch(() => {});
    }
    return;
  }

  const chatId = (query.message && query.message.chat && query.message.chat.id) || (query.from && query.from.id);
  if (!chatId) {
    if (bot && typeof bot.answerCallbackQuery === 'function') {
      await bot.answerCallbackQuery(query.id).catch(() => {});
    }
    return;
  }

  const chatKey = String(chatId);
  if (data === 'qums_regen_captcha') {
    // Synchronous mutex check: immediately reject concurrent clicks from same chat
    if (regeneratingChats.has(chatKey)) {
      if (bot && typeof bot.answerCallbackQuery === 'function') {
        await bot.answerCallbackQuery(query.id, { text: '⏳ Regeneration already in progress, please wait...' }).catch(() => {});
      }
      return;
    }
    regeneratingChats.add(chatKey);
    if (bot && typeof bot.answerCallbackQuery === 'function') {
      await bot.answerCallbackQuery(query.id, { text: '⏳ Regenerating CAPTCHA...' }).catch(() => {});
    }
  }

  let user = null;
  try {
    user = await db.getUserByTelegramChatId(chatId);
  } catch {
    if (data === 'qums_regen_captcha') regeneratingChats.delete(chatKey);
    return;
  }

  if (!user) {
    if (data === 'qums_regen_captcha') regeneratingChats.delete(chatKey);
    if (bot && typeof bot.answerCallbackQuery === 'function') {
      await bot.answerCallbackQuery(query.id).catch(() => {});
    }
    return;
  }

  if (data === 'qums_start_reconnect') {
    if (bot && typeof bot.answerCallbackQuery === 'function') {
      await bot.answerCallbackQuery(query.id, { text: 'Starting QUMS reconnect...' }).catch(() => {});
    }
    const alertMsgId = (query.message && query.message.message_id) || null;
    const started = await startTelegramCaptchaReconnect(user.id, log, { alertMessageId: alertMsgId });
    if (!started || !started.ok) {
      if (started && (started.error === 'concurrent-limit' || started.error === 'CONCURRENT_LOGIN_LIMIT')) {
        await reply(chatId, '⏳ Another reconnect is currently in progress. Please wait a moment and tap Reconnect again.', log);
      } else {
        await reply(chatId, '⚠️ Unable to start Telegram reconnect. Please reconnect via the dashboard or ensure your QUMS credentials are saved.', log);
      }
    }
    return;
  }

  if (data === 'qums_cancel_reconnect') {
    if (bot && typeof bot.answerCallbackQuery === 'function') {
      await bot.answerCallbackQuery(query.id, { text: 'Reconnect cancelled' }).catch(() => {});
    }
    log.log(`[telegram-reconnect] reconnect cancelled by user ${user.id}`);
    const rState = getReconnectState(user.id);
    const oldCaptchaMsgId = (rState && rState.captchaMessageId) || (query.message && query.message.message_id) || null;
    await clearReconnectState(user.id, log);
    if (oldCaptchaMsgId) {
      await deleteMessage(user.id, oldCaptchaMsgId, log).catch(() => {});
    }
    await reply(chatId, MSG_RECONNECT_CANCELLED, log);
    return;
  }

  if (data === 'qums_regen_captcha') {
    regeneratingUsers.add(user.id);
    log.log(`[telegram-reconnect] regenerating captcha for user ${user.id}`);

    const rState = getReconnectState(user.id);
    const prevAttempts = rState ? rState.attempts : 0;
    const prevAlertMsgId = rState ? rState.alertMessageId : null;
    const oldCaptchaMsgId = (rState && rState.captchaMessageId) || (query.message && query.message.message_id) || null;
    const prevUserMsgIds = rState ? (rState.userMessageIds || []) : [];

    let statusMsgId = null;
    try {
      const qumsLogin = require('./qums-login-web');
      // Dispose old browser instance for this user so fresh/reloaded page gets clean state
      if (typeof qumsLogin.disposePending === 'function') {
        await qumsLogin.disposePending(user.id).catch(() => {});
      }

      // Visual feedback: notify chat immediately so user knows bot is actively generating
      const statusMsg = await reply(chatId, '⏳ Generating a fresh CAPTCHA, please wait a moment...', log);
      if (statusMsg && statusMsg.message_id) {
        statusMsgId = statusMsg.message_id;
      }

      const res = await qumsLogin.startQumsLogin(user.id, undefined, log);
      if (!res || !res.captchaImage) {
        throw new Error('Failed to capture regenerated CAPTCHA');
      }

      // Delete temporary status message
      if (statusMsgId) {
        await deleteMessage(user.id, statusMsgId, log).catch(() => {});
        statusMsgId = null;
      }

      // Delete old captcha photo so user doesn't confuse the old one
      if (oldCaptchaMsgId) {
        await deleteMessage(user.id, oldCaptchaMsgId, log).catch(() => {});
      }

      const photoOpts = { replyMarkup: captchaKeyboard() };
      await sendPhoto(user.id, res.captchaImage, '', log, photoOpts);
      if (photoOpts.messageId && chatId) {
        scheduleAutoDelete(chatId, photoOpts.messageId, AUTO_DELETE_DELAY_MS, log);
      }

      setReconnectState(user.id, {
        chatId,
        attempts: prevAttempts,
        alertMessageId: prevAlertMsgId,
        captchaMessageId: photoOpts.messageId || null,
        userMessageIds: prevUserMsgIds,
      }, log);
    } catch (err) {
      log.error(`[telegram-reconnect] failed to regenerate captcha for user ${user.id}: ${err.message}`);
      if (statusMsgId) {
        await deleteMessage(user.id, statusMsgId, log).catch(() => {});
      }
      if (err.name === 'ConcurrentLoginError' || err.code === 'CONCURRENT_LOGIN_LIMIT') {
        await reply(chatId, '⏳ Another reconnect is currently in progress. Please wait a moment and tap Regenerate again.', log);
      } else {
        await reply(chatId, '❌ Could not regenerate CAPTCHA. Please try again in a few moments.', log);
      }
    } finally {
      regeneratingChats.delete(chatKey);
      regeneratingUsers.delete(user.id);
    }
    return;
  }
}

/** Send-only bot (no polling) — standalone workers / second instances ke liye. */
function ensureSendOnlyBot(log = console) {
  if (!state.bot) {
    state.bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN);
    state.sendOnly = true;
    log.log('[telegram] send-only bot created (is process me polling NAHI chalti).');
  }
  return state.bot;
}

/**
 * Chat reply — bot na hone par crash nahi, sirf log + skip.
 * Automatically schedules 1-minute auto-deletion by default,
 * UNLESS autoDelete is explicitly set to false (e.g. for assignments).
 */
async function reply(chatId, text, log = console, opts = {}) {
  if (!state.bot) {
    log.error('[telegram] reply skipped — bot is not initialised in this process.');
    return false;
  }
  const sentMsg = await state.bot.sendMessage(chatId, text);
  const shouldAutoDelete = !opts || opts.autoDelete !== false;
  const messageId = (sentMsg && typeof sentMsg === 'object' && sentMsg.message_id) ? sentMsg.message_id : null;
  if (shouldAutoDelete && messageId) {
    const delayMs = (opts && typeof opts.delayMs === 'number') ? opts.delayMs : AUTO_DELETE_DELAY_MS;
    scheduleAutoDelete(chatId, messageId, delayMs, log);
  }
  return sentMsg;
}

// ---- exactly-once: dobara deliver hua update ignore karo ----
const DEDUPE_WINDOW_MS = 10 * 60 * 1000; // restart-redelivery window
const DEDUPE_MAX_KEYS = 1000;

/**
 * Same Telegram update dobara aaya? (chatId + message_id unique hota hai)
 * Pehli baar -> false (aage process karo). Dobara -> true (silently ignore).
 */
function isDuplicateUpdate(msg) {
  const chatId = msg && msg.chat ? msg.chat.id : undefined;
  const messageId = msg ? msg.message_id : undefined;
  if (chatId === undefined || chatId === null || messageId === undefined || messageId === null) return false;
  const key = `${chatId}:${messageId}`;
  const now = Date.now();
  if (state.seenMessages.has(key)) return true;
  state.seenMessages.set(key, now);
  if (state.seenMessages.size > DEDUPE_MAX_KEYS) {
    for (const [k, ts] of state.seenMessages) {
      if (now - ts > DEDUPE_WINDOW_MS) state.seenMessages.delete(k);
    }
    while (state.seenMessages.size > DEDUPE_MAX_KEYS) {
      state.seenMessages.delete(state.seenMessages.keys().next().value);
    }
  }
  return false;
}

// ---- machine-level single-poller lock (pid based) ----
const LOCK_FILE = process.env.TELEGRAM_POLLING_LOCK
  ? path.resolve(process.env.TELEGRAM_POLLING_LOCK)
  : path.join(__dirname, '..', 'data', 'telegram-polling.lock');

function readLockFile() {
  try {
    return JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function pidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0 || n === process.pid) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // zinda hai par humein signal ka haq nahi
  }
}

/** true = polling arm karo; false = koi aur zinda poller hai (send-only rakho). */
function acquirePollingLock(log) {
  const existing = readLockFile();
  if (existing && pidAlive(existing.pid)) {
    log.error(`[telegram] ⚠️ polling SKIPPED — pid ${existing.pid} (since ${existing.startedAt}) already polls @${BOT_USERNAME} on this machine. Do pollers = duplicate /start replies. Us process ko kill karo ya wahan TELEGRAM_POLLING=off set karo.`);
    return false;
  }
  try {
    fs.mkdirSync(path.dirname(LOCK_FILE), { recursive: true });
    fs.writeFileSync(LOCK_FILE, `${JSON.stringify({ pid: process.pid, bot: BOT_USERNAME, startedAt: new Date().toISOString() }, null, 2)}\n`);
    state.lockPid = process.pid;
    return true;
  } catch (err) {
    // Lock likha na gaya (read-only fs) -> polling continue, par is host pe
    // exactly ek process chalna chahiye. Stale lock (killed process) auto-steal
    // hota hai kyunki pidAlive() false dega.
    log.error(`[telegram] polling lock write failed (${err.message}) — ensure only ONE polling process on this host.`);
    return true;
  }
}

function releasePollingLock() {
  if (state.lockPid !== process.pid) return;
  try {
    const cur = readLockFile();
    if (!cur || Number(cur.pid) === process.pid) fs.unlinkSync(LOCK_FILE);
  } catch {}
  state.lockPid = null;
}

/** TELEGRAM_POLLING=off/false/0 -> is process me koi getUpdates nahi (send-only). */
function pollingEnabled() {
  const v = String(process.env.TELEGRAM_POLLING || '').trim().toLowerCase();
  return !['off', 'false', '0', 'no', 'disable', 'disabled'].includes(v);
}

// ---- linking handlers (deep-link primary, /link backup, /status info) ----

/**
 * "/start <linkCode>" — deep-link flow ka core. Returns linked user ya null.
 * Multi-user isolation: code se EXACT wahi user milta hai (latest/global nahi).
 */
async function handleDeepLink(chatId, payload, log = console) {
  const code = String(payload || '').trim();
  const user = code ? await db.getUserByTelegramLinkCode(code) : null;
  if (!user) {
    // Sirf genuinely unknown/expired code par. Duplicate valid update yahan
    // kabhi nahi aata (wo dedupe ya "Already Connected" path me hai).
    await reply(chatId, MSG.LINK_INVALID, log);
    return null;
  }
  // Same chat pehle se ISI account se linked hai? -> "Already Connected!"
  const existingOwner = await db.getUserByTelegramChatId(chatId);
  const alreadyLinkedToThisUser = Boolean(existingOwner && existingOwner.id === user.id);
  // PRIVACY: ek chat sirf EK account ke updates ke liye — agar ye chat pehle
  // kisi aur account se linked thi to wo binding clear (us user ke updates is
  // chat pe aana band).
  const previousOwnerCleared = await db.clearTelegramChatForChat(chatId, user.id);
  await db.setTelegramChatId(user.id, chatId);
  // Greeting uses the student's QUMS/ERP name (users.studentName, fetched from
  // GetStudentDetailOnRegID) — NEVER the email or any QUMS credential.
  let helloName = user.studentName;
  if (!helloName && user.qumsSessionPath) {
    try {
      const fetched = await Promise.race([
        require('./scraper').ensureStudentName(user.id, log),
        new Promise((resolve) => setTimeout(() => resolve(null), 3000)),
      ]);
      if (fetched) helloName = fetched;
    } catch {
      /* scraper unavailable — greeting falls back to a neutral placeholder */
    }
  }
  helloName = helloName || user.studentName || 'Student';
  if (alreadyLinkedToThisUser) {
    await reply(chatId, MSG.alreadyConnected(helloName), log);
  } else {
    const rebindNote = previousOwnerCleared
      ? '\n(Note: this chat was previously linked to another account — it will now only receive updates for this account.)'
      : '';
    await reply(chatId, `${MSG.connected(helloName)}${rebindNote}`, log);
  }
  log.log(`[telegram] 🔗 linked: ${user.email} -> chat ${chatId}${previousOwnerCleared ? ` (rebind: ${previousOwnerCleared} purana binding clear)` : ''}${alreadyLinkedToThisUser ? ' (already-linked)' : ''}`);
  return user;
}

/** Plain "/start" -> welcome or user dashboard. Deep-link "/start <code>" -> handleDeepLink. */
async function handleStart(chatId, payload, log = console) {
  if (!payload) {
    const user = await db.getUserByTelegramChatId(chatId);
    if (user) {
      const name = user.studentName || 'Student';
      const text = [
        `👋 Welcome back, *${name}*!`,
        '',
        'Here are the commands you can use:',
        '📊 /attendance — Check your overall attendance & 75% margin (auto-deletes in 1 min)',
        '📅 /today — View today\'s class timetable & status (auto-deletes in 1 min)',
        '📚 /assignments — View pending assignments & deadlines',
        'ℹ️ /status — Check account connection status',
        '🔄 /reconnect — Reconnect QUMS session',
        '❓ /help — Detailed help & commands list',
        AUTO_DELETE_FOOTNOTE.trim(),
      ].join('\n');
      await reply(chatId, text, log);
      return;
    }
    await reply(chatId, MSG.WELCOME, log);
    return;
  }
  await handleDeepLink(chatId, payload, log);
}

/** Backup command: "/link <linkCode>" */
async function handleLinkCommand(chatId, code, log = console) {
  if (!code) {
    await reply(chatId, MSG.LINK_USAGE, log);
    return;
  }
  await handleDeepLink(chatId, code, log);
}

async function handleStatus(chatId, log = console) {
  const user = await db.getUserByTelegramChatId(chatId);
  if (user) {
    const name = user.studentName || 'Student';
    const qid = user.qumsQid || 'Not set';
    const sessionActive = user.qumsSessionStatus === 'active' && Boolean(user.qumsSessionPath && fs.existsSync(user.qumsSessionPath));
    const sessionStatusText = sessionActive
      ? 'Active & Monitored ✅'
      : (user.qumsSessionPath ? 'Expired / Needs Reconnect ⚠️ (send /reconnect)' : 'Setup pending ⚠️');

    const lines = [
      'ℹ️ *Account Status*',
      '',
      `👤 Student: ${name}`,
      `🎓 QID: ${qid}`,
      `📡 Monitoring: ${sessionActive ? 'Active ✅' : 'Paused ⚠️'}`,
      `🔐 QUMS Session: ${sessionStatusText}`,
    ];
    if (!sessionActive && (user.qumsPasswordEncrypted || user.qumsQid)) {
      lines.push('');
      lines.push('💡 _Send /reconnect to restore your session via Telegram._');
    }
    lines.push(AUTO_DELETE_FOOTNOTE.trim());
    await reply(chatId, lines.join('\n'), log);
  } else {
    await reply(chatId, MSG.STATUS_NONE, log);
  }
  log.log(`[telegram] /status from chat ${chatId}`);
}

async function handleHelp(chatId, log = console) {
  const user = await db.getUserByTelegramChatId(chatId);
  const name = user?.studentName ? `Hello *${user.studentName}*! 👋\n\n` : '';
  const text = [
    `${name}Welcome to the *QAttend Bot*!`,
    '',
    'Available commands:',
    '📊 /attendance — Full attendance summary (auto-deletes in 1 minute)',
    '📅 /today — Today\'s attendance status: Present/Absent breakdown (auto-deletes in 1 minute)',
    '📚 /assignments — View pending assignments & deadlines',
    'ℹ️ /status — Check your QUMS & Telegram account status',
    '🔄 /reconnect — Reconnect your QUMS session via Telegram (CAPTCHA)',
    '❓ /help — Show this help message',
    '',
    '💡 *Automatic Notifications:*',
    '• Daily morning schedule is sent at 8:30 AM IST with room & teacher info.',
    '• Real-time alerts when teachers enter or change attendance marks during college hours.',
    '• New assignment alerts and deadline reminders.',
    AUTO_DELETE_FOOTNOTE.trim(),
  ].join('\n');
  await reply(chatId, text, log);
}

async function handleAttendance(chatId, log = console) {
  const user = await db.getUserByTelegramChatId(chatId);
  if (!user) {
    await reply(chatId, MSG.STATUS_NONE, log);
    return;
  }

  if (!user.qumsQid || !user.qumsSessionPath) {
    await reply(chatId, '⚠️ *QUMS Setup Pending*\n\nPlease complete QUMS setup on the web dashboard first to view your attendance.', log);
    return;
  }

  if (user.qumsSessionStatus === 'expired') {
    await reply(chatId, '⚠️ *QUMS Session Expired*\n\nYour QUMS session has expired. Send /reconnect to log in again via Telegram.', log);
    return;
  }

  try {
    const { resolveUserRuntime } = require('./credentials');
    const runtime = resolveUserRuntime(user);
    const { scrapeAttendance } = require('./scraper');
    const { analyzeAttendance } = require('./calculator');
    const { formatAttendanceMessage } = require('./messages');

    const subjects = await scrapeAttendance({
      sessionPath: runtime.sessionPath,
      yearSem: user.qumsYearSem,
      studentName: user.studentName,
    });
    const analysis = analyzeAttendance(subjects);
    let text = formatAttendanceMessage(analysis);
    text += AUTO_DELETE_FOOTNOTE;

    const sentMsg = await reply(chatId, text, log);
    const messageId = (sentMsg && typeof sentMsg === 'object' && sentMsg.message_id) ? sentMsg.message_id : null;
    if (messageId) {
      scheduleAutoDelete(chatId, messageId, AUTO_DELETE_DELAY_MS, log);
    }
  } catch (err) {
    log.error(`[telegram] /attendance failed for user ${user.id}: ${err.message}`);
    if (err.name === 'SessionExpiredError' || /session expired/i.test(err.message)) {
      await db.markSessionExpired(user.id).catch(() => {});
      const sentMsg = await reply(chatId, `⚠️ *QUMS Session Expired*\n\nYour QUMS session has expired. Send /reconnect to log in again via Telegram.${AUTO_DELETE_FOOTNOTE}`, log);
      const messageId = (sentMsg && typeof sentMsg === 'object' && sentMsg.message_id) ? sentMsg.message_id : null;
      if (messageId) {
        scheduleAutoDelete(chatId, messageId, AUTO_DELETE_DELAY_MS, log);
      }
    } else {
      const known = await db.listKnownAttendance(user.id).catch(() => []);
      if (known && known.length > 0) {
        const subMap = new Map();
        for (const k of known) {
          const s = k.subject || k.subjectCode || 'Subject';
          if (!subMap.has(s)) subMap.set(s, { total: 0, present: 0 });
          const entry = subMap.get(s);
          entry.total += 1;
          if (k.status === 'present') entry.present += 1;
        }
        const lines = ['📊 *Latest Recorded Attendance (Offline Cache)*', ''];
        for (const [sub, st] of subMap) {
          const pct = Math.round((st.present / st.total) * 100);
          const icon = pct >= 75 ? '✅' : '⚠️';
          lines.push(`${icon} *${sub}*: ${st.present}/${st.total} (${pct}%)`);
        }
        lines.push('');
        lines.push('_Live QUMS portal is temporarily unreachable or session expired._');
        lines.push('Send /reconnect if your session needs refreshing.');
        lines.push(AUTO_DELETE_FOOTNOTE);
        const sentMsg = await reply(chatId, lines.join('\n'), log);
        const messageId = (sentMsg && typeof sentMsg === 'object' && sentMsg.message_id) ? sentMsg.message_id : null;
        if (messageId) {
          scheduleAutoDelete(chatId, messageId, AUTO_DELETE_DELAY_MS, log);
        }
      } else {
        const sentMsg = await reply(chatId, `⚠️ Could not fetch attendance: ${err.message}\nSend /reconnect to refresh your session.${AUTO_DELETE_FOOTNOTE}`, log);
        const messageId = (sentMsg && typeof sentMsg === 'object' && sentMsg.message_id) ? sentMsg.message_id : null;
        if (messageId) {
          scheduleAutoDelete(chatId, messageId, AUTO_DELETE_DELAY_MS, log);
        }
      }
    }
  }
}

async function handleToday(chatId, log = console) {
  const user = await db.getUserByTelegramChatId(chatId);
  if (!user) {
    await reply(chatId, MSG.STATUS_NONE, log);
    return;
  }

  try {
    const { resolveUserRuntime } = require('./credentials');
    const { scrapeTodaysAttendance, scrapeTimetable, getTimetableForDate, mergeScheduleWithRoom } = require('./scraper');
    const { formatTodayAttendanceStatus } = require('./messages');

    let rows = [];
    if (user.qumsQid && user.qumsSessionPath && user.qumsSessionStatus !== 'expired') {
      try {
        const runtime = resolveUserRuntime(user);
        if (fs.existsSync(runtime.sessionPath)) {
          const liveRows = await scrapeTodaysAttendance({ sessionPath: runtime.sessionPath });
          let timetablePeriods = [];
          try {
            const timetable = await scrapeTimetable({ sessionPath: runtime.sessionPath });
            timetablePeriods = getTimetableForDate(timetable, new Date());
          } catch {
            timetablePeriods = [];
          }

          if (liveRows && liveRows.length) {
            rows = mergeScheduleWithRoom(liveRows, timetablePeriods);
          } else if (timetablePeriods && timetablePeriods.length) {
            rows = timetablePeriods.map((tp) => ({
              period: tp.period,
              duration: tp.duration,
              subject: tp.subject,
              subjectCode: tp.subjectCode,
              teacher: tp.teacher,
              room: tp.room,
              status: 'unmarked',
              attendance: 'N.M.',
            }));
          }
        }
      } catch (fetchErr) {
        log.log(`[telegram] live today scrape error: ${fetchErr.message}`);
        if (fetchErr.name === 'SessionExpiredError' || /session expired/i.test(fetchErr.message)) {
          await db.markSessionExpired(user.id).catch(() => {});
          const sentMsg = await reply(chatId, `⚠️ *QUMS Session Expired*\n\nYour QUMS session has expired. Send /reconnect to log in again via Telegram.${AUTO_DELETE_FOOTNOTE}`, log);
          const messageId = (sentMsg && typeof sentMsg === 'object' && sentMsg.message_id) ? sentMsg.message_id : null;
          if (messageId) {
            scheduleAutoDelete(chatId, messageId, AUTO_DELETE_DELAY_MS, log);
          }
          return;
        }
      }
    }

    if (!rows.length) {
      const now = new Date();
      const istDay = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' })).getDay();
      const dbSched = await db.getWeeklySchedule(user.id, istDay).catch(() => null);
      if (dbSched && dbSched.rows && dbSched.rows.length) {
        rows = dbSched.rows.map((r) => ({
          period: r.period,
          duration: r.duration || '',
          subject: r.subject,
          subjectCode: r.subjectCode,
          teacher: r.teacher,
          room: r.room,
          status: 'unmarked',
          attendance: 'N.M.',
        }));
      }
    }

    let text = formatTodayAttendanceStatus(rows, undefined, user.studentName);
    text += AUTO_DELETE_FOOTNOTE;

    const sentMsg = await reply(chatId, text, log);
    const messageId = (sentMsg && typeof sentMsg === 'object' && sentMsg.message_id) ? sentMsg.message_id : null;
    if (messageId) {
      scheduleAutoDelete(chatId, messageId, AUTO_DELETE_DELAY_MS, log);
    }
  } catch (err) {
    log.error(`[telegram] /today failed: ${err.message}`);
    const sentMsg = await reply(chatId, `⚠️ Could not load today's attendance: ${err.message}${AUTO_DELETE_FOOTNOTE}`, log);
    const messageId = (sentMsg && typeof sentMsg === 'object' && sentMsg.message_id) ? sentMsg.message_id : null;
    if (messageId) {
      scheduleAutoDelete(chatId, messageId, AUTO_DELETE_DELAY_MS, log);
    }
  }
}

async function handleAssignments(chatId, log = console) {
  const user = await db.getUserByTelegramChatId(chatId);
  if (!user) {
    await reply(chatId, MSG.STATUS_NONE, log);
    return;
  }

  try {
    const known = await db.listKnownAssignments(user.id);
    if (!known || !known.length) {
      await reply(chatId, '📚 *Assignments*\n\n🎉 No pending assignments recorded right now! You are all caught up.', log, { autoDelete: false });
      return;
    }
    const lines = ['📚 *Your Assignments*', ''];
    known.forEach((a, idx) => {
      lines.push(`${idx + 1}. *${a.subject || 'Subject'}*`);
      lines.push(`    ${a.title || 'Assignment'}`);
      if (a.deadlineYMD || a.lastDate) {
        lines.push(`    Due: ${a.deadlineYMD || a.lastDate}`);
      }
      lines.push('');
    });
    lines.push('🔗 Open QUMS portal to submit.');
    await reply(chatId, lines.join('\n'), log, { autoDelete: false });
  } catch (err) {
    log.error(`[telegram] /assignments failed: ${err.message}`);
    await reply(chatId, `⚠️ Could not load assignments: ${err.message}`, log);
  }
}

async function handleReconnectCommand(chatId, log = console) {
  const user = await db.getUserByTelegramChatId(chatId);
  if (!user) {
    await reply(chatId, MSG.STATUS_NONE, log);
    return;
  }
  const started = await startTelegramCaptchaReconnect(user.id, log);
  if (!started || !started.ok) {
    if (started && (started.error === 'concurrent-limit' || started.error === 'CONCURRENT_LOGIN_LIMIT')) {
      await reply(chatId, '⏳ Another reconnect is currently in progress. Please wait a moment and send /reconnect again.', log);
    } else {
      await reply(chatId, '⚠️ Unable to start Telegram reconnect. Please reconnect via the dashboard or ensure your QUMS credentials are saved.', log);
    }
  }
}

/**
 * Polling start — SINGLE authoritative entry point.
 *  - ek process me sirf EK baar chalti hai (state.initAttempted)
 *  - ek machine pe sirf EK poller (pid lock) — warna Telegram har update
 *    dono instances ko deta hai aur /start ka jawab DO baar jaata hai
 *  - token na ho to server crash na ho, sirf warning
 *  - iske andar hi `/start`, `/link`, `/status` register hote hain (aur kahin
 *    nahi) -> koi duplicate/legacy handler nahi.
 */
function initTelegram(log = console) {
  if (state.initAttempted) {
    // Duplicate init (koi module dobara call kare) -> kuch naya register nahi,
    // isliye "polling armed" sirf EK baar log hota hai.
    log.log('[telegram] initTelegram() ignored — polling/handlers already set up in this process.');
    return state.bot;
  }
  state.initAttempted = true;

  if (!isConfigured()) {
    log.log('[telegram] TELEGRAM_BOT_TOKEN .env me set nahi hai — Telegram DISABLED (server chalega, sends skip honge).');
    return null;
  }

  if (!pollingEnabled()) {
    log.log('[telegram] TELEGRAM_POLLING=off — polling SKIPPED (send-only instance; ise /start messages nahi milenge).');
    return ensureSendOnlyBot(log);
  }

  // Ek machine pe sirf EK poller — dusra process send-only rehta hai.
  if (!acquirePollingLock(log)) return ensureSendOnlyBot(log);

  // Agar is process me pehle se send-only bot bana hai to USI par polling
  // start karo — naya bot object banane se ek hi process me do getUpdates
  // consumers ban jaate (duplicate /start replies).
  if (!state.bot) {
    state.bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
  } else {
    state.sendOnly = false;
    if (typeof state.bot.startPolling === 'function') state.bot.startPolling();
    log.log('[telegram] existing bot instance reuse — polling usi par start hui (koi second bot nahi).');
  }
  const bot = state.bot;

  // Legacy text-listeners (agar kabhi register hue hon) hata do -> `/start` ka
  // SIRF EK authoritative handler rehta hai.
  if (typeof bot.clearTextListeners === 'function') bot.clearTextListeners();

  bot.on('polling_error', (err) => {
    const msg = String((err && err.message) || '');
    if (/409|conflict/i.test(msg)) {
      log.error(`[telegram] polling CONFLICT — koi dusra instance (@${BOT_USERNAME}) usi bot token se getUpdates kar raha hai, isliye ek /start ka jawab DO baar jaa sakta hai. Sirf EK poller chalao (dusre pe TELEGRAM_POLLING=off set karo ya usse kill karo). (${msg})`);
      return;
    }
    log.error(`[telegram] polling error: ${msg}`);
  });

  // ---- THE ONE AND ONLY /start handler ----
  bot.onText(/^\/start(?:@\w+)?(?:\s+(\S+))?/i, (msg, match) => {
    if (isDuplicateUpdate(msg)) {
      log.log('[telegram] duplicate /start update ignored (already processed).');
      return;
    }
    handleStart(msg.chat.id, match && match[1], log).catch((e) => log.error(`[telegram] /start failed: ${e.message}`));
  });
  bot.onText(/^\/link(?:@\w+)?(?:\s+(\S+))?/i, (msg, match) => {
    if (isDuplicateUpdate(msg)) return;
    handleLinkCommand(msg.chat.id, match && match[1], log).catch((e) => log.error(`[telegram] /link failed: ${e.message}`));
  });
  bot.onText(/^\/status(?:@\w+)?/i, (msg) => {
    if (isDuplicateUpdate(msg)) return;
    handleStatus(msg.chat.id, log).catch((e) => log.error(`[telegram] /status failed: ${e.message}`));
  });

  bot.on('message', (msg) => {
    handleUserMessage(msg, log).catch((e) => log.error(`[telegram] message handling failed: ${e.message}`));
  });

  bot.on('callback_query', (query) => {
    handleCallbackQuery(query, log).catch((e) => log.error(`[telegram] callback query failed: ${e.message}`));
  });

  state.pollingArmed = true;
  log.log(`[telegram] polling armed (@${BOT_USERNAME}) — handlers registered (pid ${process.pid}).`);
  restoreScheduledDeletions(log);
  return bot;
}

/**
 * Abhi send kyun block hoga? Accurate error ke liye:
 *   'not-configured'       -> .env me TELEGRAM_BOT_TOKEN nahi
 *   'bot-not-initialized'  -> token tha par polling start nahi hua (restart karo)
 *   'not-linked'           -> user ne Connect Telegram nahi kiya
 *   null                   -> send block nahi hoga
 */
async function sendBlockerReason(userId) {
  if (!isConfigured()) return 'not-configured';
  if (!state.bot) return 'bot-not-initialized';
  const user = userId ? await db.getUserById(userId) : null;
  if (!user || !user.telegramChatId) return 'not-linked';
  return null;
}

// Normal exit pe polling lock hata do (kill -9 hone par stale lock agle boot pe
// pid-check se auto-steal ho jaata hai).
process.on('exit', releasePollingLock);

module.exports = {
  initTelegram,
  isConfigured,
  isReady,
  getBotUsername,
  deepLink,
  sendMessage,
  deleteMessage,
  deleteMessageFromChat,
  scheduleAutoDelete,
  AUTO_DELETE_DELAY_MS,
  restoreScheduledDeletions,
  sendPhoto,
  sendPhotoToChat,
  startTelegramCaptchaReconnect,
  setReconnectState,
  getReconnectState,
  isWaitingCaptcha,
  clearReconnectState,
  handleUserMessage,
  handleCallbackQuery,
  captchaKeyboard,
  RECONNECT_STATE_NAME,
  MAX_CAPTCHA_ATTEMPTS,
  TELEGRAM_SESSION_EXPIRED_TEXT,
  MSG_INCORRECT_CAPTCHA,
  MSG_RECONNECT_CANCELLED,
  MSG_TOO_MANY_ATTEMPTS,
  sendBlockerReason,
  handleDeepLink,
  handleStart,
  handleLinkCommand,
  handleStatus,
  handleHelp,
  handleAttendance,
  handleToday,
  handleAssignments,
  handleReconnectCommand,
  toTelegramHtml,
  MSG,
  BOT_USERNAME,
};

// Standalone: token validity + linked users check (koi send nahi, koi polling nahi)
if (require.main === module) {
  (async () => {
    if (!isConfigured()) {
      console.error('[x] TELEGRAM_BOT_TOKEN .env me set nahi hai (BotFather se token le ke daalo).');
      process.exit(1);
    }
    try {
      const probe = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, {});
      const me = await probe.getMe();
      console.log(`[OK] Token valid — bot: @${me.username} (id ${me.id})`);
    } catch (err) {
      console.error('[x] Token INVALID:', err.message);
      process.exit(1);
    }
    const linked = (await db.allUsers()).filter((u) => u.telegramChatId);
    console.log(`Linked users: ${linked.length}`);
    linked.forEach((u) => console.log(`  - ${u.email} -> chat ${u.telegramChatId}`));
    process.exit(0);
  })().catch((err) => {
    console.error('[x]', err.message);
    process.exit(1);
  });
}
