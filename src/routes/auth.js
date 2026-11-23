const router = require('express').Router();
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { sendEmail } = require('../services/mailer');

const wrap = fn => (req, res, next) => fn(req, res, next).catch(next);
const sha256 = t => crypto.createHash('sha256').update(t).digest('hex');
const goodPassword = p => typeof p === 'string' && p.length >= 8 && p.length <= 72;
const PW_RULE = 'Password must be 8 to 72 characters.';

// tiny in-memory limiter: max N tries per IP per path per window
const hits = new Map();
const limit = (max, ms) => (req, res, next) => {
  const k = req.ip + req.path, now = Date.now(), a = (hits.get(k) || []).filter(t => now - t < ms);
  if (a.length >= max) return res.status(429).json({ error: 'Too many attempts. Please wait a few minutes and try again.' });
  a.push(now); hits.set(k, a); next();
};

const USER_SQL = `SELECT u.user_id, u.login_id, u.password_hash, u.role, u.is_active, u.must_change_password,
                         s.branch_code AS staff_branch, b.name AS branch_name, c.account_no, c.email
                    FROM users u
                    LEFT JOIN staff    s ON s.user_id = u.user_id
                    LEFT JOIN branches b ON b.branch_code = s.branch_code
                    LEFT JOIN clients  c ON c.user_id = u.user_id`;

// find a login by: 8-digit account no. / staff branch username / admin username / client email
async function findUsers(id) {
  let rows = (await query(USER_SQL + ' WHERE lower(u.login_id) = lower($1)', [id])).rows;
  if (!rows.length && id.includes('@')) rows = (await query(USER_SQL + ' WHERE lower(c.email) = lower($1)', [id])).rows;
  return rows;
}

// POST /api/auth/login   { loginId, password }
// client: 8-digit account no. OR email | staff: branch name (bagongilog, caniogan, ...) | admin: rguerrero
router.post('/login', limit(10, 5 * 60 * 1000), wrap(async (req, res) => {
  const { loginId, password } = req.body || {};
  if (!loginId || !password) return res.status(400).json({ error: 'Username and password required' });

  const rows = await findUsers(String(loginId).trim());
  if (rows.length > 1) return res.status(400).json({ error: 'More than one account uses this email. Please log in with your 8-digit account number.' });
  const u = rows[0];
  if (!u || !u.is_active || !(await bcrypt.compare(String(password), u.password_hash)))
    return res.status(401).json({ error: 'Wrong username or password' });

  const payload = { userId: u.user_id, role: u.role };
  if (u.role === 'client') payload.accountNo = u.account_no;
  if (u.role === 'staff') payload.branchCode = u.staff_branch;   // staff locked to ONE branch

  const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES || '8h' });
  res.json({ token, role: u.role, accountNo: u.account_no || null, branchCode: u.staff_branch || null,
             branchName: u.branch_name || null, mustChangePassword: u.must_change_password });
}));

// POST /api/auth/change-password   { currentPassword, newPassword }   (logged in)
router.post('/change-password', requireAuth, limit(10, 5 * 60 * 1000), wrap(async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!goodPassword(newPassword)) return res.status(400).json({ error: PW_RULE });
  const u = (await query('SELECT password_hash FROM users WHERE user_id=$1', [req.user.userId])).rows[0];
  if (!u || !(await bcrypt.compare(String(currentPassword || ''), u.password_hash)))
    return res.status(401).json({ error: 'Current password is wrong' });
  await query('UPDATE users SET password_hash=$2, must_change_password=FALSE WHERE user_id=$1',
    [req.user.userId, await bcrypt.hash(newPassword, 10)]);
  res.json({ ok: true });
}));

// POST /api/auth/forgot-password   { loginId }
// Clients get an email link. Staff/admin have no email, so they must ask the owner to reset it.
const SAME_ANSWER = { ok: true, message: 'If this account has an email on file, a reset link was sent. Staff and admin accounts: please ask the owner (Ramon Guerrero) to reset your password.' };
router.post('/forgot-password', limit(5, 15 * 60 * 1000), wrap(async (req, res) => {
  const id = String((req.body || {}).loginId || '').trim();
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
  const r = (await query(`SELECT reset_id, user_id FROM password_resets
                           WHERE token_hash=$1 AND used_at IS NULL AND expires_at > now()`, [sha256(String(token || ''))])).rows[0];
  if (!r) return res.status(400).json({ error: 'This reset link is invalid or has expired. Please request a new one.' });
  await query('UPDATE users SET password_hash=$2, must_change_password=FALSE WHERE user_id=$1', [r.user_id, await bcrypt.hash(newPassword, 10)]);
  await query('UPDATE password_resets SET used_at=now() WHERE reset_id=$1', [r.reset_id]);
  res.json({ ok: true });
}));

module.exports = router;