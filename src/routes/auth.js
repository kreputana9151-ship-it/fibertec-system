const router = require('express').Router();
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { query, tx } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { sendEmail } = require('../services/mailer');

const wrap = fn => (req, res, next) => fn(req, res, next).catch(next);
const sha256 = t => crypto.createHash('sha256').update(t).digest('hex');
const goodPassword = p => typeof p === 'string' && p.length >= 8 && p.length <= 72 && !/\s/.test(p);
const PW_RULE = 'Password must be 8 to 72 characters and must not contain whitespace.';

// tiny in-memory limiter: max N tries per IP per path per window
const hits = new Map();
const limit = (max, ms) => (req, res, next) => {
  const k = req.ip + req.path, now = Date.now(), a = (hits.get(k) || []).filter(t => now - t < ms);
  if (a.length >= max) return res.status(429).json({ error: 'Too many attempts. Please wait a few minutes and try again.' });
  a.push(now); hits.set(k, a); next();
};

const USER_SQL = `SELECT u.user_id, u.login_id, u.password_hash, u.role, u.is_active, u.must_change_password,
                         u.failed_login_attempts, u.login_locked_until,
                         (u.login_locked_until > now()) AS login_is_locked,
                         CASE WHEN u.login_locked_until > now()
                              THEN GREATEST(CEIL(EXTRACT(EPOCH FROM (u.login_locked_until - now())) / 60)::int, 1)
                              ELSE 0 END AS lock_minutes,
                         s.branch_code AS staff_branch, b.name AS branch_name, c.account_no, c.email
                    FROM users u
                    LEFT JOIN staff    s ON s.user_id = u.user_id
                    LEFT JOIN branches b ON b.branch_code = s.branch_code
                    LEFT JOIN clients  c ON c.user_id = u.user_id`;

// find a login by: 8-digit account no. / staff branch username / admin username / client email
async function findUsers(id, db = { query }, lock = false) {
  const lockSql = lock ? ' FOR UPDATE OF u' : '';
  let rows = (await db.query(USER_SQL + ' WHERE lower(u.login_id) = lower($1)' + lockSql, [id])).rows;
  if (!rows.length && id.includes('@')) rows = (await db.query(USER_SQL + ' WHERE lower(c.email) = lower($1)' + lockSql, [id])).rows;
  return rows;
}

// POST /api/auth/login   { loginId, password }
// client: 8-digit account no. OR email | staff: branch name (bagongilog, caniogan, ...) | admin: rguerrero
router.post('/login', limit(10, 5 * 60 * 1000), wrap(async (req, res) => {
  const { loginId, password } = req.body || {};
  if (typeof loginId !== 'string' || !loginId) return res.status(400).json({ error: 'Account number, email, or username required.' });
  if (/\s/.test(loginId)) return res.status(400).json({ error: 'Account number, email, or username must not contain whitespace.' });
  if (typeof password !== 'string' || !password) return res.status(400).json({ error: 'Password required.' });
  if (/\s/.test(password)) return res.status(400).json({ error: 'Password must not contain whitespace.' });

  const result = await tx(async c => {
    const rows = await findUsers(loginId, c, true);
    if (rows.length > 1) return { status: 400, body: { error: 'More than one account uses this email. Please log in with your 8-digit account number.' } };
    const u = rows[0];
    if (!u || !u.is_active) return { status: 401, body: { error: 'Wrong username or password' } };
    if (u.login_is_locked) {
      const minutes = Number(u.lock_minutes) || 1;
      return {
        status: 423,
        body: { error: `This account is temporarily locked after 5 failed password attempts. Please try again in ${minutes} minute${minutes === 1 ? '' : 's'}.` }
      };
    }

    if (!(await bcrypt.compare(String(password), u.password_hash))) {
      const attempts = u.login_locked_until ? 1 : Number(u.failed_login_attempts || 0) + 1;
      const locked = attempts >= 5;
      await c.query(
        `UPDATE users
            SET failed_login_attempts=$2,
                login_locked_until=CASE WHEN $3 THEN now() + interval '10 minutes' ELSE NULL END
          WHERE user_id=$1`,
        [u.user_id, locked ? 5 : attempts, locked]
      );
      return {
        status: locked ? 423 : 401,
        body: { error: locked
          ? 'This account is temporarily locked after 5 failed password attempts. Please try again in 10 minutes.'
          : 'Wrong username or password' }
      };
    }

    await c.query('UPDATE users SET failed_login_attempts=0, login_locked_until=NULL WHERE user_id=$1', [u.user_id]);
    const payload = { userId: u.user_id, role: u.role };
    if (u.role === 'client') payload.accountNo = u.account_no;
    if (u.role === 'staff') payload.branchCode = u.staff_branch;

    const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES || '8h' });
    return {
      status: 200,
      body: { token, role: u.role, accountNo: u.account_no || null, branchCode: u.staff_branch || null,
              branchName: u.branch_name || null, mustChangePassword: u.must_change_password }
    };
  });
  res.status(result.status).json(result.body);
}));

// POST /api/auth/change-password   { currentPassword, newPassword }   (logged in)
router.post('/change-password', requireAuth, limit(10, 5 * 60 * 1000), wrap(async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (typeof currentPassword !== 'string' || !currentPassword) return res.status(400).json({ error: 'Current password required.' });
  if (/\s/.test(currentPassword)) return res.status(400).json({ error: 'Current password must not contain whitespace.' });
  if (!goodPassword(newPassword)) return res.status(400).json({ error: PW_RULE });
  const hash = await bcrypt.hash(newPassword, 10);
  const changed = await tx(async c => {
    const u = (await c.query('SELECT password_hash FROM users WHERE user_id=$1 FOR UPDATE', [req.user.userId])).rows[0];
    if (!u || !(await bcrypt.compare(currentPassword, u.password_hash))) return false;
    await c.query(`UPDATE users SET password_hash=$2, must_change_password=FALSE,
                          failed_login_attempts=0, login_locked_until=NULL
                    WHERE user_id=$1`,
      [req.user.userId, hash]);
    await c.query('UPDATE password_resets SET used_at=COALESCE(used_at, now()) WHERE user_id=$1 AND used_at IS NULL', [req.user.userId]);
    return true;
  });
  if (!changed) return res.status(401).json({ error: 'Current password is wrong' });
  res.json({ ok: true });
}));

// POST /api/auth/forgot-password   { loginId }
// Clients get an email link. Staff/admin have no email, so they must ask the owner to reset it.
const SAME_ANSWER = { ok: true, message: 'If this account has an email on file, a password reset link has been sent to your Gmail. Please check your Inbox or Spam folder.' };
router.post('/forgot-password', limit(5, 15 * 60 * 1000), wrap(async (req, res) => {
  const loginId = (req.body || {}).loginId;
  if (typeof loginId === 'string' && /\s/.test(loginId)) {
    return res.status(400).json({ error: 'Account number or email must not contain whitespace.' });
  }
  const id = typeof loginId === 'string' ? loginId : '';
  if (id) {
    const allMatched = await findUsers(id);
    const rows = allMatched.filter(r => r.role === 'client' && r.is_active && r.email);
    if (!rows.length) {
      console.warn(`[FORGOT PASSWORD SKIPPED] loginId="${id}" matched=${allMatched.length} details=${JSON.stringify(allMatched.map(r => ({ user_id: r.user_id, role: r.role, is_active: r.is_active, hasEmail: !!r.email })))}`);
    }
    for (const u of rows) {
      const token = crypto.randomBytes(32).toString('hex');
      await query('DELETE FROM password_resets WHERE user_id=$1 AND used_at IS NULL', [u.user_id]);
      await query(`INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES ($1,$2, now() + interval '30 minutes')`,
        [u.user_id, sha256(token)]);
      const baseUrl = (process.env.APP_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
      const link = `${baseUrl}/forgot-password.html?token=${token}`;
      console.log(`[FORGOT PASSWORD] Dispatching reset email to ${u.email} for account ${u.account_no}`);
      await sendEmail(u.email, 'FiberTec password reset', `Open this link within 30 minutes to set a new password:\n${link}\n\nIf you did not ask for this, ignore this email.`);
    }
  }
  res.json(SAME_ANSWER);                                            // same answer whether or not the account exists
}));

// POST /api/auth/reset-password   { token, newPassword }
router.post('/reset-password', limit(10, 15 * 60 * 1000), wrap(async (req, res) => {
  const { token, newPassword } = req.body || {};
  if (!goodPassword(newPassword)) return res.status(400).json({ error: PW_RULE });
  const hash = await bcrypt.hash(newPassword, 10);
  const changed = await tx(async c => {
    const r = (await c.query(`SELECT reset_id, user_id FROM password_resets
                               WHERE token_hash=$1 AND used_at IS NULL AND expires_at > now()
                               FOR UPDATE`, [sha256(String(token || ''))])).rows[0];
    if (!r) return false;
    await c.query(`UPDATE users SET password_hash=$2, must_change_password=FALSE,
                          failed_login_attempts=0, login_locked_until=NULL
                    WHERE user_id=$1`, [r.user_id, hash]);
    await c.query('UPDATE password_resets SET used_at=COALESCE(used_at, now()) WHERE user_id=$1 AND used_at IS NULL', [r.user_id]);
    return true;
  });
  if (!changed) return res.status(400).json({ error: 'This reset link is invalid or has expired. Please request a new one.' });
  res.json({ ok: true });
}));

module.exports = router;