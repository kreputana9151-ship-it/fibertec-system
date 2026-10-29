const router = require('express').Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { query } = require('../db');

// POST /api/auth/login   { loginId, password }
// client: loginId = 8-digit account no. | staff: staff01..staff06 | admin: admin01
router.post('/login', async (req, res) => {
  const { loginId, password } = req.body || {};
  if (!loginId || !password) return res.status(400).json({ error: 'Login ID and password required' });

  const { rows } = await query(
    `SELECT u.user_id, u.password_hash, u.role, u.is_active, s.branch_code AS staff_branch, c.account_no, c.status
       FROM users u
       LEFT JOIN staff   s ON s.user_id = u.user_id
       LEFT JOIN clients c ON c.user_id = u.user_id
      WHERE u.login_id = $1`, [loginId]);
  const u = rows[0];
  if (!u || !u.is_active || !(await bcrypt.compare(password, u.password_hash)))
    return res.status(401).json({ error: 'Wrong login ID or password' });

  const payload = { userId: u.user_id, role: u.role };
  if (u.role === 'client') payload.accountNo = u.account_no;
  if (u.role === 'staff') payload.branchCode = u.staff_branch;   // staff locked to ONE branch

  const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES || '8h' });
  res.json({ token, role: u.role, accountNo: u.account_no || null, branchCode: u.staff_branch || null });
});

module.exports = router;
