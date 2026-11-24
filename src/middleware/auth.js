const jwt = require('jsonwebtoken');
const { query } = require('../db');

function requireAuth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Session expired. Please log in again.' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET); // { userId, role, accountNo?, branchCode? }
    next();
  } catch {
    res.status(401).json({ error: 'Session expired. Please log in again.' });
  }
}

const requireRole = (...roles) => (req, res, next) =>
  roles.includes(req.user.role) ? next() : res.status(403).json({ error: 'Not allowed' });

async function requirePasswordChangeComplete(req, res, next) {
  try {
    const user = (await query('SELECT must_change_password FROM users WHERE user_id=$1', [req.user.userId])).rows[0];
    if (!user) return res.status(401).json({ error: 'Session expired. Please log in again.' });
    if (user.must_change_password) {
      return res.status(403).json({
        mustChangePassword: true,
        error: 'Your password was reset. Sign in again to set a new password before accessing the Client Portal.'
      });
    }
    next();
  } catch (e) {
    next(e);
  }
}

module.exports = { requireAuth, requireRole, requirePasswordChangeComplete };
