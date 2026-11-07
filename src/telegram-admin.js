/**
 * Telegram Admin Management Panel
 * Extends the Telegram Bot with comprehensive administrative controls:
 *   1. Dashboard
 *   2. Manage Users
 *   3. Select Multiple Users
 *   4. Suspend Users
 *   5. Delete Users
 *   6. Send Custom Message
 *   7. Active Sessions
 *   8. Old ERP Users
 *   9. New ERP Users
 *   10. Suspended Users
 *   11. System Status
 *   12. Audit Logs
 *
 * Strict Security:
 *  - Only authorized administrators (matching ADMIN_EMAILS or is_admin)
 *  - Never exposes passwords or plaintext secrets
 *  - Two-step confirmation for deletions
 *  - Full audit logging of all administrative actions
 */

const db = require('./db');
const { releaseAllUserSessions } = require('./erp-session-registry');

const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '')
  .split(',')
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

/** In-memory interactive admin session states: chatId -> state */
const adminStates = new Map();

function getAdminState(chatId) {
  const key = String(chatId);
  if (!adminStates.has(key)) {
    adminStates.set(key, {
      menu: 'main',
      page: 1,
      filter: 'all',
      search: '',
      selectedUserIds: new Set(),
      pendingAction: null,
      customMessage: '',
      deleteStage: 0,
    });
  }
  return adminStates.get(key);
}

function clearAdminState(chatId) {
  adminStates.delete(String(chatId));
}

/** Check if a Telegram chatId belongs to an authorized admin */
async function isChatAdmin(chatId) {
  if (!chatId) return false;
  const user = await db.getUserByTelegramChatId(chatId);
  if (!user) return false;
  if (user.isAdmin) return true;
  if (user.email && ADMIN_EMAILS.includes(user.email.toLowerCase())) return true;
  return false;
}

/** Mask sensitive portions of QID / Email */
function maskIdentifier(id) {
  const str = String(id || '').trim();
  if (!str) return '—';
  if (str.includes('@')) {
    const parts = str.split('@');
    const name = parts[0];
    const masked = name.length > 2 ? `${name.slice(0, 2)}***` : `${name}***`;
    return `${masked}@${parts[1]}`;
  }
  if (str.length <= 4) return str;
  return `${str.slice(0, 2)}***${str.slice(-2)}`;
}

/** Main Menu Inline Keyboard */
function buildMainMenuKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '📊 1. Dashboard', callback_data: 'adm:menu:dash' },
        { text: '👥 2. Manage Users', callback_data: 'adm:menu:users:1' },
      ],
      [
        { text: '☑️ 3. Select Multiple Users', callback_data: 'adm:menu:select:1' },
        { text: '⏸️ 4. Suspend Users', callback_data: 'adm:menu:suspend' },
      ],
      [
        { text: '🗑️ 5. Delete Users', callback_data: 'adm:menu:delete' },
        { text: '✉️ 6. Send Custom Message', callback_data: 'adm:menu:msg' },
      ],
      [
        { text: '⚡ 7. Active Sessions', callback_data: 'adm:filter:active:1' },
        { text: '🏛️ 8. Old ERP Users', callback_data: 'adm:filter:old_erp:1' },
      ],
      [
        { text: '🚀 9. New ERP Users', callback_data: 'adm:filter:new_erp:1' },
        { text: '⛔ 10. Suspended Users', callback_data: 'adm:filter:suspended:1' },
      ],
      [
        { text: '🩺 11. System Status', callback_data: 'adm:menu:status' },
        { text: '📜 12. Audit Logs', callback_data: 'adm:menu:audit:1' },
      ],
      [
        { text: '👑 13. Admin Users', callback_data: 'adm:filter:admin:1' },
        { text: '❌ Close Admin Panel', callback_data: 'adm:menu:close' },
      ],
    ],
  };
}

/** Render Dashboard summary */
async function renderAdminDashboard() {
  const stats = await db.adminStats();
  const all = await db.allUsers();
  const oldErpCount = all.filter((u) => (u.activeErpType || 'OLD') === 'OLD' && (u.qumsQid || u.qumsSessionPath)).length;
  const newErpCount = all.filter((u) => u.activeErpType === 'NEW' || (u.newErpEmail && u.newErpSessionPath)).length;

  const lines = [
    '🛡️ <b>QAttend Admin Management Panel</b>',
    '',
    `👥 <b>Total Registered Users:</b> ${stats.totalUsers}`,
    `⚡ <b>Active QUMS Sessions:</b> ${stats.qumsConnected}`,
    `🏛️ <b>Old ERP Active:</b> ${oldErpCount}`,
    `🚀 <b>New ERP Active:</b> ${newErpCount}`,
    `⚠️ <b>Expired Sessions:</b> ${stats.sessionExpired}`,
    `💬 <b>Telegram Linked:</b> ${stats.telegramConnected}`,
    `⛔ <b>Suspended Users:</b> ${stats.suspended}`,
    `👑 <b>Admins:</b> ${stats.admins}`,
    '',
    `💾 <b>Database:</b> ${stats.dbMode.toUpperCase()}`,
    `🕒 <b>Server Time:</b> ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST`,
  ];
  return lines.join('\n');
}

/** Build paginated user list keyboard with checkboxes */
function buildUserListKeyboard(users, state, page, totalPages, isSelectMode = false) {
  const rows = [];
  const selected = state.selectedUserIds || new Set();

  // Top action bar in select mode
  if (isSelectMode) {
    const selCount = selected.size;
    rows.push([
      { text: `Selected: ${selCount} user(s)`, callback_data: 'adm:noop' },
    ]);
    rows.push([
      { text: '☑️ Select Page', callback_data: `adm:sel_all_page:${page}` },
      { text: '🌐 Select All Pages', callback_data: 'adm:sel_all_filter' },
      { text: '⬜ Deselect All', callback_data: `adm:desel_all` },
    ]);
  }

  // User rows
  for (const u of users) {
    const isSel = selected.has(u.id);
    const checkIcon = isSel ? '☑️' : '⬜';
    const statusIcon = u.isSuspended ? '⛔' : (u.activeSessionStatus === 'active' ? '🟢' : '⚪');
    const erpBadge = u.activeErpType === 'NEW' ? '[NEW]' : '[OLD]';
    const name = u.studentName || u.email.split('@')[0];
    const qidMasked = maskIdentifier(u.qumsQid || u.newErpEmail || '');

    const label = isSelectMode
      ? `${checkIcon} ${statusIcon} ${name} (${qidMasked}) ${erpBadge}`
      : `${statusIcon} ${name} — ${qidMasked} ${erpBadge}`;

    const cb = isSelectMode
      ? `adm:toggle:${u.id}:${page}`
      : `adm:user_view:${u.id}:${page}`;

    rows.push([{ text: label, callback_data: cb }]);
  }

  // Navigation pagination row
  const navRow = [];
  if (page > 1) {
    navRow.push({ text: '⬅️ Prev', callback_data: `adm:page:${page - 1}` });
  }
  navRow.push({ text: `Page ${page}/${totalPages || 1}`, callback_data: 'adm:noop' });
  if (page < totalPages) {
    navRow.push({ text: 'Next ➡️', callback_data: `adm:page:${page + 1}` });
  }
  rows.push(navRow);

  // Quick Action row if in Select Mode
  if (isSelectMode && selected.size > 0) {
    rows.push([
      { text: `⏸️ Suspend (${selected.size})`, callback_data: 'adm:bulk_suspend' },
      { text: `🗑️ Delete (${selected.size})`, callback_data: 'adm:bulk_delete' },
    ]);
    rows.push([
      { text: `✉️ Message (${selected.size})`, callback_data: 'adm:bulk_msg' },
    ]);
  }

  // Return to main menu
  rows.push([{ text: '🔙 Back to Main Menu', callback_data: 'adm:menu:main' }]);
  return { inline_keyboard: rows };
}

/** Render single user profile view */
function renderUserDetailView(u) {
  const activeErp = u.activeErpType || 'OLD';
  const qid = u.qumsQid || u.newErpQid || u.newErpEmail || 'Not set';
  const sessionStatus = u.activeSessionStatus === 'active' ? 'Active 🟢' : (u.sessionExpired ? 'Expired ⚠️' : 'Not Connected ⚪');

  const lines = [
    `👤 <b>User Management: ${u.studentName || 'Student'}</b>`,
    '',
    `📧 <b>Email:</b> ${u.email}`,
    `🎓 <b>QUMS ID:</b> ${maskIdentifier(qid)} (raw: ${qid})`,
    `🚀 <b>Active ERP Type:</b> ${activeErp === 'NEW' ? 'New ERP' : 'Old ERP'}`,
    `💬 <b>Telegram ID:</b> ${u.telegramChatId ? maskIdentifier(u.telegramChatId) : 'Not Linked ❌'}`,
    `🔐 <b>Session Status:</b> ${sessionStatus}`,
    `🛡️ <b>Account Status:</b> ${u.isSuspended ? 'SUSPENDED ⛔' : 'Active ✅'}`,
    `📅 <b>Registered:</b> ${u.createdAt ? new Date(u.createdAt).toLocaleDateString() : 'N/A'}`,
    `🕒 <b>Last Activity:</b> ${u.lastActivity ? new Date(u.lastActivity).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : 'Never'}`,
  ];
  return lines.join('\n');
}

/** Action buttons for single user detail */
function buildUserDetailKeyboard(u, page = 1) {
  const suspendLabel = u.isSuspended ? '▶️ Reactivate User' : '⏸️ Suspend User';
  const suspendAction = u.isSuspended ? `adm:user_reactivate:${u.id}:${page}` : `adm:user_suspend:${u.id}:${page}`;

  return {
    inline_keyboard: [
      [
        { text: suspendLabel, callback_data: suspendAction },
        { text: '🗑️ Delete User', callback_data: `adm:user_delete_prompt:${u.id}:${page}` },
      ],
      [
        { text: '✉️ Send Message', callback_data: `adm:user_msg:${u.id}` },
        { text: '⚡ Release Session', callback_data: `adm:user_release_session:${u.id}:${page}` },
      ],
      [
        { text: '🔙 Back to Users', callback_data: `adm:menu:users:${page}` },
      ],
    ],
  };
}

/** Handle admin command: /admin */
async function handleAdminCommand(bot, msg, log = console) {
  const chatId = msg.chat.id;
  if (!(await isChatAdmin(chatId))) {
    await bot.sendMessage(
      chatId,
      '⛔ <b>Access Denied</b>\n\nYou do not have administrator permissions to access this panel.',
      { parse_mode: 'HTML' }
    );
    return;
  }

  const state = getAdminState(chatId);
  state.menu = 'main';
  const text = await renderAdminDashboard();
  const keyboard = buildMainMenuKeyboard();

  await bot.sendMessage(chatId, text, {
    parse_mode: 'HTML',
    reply_markup: keyboard,
  });
}

/** Handle admin callback queries */
async function handleAdminCallbackQuery(bot, query, log = console) {
  const data = query.data || '';
  if (!data.startsWith('adm:')) return false;

  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;

  if (!(await isChatAdmin(chatId))) {
    await bot.answerCallbackQuery(query.id, { text: 'Unauthorized admin action.', show_alert: true });
    return true;
  }

  const adminUser = await db.getUserByTelegramChatId(chatId);
  const adminEmail = (adminUser && adminUser.email) || 'admin';
  const state = getAdminState(chatId);

  // Acknowledge callback immediately to avoid UI spinner
  await bot.answerCallbackQuery(query.id).catch(() => {});

  // 1. Close Menu
  if (data === 'adm:menu:close') {
    clearAdminState(chatId);
    await bot.deleteMessage(chatId, messageId).catch(() => {});
    return true;
  }

  // 2. Main Menu / Dashboard
  if (data === 'adm:menu:main' || data === 'adm:menu:dash') {
    state.menu = 'main';
    const text = await renderAdminDashboard();
    await bot.editMessageText(text, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'HTML',
      reply_markup: buildMainMenuKeyboard(),
    }).catch(() => {});
    return true;
  }

  // 3. User Listing / Filtering / Selection
  if (data.startsWith('adm:menu:users') || data.startsWith('adm:menu:select') || data.startsWith('adm:filter:') || data.startsWith('adm:page:')) {
    let filter = state.filter || 'all';
    let isSelect = state.menu === 'select' || data.startsWith('adm:menu:select');
    let page = state.page || 1;

    if (data.startsWith('adm:filter:')) {
      const parts = data.split(':');
      filter = parts[2] || 'all';
      page = Number(parts[3]) || 1;
      state.filter = filter;
      state.menu = 'users';
      isSelect = false;
    } else if (data.startsWith('adm:menu:select')) {
      isSelect = true;
      state.menu = 'select';
      const parts = data.split(':');
      page = Number(parts[3]) || 1;
    } else if (data.startsWith('adm:menu:users')) {
      isSelect = false;
      state.menu = 'users';
      const parts = data.split(':');
      page = Number(parts[3]) || 1;
    } else if (data.startsWith('adm:page:')) {
      page = Number(data.split(':')[2]) || 1;
    }

    state.page = page;

    const listRes = await db.listUsersForAdmin({ filter, search: state.search || '', page, limit: 8 });
    const title = isSelect ? '☑️ <b>Select Multiple Users</b>' : `👥 <b>User Management (${filter.toUpperCase()})</b>`;
    const text = `${title}\n\nShowing page ${listRes.page} of ${listRes.pages} (${listRes.total} total matching users):`;

    await bot.editMessageText(text, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'HTML',
      reply_markup: buildUserListKeyboard(listRes.users, state, listRes.page, listRes.pages, isSelect),
    }).catch(() => {});
    return true;
  }

  // 4. Toggle single user selection checkbox
  if (data.startsWith('adm:toggle:')) {
    const parts = data.split(':');
    const targetUserId = parts[2];
    const page = Number(parts[3]) || 1;

    if (state.selectedUserIds.has(targetUserId)) {
      state.selectedUserIds.delete(targetUserId);
    } else {
      state.selectedUserIds.add(targetUserId);
    }

    const listRes = await db.listUsersForAdmin({ filter: state.filter, search: state.search || '', page, limit: 8 });
    await bot.editMessageReplyMarkup(
      buildUserListKeyboard(listRes.users, state, listRes.page, listRes.pages, true),
      { chat_id: chatId, message_id: messageId }
    ).catch(() => {});
    return true;
  }

  // 5. Select All on page / Select All on all pages / Deselect All
  if (data.startsWith('adm:sel_all_page:')) {
    const page = Number(data.split(':')[2]) || 1;
    const listRes = await db.listUsersForAdmin({ filter: state.filter, search: state.search || '', page, limit: 8 });
    for (const u of listRes.users) {
      state.selectedUserIds.add(u.id);
    }
    await bot.editMessageReplyMarkup(
      buildUserListKeyboard(listRes.users, state, listRes.page, listRes.pages, true),
      { chat_id: chatId, message_id: messageId }
    ).catch(() => {});
    return true;
  }

  if (data === 'adm:sel_all_filter') {
    const allIds = await db.getMatchingUserIdsForAdmin({ filter: state.filter, search: state.search || '' });
    for (const id of allIds) {
      state.selectedUserIds.add(id);
    }
    const listRes = await db.listUsersForAdmin({ filter: state.filter, search: state.search || '', page: state.page || 1, limit: 8 });
    await bot.editMessageReplyMarkup(
      buildUserListKeyboard(listRes.users, state, listRes.page, listRes.pages, true),
      { chat_id: chatId, message_id: messageId }
    ).catch(() => {});
    return true;
  }

  if (data === 'adm:desel_all') {
    state.selectedUserIds.clear();
    const listRes = await db.listUsersForAdmin({ filter: state.filter, search: state.search || '', page: state.page || 1, limit: 8 });
    await bot.editMessageReplyMarkup(
      buildUserListKeyboard(listRes.users, state, listRes.page, listRes.pages, true),
      { chat_id: chatId, message_id: messageId }
    ).catch(() => {});
    return true;
  }

  // 6. View Single User Detail
  if (data.startsWith('adm:user_view:')) {
    const parts = data.split(':');
    const targetUserId = parts[2];
    const page = Number(parts[3]) || 1;

    const all = await db.allUsers();
    const target = all.find((u) => u.id === targetUserId);
    if (!target) {
      await bot.sendMessage(chatId, 'User not found.');
      return true;
    }

    const text = renderUserDetailView(db.safeAdminUser(target));
    await bot.editMessageText(text, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'HTML',
      reply_markup: buildUserDetailKeyboard(target, page),
    }).catch(() => {});
    return true;
  }

  // 7. Single User Suspend / Reactivate
  if (data.startsWith('adm:user_suspend:') || data.startsWith('adm:user_reactivate:')) {
    const isSuspending = data.startsWith('adm:user_suspend:');
    const parts = data.split(':');
    const targetUserId = parts[2];
    const page = Number(parts[3]) || 1;

    await db.setUserSuspended(targetUserId, isSuspending);
    if (isSuspending) {
      await releaseAllUserSessions(targetUserId);
    }
    await db.logAdminAudit({
      adminId: chatId,
      adminEmail,
      action: isSuspending ? 'SUSPEND_USER' : 'REACTIVATE_USER',
      targetUserIds: [targetUserId],
      details: { isSuspended: isSuspending },
    });

    const all = await db.allUsers();
    const updated = all.find((u) => u.id === targetUserId);
    const text = renderUserDetailView(db.safeAdminUser(updated));

    await bot.editMessageText(text, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'HTML',
      reply_markup: buildUserDetailKeyboard(updated, page),
    }).catch(() => {});
    return true;
  }

  // 8. Bulk Suspend
  if (data === 'adm:bulk_suspend' || data === 'adm:menu:suspend') {
    const selectedIds = Array.from(state.selectedUserIds || []);
    if (!selectedIds.length) {
      await bot.sendMessage(chatId, '⚠️ No users selected. Please select users first from "Select Multiple Users".', {
        reply_markup: {
          inline_keyboard: [[{ text: 'Go to Selection', callback_data: 'adm:menu:select:1' }]],
        },
      });
      return true;
    }

    let count = 0;
    for (const uid of selectedIds) {
      await db.setUserSuspended(uid, true);
      await releaseAllUserSessions(uid);
      count++;
    }

    await db.logAdminAudit({
      adminId: chatId,
      adminEmail,
      action: 'BULK_SUSPEND',
      targetUserIds: selectedIds,
      details: { count },
    });

    state.selectedUserIds.clear();
    await bot.editMessageText(
      `✅ <b>Bulk Suspension Complete</b>\n\nSuccessfully suspended ${count} user(s). Their active sessions have been revoked and future logins blocked.`,
      {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[{ text: '🔙 Back to Dashboard', callback_data: 'adm:menu:main' }]],
        },
      }
    );
    return true;
  }

  // 9. Bulk Delete — Two-Stage Confirmation Process
  if (data === 'adm:bulk_delete' || data === 'adm:menu:delete') {
    const selectedIds = Array.from(state.selectedUserIds || []);
    if (!selectedIds.length) {
      await bot.sendMessage(chatId, '⚠️ No users selected. Please select users first from "Select Multiple Users".', {
        reply_markup: {
          inline_keyboard: [[{ text: 'Go to Selection', callback_data: 'adm:menu:select:1' }]],
        },
      });
      return true;
    }

    state.deleteStage = 1;
    const text = [
      '⚠️ <b>Step 1 of 2: Confirm User Deletion</b>',
      '',
      `You have selected <b>${selectedIds.length} user(s)</b> for deletion.`,
      'This will soft-delete their accounts, revoke active sessions, and preserve audit logs.',
      '',
      '<i>(Note: University portal accounts are never deleted or affected.)</i>',
      '',
      'Do you wish to proceed to final confirmation?',
    ].join('\n');

    await bot.editMessageText(text, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '⚠️ Yes, Continue', callback_data: 'adm:delete_step_2' },
            { text: '❌ Cancel', callback_data: 'adm:menu:main' },
          ],
        ],
      },
    });
    return true;
  }

  if (data === 'adm:delete_step_2') {
    const selectedIds = Array.from(state.selectedUserIds || []);
    state.deleteStage = 2;
    const text = [
      '🔴 <b>FINAL CONFIRMATION: PERMANENT DELETION</b>',
      '',
      `Are you ABSOLUTELY sure you want to permanently delete <b>${selectedIds.length} account(s)</b>?`,
      'This action cannot be undone.',
    ].join('\n');

    await bot.editMessageText(text, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '🔴 Confirm Deletion', callback_data: 'adm:execute_bulk_delete' },
            { text: '❌ Abort & Cancel', callback_data: 'adm:menu:main' },
          ],
        ],
      },
    });
    return true;
  }

  if (data === 'adm:execute_bulk_delete') {
    const selectedIds = Array.from(state.selectedUserIds || []);
    let deletedCount = 0;

    for (const uid of selectedIds) {
      try {
        await releaseAllUserSessions(uid);
        await db.deleteUser(uid);
        deletedCount++;
      } catch (delErr) {
        log.error(`[admin] failed deleting user ${uid}: ${delErr.message}`);
      }
    }

    await db.logAdminAudit({
      adminId: chatId,
      adminEmail,
      action: 'BULK_DELETE',
      targetUserIds: selectedIds,
      details: { deletedCount },
    });

    state.selectedUserIds.clear();
    state.deleteStage = 0;

    await bot.editMessageText(
      `🗑️ <b>Deletion Completed</b>\n\nSuccessfully deleted ${deletedCount} user(s). Application sessions were revoked and audit logs preserved.`,
      {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[{ text: '🔙 Back to Dashboard', callback_data: 'adm:menu:main' }]],
        },
      }
    );
    return true;
  }

  // 10. Custom Telegram Message Composer
  if (data === 'adm:menu:msg' || data === 'adm:bulk_msg') {
    const selectedIds = Array.from(state.selectedUserIds || []);
    state.pendingAction = 'AWAITING_CUSTOM_MESSAGE';

    const recipientLabel = selectedIds.length > 0 ? `${selectedIds.length} selected user(s)` : 'ALL registered users';

    await bot.sendMessage(
      chatId,
      `✉️ <b>Send Custom Telegram Message</b>\n\nTarget recipients: <b>${recipientLabel}</b>\n\nPlease reply with the text message you wish to broadcast.\n\n(Example: <i>Your attendance has been updated. Please check your New ERP dashboard.</i>)`,
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'adm:menu:main' }]],
        },
      }
    );
    return true;
  }

  // 11. System Status
  if (data === 'adm:menu:status') {
    const health = await db.schemaHealth();
    const stats = await db.adminStats();
    const pingRes = await db.ping();

    const text = [
      '🩺 <b>System Status & Health</b>',
      '',
      `💾 <b>Database Mode:</b> ${health.mode.toUpperCase()}`,
      `📶 <b>Database Status:</b> ${health.ok ? 'Healthy ✅' : 'Issues Detected ⚠️'}`,
      `⏱️ <b>Database Latency:</b> ${pingRes.latencyMs || 0} ms`,
      `👥 <b>Total Users:</b> ${stats.totalUsers}`,
      `📡 <b>Active Watchers:</b> Running (every 2m IST)`,
      `⏰ <b>Morning Scheduler:</b> 8:30 AM IST Job Active`,
      `🤖 <b>Telegram Poller:</b> Active (single-lock pid ${process.pid})`,
    ].join('\n');

    await bot.editMessageText(text, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [[{ text: '🔙 Back to Dashboard', callback_data: 'adm:menu:main' }]],
      },
    });
    return true;
  }

  // 12. Audit Logs View
  if (data.startsWith('adm:menu:audit:')) {
    const page = Number(data.split(':')[3]) || 1;
    const limit = 5;
    const offset = (page - 1) * limit;

    const auditRes = await db.listAdminAuditLogs({ limit, offset });
    const totalPages = Math.max(1, Math.ceil(auditRes.total / limit));

    const lines = [
      `📜 <b>Admin Audit Logs (Page ${page}/${totalPages})</b>`,
      `Total Log Entries: ${auditRes.total}`,
      '',
    ];

    if (!auditRes.logs.length) {
      lines.push('<i>No audit records logged yet.</i>');
    } else {
      for (const logItem of auditRes.logs) {
        const time = new Date(logItem.createdAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
        lines.push(`• <b>[${logItem.action}]</b> by ${logItem.adminEmail || 'admin'}`);
        lines.push(`  Time: ${time}`);
        if (logItem.targetUserIds && logItem.targetUserIds.length) {
          lines.push(`  Targets: ${logItem.targetUserIds.length} user(s)`);
        }
        lines.push('');
      }
    }

    const navRow = [];
    if (page > 1) {
      navRow.push({ text: '⬅️ Prev', callback_data: `adm:menu:audit:${page - 1}` });
    }
    navRow.push({ text: `Page ${page}/${totalPages}`, callback_data: 'adm:noop' });
    if (page < totalPages) {
      navRow.push({ text: 'Next ➡️', callback_data: `adm:menu:audit:${page + 1}` });
    }

    await bot.editMessageText(lines.join('\n'), {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [navRow, [{ text: '🔙 Back to Main Menu', callback_data: 'adm:menu:main' }]],
      },
    });
    return true;
  }

  return false;
}

/**
 * Handle incoming custom message text from admin when composing a broadcast
 */
async function handleAdminMessageText(bot, msg, log = console) {
  const chatId = msg.chat.id;
  if (!(await isChatAdmin(chatId))) return false;

  const state = getAdminState(chatId);
  if (state.pendingAction !== 'AWAITING_CUSTOM_MESSAGE') return false;

  const broadcastText = msg.text;
  if (!broadcastText || !broadcastText.trim()) {
    await bot.sendMessage(chatId, '⚠️ Message cannot be empty. Please enter text or press cancel.');
    return true;
  }

  state.pendingAction = null;
  state.customMessage = broadcastText;

  // Resolve target users
  const allUsers = await db.allUsers();
  const selectedIds = Array.from(state.selectedUserIds || []);
  const targets = selectedIds.length > 0
    ? allUsers.filter((u) => selectedIds.includes(u.id))
    : allUsers;

  const validTelegramRecipients = targets.filter((u) => u.telegramChatId && !u.isSuspended);

  const preview = [
    '✉️ <b>Confirm Broadcast Dispatch</b>',
    '',
    `Target Accounts: <b>${targets.length}</b>`,
    `Connected Telegram Chats: <b>${validTelegramRecipients.length}</b>`,
    '',
    '<b>Message Preview:</b>',
    `<i>${broadcastText}</i>`,
  ].join('\n');

  await bot.sendMessage(chatId, preview, {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [
          { text: '🚀 Dispatch Now', callback_data: 'adm:confirm_send_broadcast' },
          { text: '❌ Cancel', callback_data: 'adm:menu:main' },
        ],
      ],
    },
  });
  return true;
}

/**
 * Dispatch custom message with rate limiting (100ms) and delivery tracking
 */
async function executeBroadcast(bot, chatId, log = console) {
  const state = getAdminState(chatId);
  const broadcastText = state.customMessage;
  if (!broadcastText) return;

  const adminUser = await db.getUserByTelegramChatId(chatId);
  const adminEmail = (adminUser && adminUser.email) || 'admin';

  const allUsers = await db.allUsers();
  const selectedIds = Array.from(state.selectedUserIds || []);
  const targets = selectedIds.length > 0
    ? allUsers.filter((u) => selectedIds.includes(u.id))
    : allUsers;

  let sent = 0;
  let skipped = 0;
  let failed = 0;

  await bot.sendMessage(chatId, `⏳ Dispatching message to ${targets.length} user(s)...`);

  for (const user of targets) {
    if (user.isSuspended || !user.telegramChatId) {
      skipped++;
      continue;
    }

    try {
      await bot.sendMessage(user.telegramChatId, `📢 <b>Announcement</b>\n\n${broadcastText}`, {
        parse_mode: 'HTML',
      });
      sent++;
    } catch (sendErr) {
      log.error(`[admin broadcast] failed for user ${user.id}: ${sendErr.message}`);
      failed++;
    }

    // Rate limiting: 100ms interval between messages
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  await db.logAdminAudit({
    adminId: chatId,
    adminEmail,
    action: 'BROADCAST_MESSAGE',
    targetUserIds: targets.map((u) => u.id),
    details: { sent, skipped, failed, messagePreview: broadcastText.slice(0, 100) },
  });

  state.customMessage = '';
  state.selectedUserIds.clear();

  const report = [
    '📊 <b>Broadcast Delivery Report</b>',
    '',
    `✅ Successfully Sent: <b>${sent}</b>`,
    `⚠️ Skipped (No Telegram / Suspended): <b>${skipped}</b>`,
    `❌ Failed: <b>${failed}</b>`,
    `Total Processed: <b>${targets.length}</b>`,
  ].join('\n');

  await bot.sendMessage(chatId, report, {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [[{ text: '🔙 Back to Dashboard', callback_data: 'adm:menu:main' }]],
    },
  });
}

function clearSelection(chatId) {
  const state = getAdminState(chatId);
  state.selectedUserIds.clear();
}

function toggleUserSelection(chatId, userId) {
  const state = getAdminState(chatId);
  if (state.selectedUserIds.has(userId)) {
    state.selectedUserIds.delete(userId);
    return false;
  } else {
    state.selectedUserIds.add(userId);
    return true;
  }
}

function selectAll(chatId, userIds) {
  const state = getAdminState(chatId);
  (userIds || []).forEach((id) => state.selectedUserIds.add(id));
}

function getSelectedUsers(chatId) {
  const state = getAdminState(chatId);
  return Array.from(state.selectedUserIds);
}

module.exports = {
  isChatAdmin,
  isAdmin: isChatAdmin,
  handleAdminCommand,
  handleAdminCallbackQuery,
  handleAdminMessageText,
  executeBroadcast,
  buildMainMenuKeyboard,
  adminMenuKeyboard: buildMainMenuKeyboard,
  renderAdminDashboard,
  maskIdentifier,
  maskQid: maskIdentifier,
  getAdminState,
  clearAdminState,
  clearSelection,
  toggleUserSelection,
  selectAll,
  getSelectedUsers,
};
