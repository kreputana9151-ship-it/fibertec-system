const router = require('express').Router();
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { requireAuth, requireRole } = require('../middleware/auth');
const { query, tx } = require('../db');
const { applyVerifiedPayment } = require('../services/billing');
const { changeStatus, logActivity } = require('../services/audit');

router.use(requireAuth, requireRole('staff'));
// every query below uses req.user.branchCode, so staff can never see another branch

// GET /api/staff/clients?q=
router.get('/clients', async (req, res) => {
  const q = `%${req.query.q || ''}%`;
  const { rows } = await query(
    `SELECT c.account_no, c.name, c.contact_no, c.email, c.status, p.plan_name, c.due_day
       FROM clients c JOIN plans p USING (plan_id)
      WHERE c.branch_code=$1 AND (c.name ILIKE $2 OR c.account_no LIKE $2)
      ORDER BY c.client_seq`, [req.user.branchCode, q]);
  res.json(rows);
});

// GET /api/staff/clients.csv  (Export CSV)
router.get('/clients.csv', async (req, res) => {
  const { rows } = await query(
    `SELECT c.account_no, c.name, c.contact_no, c.email, p.plan_name, c.status
       FROM clients c JOIN plans p USING (plan_id) WHERE c.branch_code=$1 ORDER BY c.client_seq`, [req.user.branchCode]);
  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = ['account_no,name,contact_no,email,plan,status', ...rows.map(r => Object.values(r).map(esc).join(','))].join('\n');
  res.type('text/csv').attachment(`clients_${req.user.branchCode}.csv`).send(csv);
});

// POST /api/staff/clients  -> register a client in the staff's own branch
// body: { name, contactNo, email, address, facebook, routerLocation, planId, registeredDate }
router.post('/clients', async (req, res) => {
  const b = req.body || {};
  if (!b.name || !b.contactNo || !b.email || !b.address || !b.planId || !b.registeredDate)
    return res.status(400).json({ error: 'Missing required fields' });
  const reg = new Date(b.registeredDate);
  const tempPassword = crypto.randomBytes(5).toString('hex');           // shown to staff once
  const hash = await bcrypt.hash(tempPassword, 10);

  try {
    const out = await tx(async c => {
      await c.query('SELECT pg_advisory_xact_lock($1)', [Number(req.user.branchCode)]);   // no duplicate client IDs
      const seq = (await c.query('SELECT COALESCE(MAX(client_seq),0)+1 AS n FROM clients WHERE branch_code=$1', [req.user.branchCode])).rows[0].n;
      if (seq > 9999) throw new Error('Branch is full (9999 clients)');
      const accountNo = req.user.branchCode + String(reg.getFullYear() % 100).padStart(2, '0') + String(seq).padStart(4, '0');

      const u = await c.query("INSERT INTO users (login_id, password_hash, role) VALUES ($1,$2,'client') RETURNING user_id", [accountNo, hash]);
      await c.query(
        `INSERT INTO clients (account_no, user_id, branch_code, client_seq, plan_id, name, contact_no, email, address,
                              facebook, router_location, registered_date, due_day)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [accountNo, u.rows[0].user_id, req.user.branchCode, seq, b.planId, b.name, b.contactNo, b.email, b.address,
         b.facebook || null, b.routerLocation || null, b.registeredDate, reg.getDate()]);   // due day = install day
      await logActivity(c, req.user.userId, req.user.branchCode, `Registered client ${accountNo} (${b.name})`);
      return accountNo;
    });
    res.status(201).json({ accountNo: out, tempPassword });
  } catch (e) { console.error(e); res.status(400).json({ error: e.message }); }
});

// GET /api/staff/payments?status=Pending
router.get('/payments', async (req, res) => {
  const { rows } = await query(
    `SELECT p.*, c.name FROM payments p JOIN clients c USING (account_no)
      WHERE c.branch_code=$1 AND ($2::text IS NULL OR p.status=$2)
      ORDER BY p.created_at DESC`, [req.user.branchCode, req.query.status || null]);
  res.json(rows);
});

// POST /api/staff/payments/cash  { statementId, amount, orNo? }  -> encode cash, auto-verified
router.post('/payments/cash', async (req, res) => {
  const { statementId, amount, orNo } = req.body || {};
  try {
    const out = await tx(async c => {
      const s = (await c.query(
        `SELECT s.* FROM statements s JOIN clients cl USING (account_no)
          WHERE s.statement_id=$1 AND cl.branch_code=$2`, [statementId, req.user.branchCode])).rows[0];
      if (!s) throw new Error('Statement not found in your branch');
      const amt = Number(amount);
      if (!(amt > 0) || amt > Number(s.balance)) throw new Error('Invalid amount');
      const pastDue = new Date(s.due_date) < new Date(new Date().toDateString());
      const isFull = amt === Number(s.balance);
      if (pastDue && !isFull) throw new Error('After the due date the full balance is required');
      const p = await c.query(
        `INSERT INTO payments (statement_id, account_no, amount, method, payment_type, or_no, payment_date)
         VALUES ($1,$2,$3,'Cash',$4,$5,current_date) RETURNING payment_id`,
        [statementId, s.account_no, amt, isFull ? 'Full payment' : 'Partial payment', orNo || null]);
      return applyVerifiedPayment(c, p.rows[0].payment_id, req.user.userId, req.user.branchCode);
    });
    res.status(201).json({ orNo: out });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// PATCH /api/staff/payments/:id/verify  |  /reject
router.patch('/payments/:id/verify', async (req, res) => {
  try {
    const orNo = await tx(async c => {
      const p = (await c.query(
        `SELECT p.* FROM payments p JOIN clients cl USING (account_no)
          WHERE p.payment_id=$1 AND cl.branch_code=$2 AND p.status='Pending' FOR UPDATE OF p`,
        [req.params.id, req.user.branchCode])).rows[0];
      if (!p) throw new Error('Pending payment not found in your branch');
      return applyVerifiedPayment(c, p.payment_id, req.user.userId, req.user.branchCode);
    });
    res.json({ orNo });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.patch('/payments/:id/reject', async (req, res) => {
  const r = await query(
    `UPDATE payments p SET status='Rejected', verified_by_staff=$3, verified_at=now()
       FROM clients c WHERE c.account_no=p.account_no AND p.payment_id=$1 AND c.branch_code=$2 AND p.status='Pending'
     RETURNING p.payment_id`, [req.params.id, req.user.branchCode, req.user.userId]);
  if (!r.rowCount) return res.status(404).json({ error: 'Pending payment not found in your branch' });
  await tx(c => logActivity(c, req.user.userId, req.user.branchCode, `Rejected payment #${req.params.id}`));
  res.json({ ok: true });
});

// GET /api/staff/cancellations ; PATCH /api/staff/cancellations/:id  { approve: true|false }
router.get('/cancellations', async (req, res) => {
  const { rows } = await query(
    `SELECT r.*, c.name FROM cancellation_requests r JOIN clients c USING (account_no)
      WHERE c.branch_code=$1 ORDER BY r.created_at DESC`, [req.user.branchCode]);
  res.json(rows);
});

router.patch('/cancellations/:id', async (req, res) => {
  try {
    await tx(async c => {
      const r = (await c.query(
        `SELECT r.* FROM cancellation_requests r JOIN clients cl USING (account_no)
          WHERE r.request_id=$1 AND cl.branch_code=$2 AND r.status='Pending' FOR UPDATE OF r`,
        [req.params.id, req.user.branchCode])).rows[0];
      if (!r) throw new Error('Pending request not found in your branch');
      const approve = !!req.body.approve;
      await c.query(
        'UPDATE cancellation_requests SET status=$2, decided_by_staff=$3, decided_at=now() WHERE request_id=$1',
        [r.request_id, approve ? 'Approved' : 'Rejected', req.user.userId]);
      if (approve)
        await changeStatus(c, r.account_no, 'Terminated', 'Cancellation approved', req.user.userId,
          { termDate: new Date().toISOString().slice(0, 10), termReason: 'Client cancellation' });
      await logActivity(c, req.user.userId, req.user.branchCode, `${approve ? 'Approved' : 'Rejected'} cancellation of ${r.account_no}`);
    });
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// GET /api/staff/activity  (own branch, last 6 months)
router.get('/activity', async (req, res) => {
  const { rows } = await query(
    `SELECT * FROM activity_log WHERE branch_code=$1 AND logged_at >= now() - interval '6 months'
      ORDER BY logged_at DESC LIMIT 200`, [req.user.branchCode]);
  res.json(rows);
});

module.exports = router;
