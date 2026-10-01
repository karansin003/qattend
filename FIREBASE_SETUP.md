# Firebase Authentication — Setup & Operations

This project now uses **Firebase Authentication (Email/Password)** for
registration, login and password reset, while the existing PostgreSQL/JSON
application user remains the owner of QUMS credentials, Telegram link,
attendance data and schedules.

```
Application User (PostgreSQL/JSON)  --firebase_uid-->  Firebase Auth User
        id, email, QUMS, Telegram, attendance              uid, email, password
```

## 1. What was implemented (no secrets anywhere)

| Concern | Implementation |
| --- | --- |
| Client auth | Firebase Web SDK (ESM CDN) on `/register`, `/login`, `/forgot`, `/reset` |
| Server trust | `src/firebaseAuth.js` verifies the browser's **ID token** (RS256 signature via Google's public certs, `iss`/`aud`/`exp`/`iat`/`sub`/`email`) |
| Session | Unchanged: `req.session.userId = applicationUser.id` (Express + FileStore) |
| User model | New `firebase_uid` column/field on the existing users table (see §3) |
| Legacy users | Still log in with email+password (bcrypt). They are linked to Firebase on first Firebase login (bcrypt proof or verified email) |
| Reset emails | Sent by **Firebase only** (`sendPasswordResetEmail`), continuing back to `<origin>/reset?oobCode=…` where the password is set with `confirmPasswordReset` |
| Old token emails | `/api/reset` still honors old in-flight `?token=` links; no new tokens are issued |

The Firebase **web apiKey is public by design** (it identifies the project, it
does not authorize anything by itself). No service account, no private key,
no Admin SDK is used or required: token verification is a public-key
operation against `https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com`.

## 2. Firebase Console changes required (manual, one-time)

Project: `qums-forgot-password-test`

1. **Authentication → Sign-in method → Email/Password**: must be *Enabled*
   (if registration fails with `auth/operation-not-allowed`, this is why).
2. **Authentication → Settings → Authorized domains**: add every domain the
   app runs on, e.g. `localhost`, your Render domain
   (`your-app.onrender.com`). Needed for the reset email to redirect back to
   `/reset`. Missing domain ⇒ `auth/unauthorized-domain`.
3. **Authentication → Templates → Password reset** — customize the template
   to the professional QUMS style (Console-only feature; the app does not
   send this email itself anymore):

   **Subject:** `QUMS Attendance Bot — Reset Your Password`

   **Body (HTML):**
   ```html
   <div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:auto;padding:24px;border:1px solid #e5e7eb;border-radius:10px;">
     <h2 style="margin:0 0 4px;color:#1a2b4c;">🎓 QUMS Attendance Bot</h2>
     <p style="margin:0 0 18px;color:#6b7280;font-size:13px;">Reset Your Password</p>
     <p style="margin:0 0 14px;">Hello,</p>
     <p style="margin:0 0 14px;">We received a request to reset the password for your QUMS Attendance Bot account.</p>
     <p style="margin:0 0 18px;">Click the button below to create a new password:</p>
     <p style="margin:0 0 18px;">
       <a href="%LINK%" style="display:inline-block;background:#1a2b4c;color:#ffffff;padding:12px 22px;border-radius:6px;text-decoration:none;font-weight:bold;">Reset Password</a>
     </p>
     <p style="margin:0 0 8px;color:#374151;">This link is intended only for your account.</p>
     <p style="margin:0 0 8px;color:#374151;">If you did not request this password reset, you can safely ignore this email.</p>
     <p style="margin:0 0 18px;color:#374151;">For security reasons, never share your password or reset link with anyone.</p>
     <p style="margin:0;color:#6b7280;">Regards,<br/>QUMS Attendance Bot</p>
   </div>
   ```
   (Keep `%LINK%` / the placeholder exactly as the Console shows — Firebase
   injects the action link there.)

## 3. Database change (applied automatically on boot)

```sql
ALTER TABLE users ADD COLUMN IF NOT EXISTS firebase_uid TEXT DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_users_firebase_uid ON users(firebase_uid);
```

- Idempotent and backward compatible; existing rows keep `''`.
- JSON fallback (`data/db.json`): the optional `firebaseUid` field is simply
  written when a user is linked/registered; old files without it work as-is.
- Nothing is deleted; attendance/Telegram/QUMS columns are untouched.

## 4. Environment variables

| Variable | Required | Notes |
| --- | --- | --- |
| `FIREBASE_PROJECT_ID` | optional | Defaults to `qums-forgot-password-test`. Public identifier, **not** a secret. Set it only if you switch Firebase projects. |
| — | — | No Firebase private key / service account is used by this app. |

Existing variables (`SESSION_SECRET`, `ENCRYPTION_KEY`, `DATABASE_URL`,
`TELEGRAM_BOT_TOKEN`, …) are unchanged. `RESEND_API_KEY`/`SMTP_*` are no

## 5. Flows

**Register** — validate → `createUserWithEmailAndPassword` → `getIdToken()` →
`POST /api/register {idToken}` → server verifies token → creates the app user
(with `firebase_uid`) → session → redirect `/qums-setup`.
Errors: `auth/email-already-in-use` → "This email is already registered. Please login.",
`auth/weak-password`, `auth/invalid-email`, `auth/operation-not-allowed` → friendly text.

**Login** — `signInWithEmailAndPassword` → `getIdToken()` →
`POST /api/login {idToken, password}` → server verifies token → maps to the
app user by `firebase_uid`/email → session → `/dashboard` (QUMS configured) or
`/qums-setup` (not configured). If Firebase does not know the account (legacy
user), the backend bcrypt fallback runs — same behavior as before.

**Legacy migration (first Firebase login of an old user)** — linking requires
ownership proof: the legacy password (bcrypt-checked) **or** a verified
Firebase email. Without proof the attempt is rejected (`403 MIGRATE_PASSWORD`)
— a hostile Firebase account created for someone else's email cannot claim
their QUMS/Telegram/attendance data.

**Forgot** — `POST /api/forgot {email}`: unregistered ⇒ explicit
"❌ Email not registered …" and **no** email; registered ⇒ client calls
`sendPasswordResetEmail(auth, email, { url: <origin>/reset })` and the user
sees "Password reset email sent. Please check your inbox."

**Reset** — the Firebase email link lands on `/reset?oobCode=…` → user sets a
new password (+ confirm) → `confirmPasswordReset` → "Password reset successful.
You can now login." → "Go to Login". The code is never shown in the UI.

## 6. Local/production notes

- The Firebase user list lives in **Firebase Console → Authentication → Users**.
- Deleting an app user in the app DB does not delete the Firebase account and
  vice versa (keep them in sync manually if needed).
- The reset email comes from the address configured in Firebase templates
  (Console → Templates → sender address), never a hardcoded address in code.

longer needed for password resets (they stay harmless if present; mailer.js
is untouched for other potential uses).

