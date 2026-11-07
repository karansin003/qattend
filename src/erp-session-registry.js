/**
 * Centralized ERP Session Registry
 * Enforces: One QUMS Account = One Active ERP Integration Session (OLD or NEW).
 *
 * Rules:
 * - A single QUMS account can be active in ONLY ONE ERP at a time.
 * - If active in Old ERP -> New ERP login is blocked with:
 *   "This QUMS account is already active in Old ERP. Please disconnect the existing session before switching to New ERP."
 * - If active in New ERP -> Old ERP login is blocked with:
 *   "This QUMS account is already active in New ERP. Please disconnect the existing session before switching to Old ERP."
 * - Expired sessions do not block logins.
 * - Explicit logout or disconnect cleanly releases the active session.
 */

const db = require('./db');

class SessionExclusivityError extends Error {
  constructor(message, activeErp, requestedErp) {
    super(message);
    this.name = 'SessionExclusivityError';
    this.code = 'SESSION_EXCLUSIVITY_BLOCKED';
    this.statusCode = 409;
    this.status = 409;
    this.activeErp = activeErp;
    this.conflictingErp = activeErp;
    this.requestedErp = requestedErp;
  }
}

const ERP_TYPES = Object.freeze({
  OLD: 'OLD',
  NEW: 'NEW',
});

const SESSION_STATUS = Object.freeze({
  ACTIVE: 'active',
  EXPIRED: 'expired',
});

/**
 * Standardize identity string (QID, roll number, or registered email).
 */
function canonicalIdentity(rawIdentity) {
  return String(rawIdentity || '').trim().toLowerCase();
}

/**
 * Check whether switching to or acquiring targetErp is allowed for this QUMS identity.
 *
 * @param {string} identity - QID or QUMS registered email
 * @param {string} userId - application user id
 * @param {'OLD'|'NEW'} targetErp - the ERP type the user wants to login to
 * @returns {Promise<{ allowed: boolean, conflictMessage?: string, existing?: object }>}
 */
async function checkSessionEligibility(identity, userId, targetErp) {
  const normId = canonicalIdentity(identity);
  const target = String(targetErp || 'OLD').toUpperCase();
  const otherErp = target === 'OLD' ? 'NEW' : 'OLD';
  const otherErpLabel = otherErp === 'OLD' ? 'Old ERP' : 'New ERP';
  const targetErpLabel = target === 'OLD' ? 'Old ERP' : 'New ERP';

  // 1. Check user record directly
  const user = userId ? await db.getUserById(userId) : null;
  if (user) {
    const isOldActive = Boolean(user.qumsSessionPath && user.qumsSessionStatus === 'active' && user.activeErpType === 'OLD');
    const isNewActive = Boolean(user.newErpSessionPath && (user.newErpSessionStatus === 'ACTIVE' || user.newErpSessionStatus === 'active') && user.activeErpType === 'NEW');

    if (target === 'OLD' && isNewActive) {
      return {
        allowed: false,
        conflictMessage: `This QUMS account is already active in New ERP. Please disconnect the existing session before switching to Old ERP.`,
        activeErp: 'NEW',
      };
    }

    if (target === 'NEW' && isOldActive) {
      return {
        allowed: false,
        conflictMessage: `This QUMS account is already active in Old ERP. Please disconnect the existing session before switching to New ERP.`,
        activeErp: 'OLD',
      };
    }
  }

  // 2. Check centralized registry by identity
  if (normId) {
    const existing = await db.getActiveErpSession(normId);
    if (existing && existing.status === 'active' && existing.erpType !== target) {
      return {
        allowed: false,
        conflictMessage: `This QUMS account is already active in ${otherErpLabel}. Please disconnect the existing session before switching to ${targetErpLabel}.`,
        activeErp: existing.erpType,
        existing,
      };
    }
  }

  return { allowed: true };
}

/**
 * Acquire active session for target ERP atomically.
 * Throws SessionExclusivityError if blocked by an existing active session in the other ERP.
 */
async function acquireSession(arg1, arg2, arg3, arg4) {
  let identity, userId, targetErp, sessionId;
  if (typeof arg1 === 'object' && arg1 !== null) {
    identity = arg1.identity;
    userId = arg1.userId;
    targetErp = arg1.targetErp;
    sessionId = arg1.sessionId;
  } else {
    userId = arg1;
    targetErp = arg2;
    identity = arg3;
    sessionId = arg4?.sessionId || arg4?.token;
  }

  const target = String(targetErp || 'OLD').toUpperCase();
  const check = await checkSessionEligibility(identity, userId, target);
  if (!check.allowed) {
    throw new SessionExclusivityError(check.conflictMessage, check.activeErp, target);
  }

  const session = await db.acquireErpSession({
    qumsIdentity: canonicalIdentity(identity || userId),
    userId,
    erpType: target,
    sessionId: sessionId || (userId ? db.sessionPathFor(userId) : 'sess-default'),
  });

  return {
    ...session,
    qid: session.qumsIdentity,
    identity: session.qumsIdentity,
  };
}

/**
 * Release active session when user logs out or explicitly disconnects.
 */
async function releaseSession(arg1, arg2) {
  // Support both (identity, userId) and (userId, targetErp)
  let identity = arg1;
  let userId = arg2;
  if (arg2 === 'OLD' || arg2 === 'NEW') {
    userId = arg1;
    identity = '';
  }
  const normId = canonicalIdentity(identity);
  return db.releaseErpSession(normId, userId);
}

/**
 * Release all sessions for a user (used during account disconnect/reset).
 */
async function releaseAllUserSessions(userId) {
  return db.releaseAllErpSessionsForUser(userId);
}

/**
 * Get active session for a user or identity
 */
async function getActiveSession(userId, identity) {
  if (identity) {
    const s = await db.getActiveErpSession(canonicalIdentity(identity));
    if (s && s.status === 'active') return s;
  }
  if (userId) {
    const s = await db.getActiveErpSessionByUserId(userId);
    if (s && s.status === 'active') return s;
  }
  return null;
}

module.exports = {
  SessionExclusivityError,
  ERP_TYPES,
  SESSION_STATUS,
  canonicalIdentity,
  checkSessionEligibility,
  acquireSession,
  releaseSession,
  releaseAll: releaseAllUserSessions,
  releaseAllUserSessions,
  getActiveSession,
};
