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

// ---- Payments Verification Queue: single-server FIFO (M/M/1) ----
// Oldest pending submission = Queue #1. Ties on created_at are broken by payment_id so the order never changes.
const FIFO_ORDER = 'ORDER BY p.created_at ASC, p.payment_id ASC';
async function lockQueue(c, branchCode) { await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['fifo-' + branchCode]); }   // one server: requests of a branch are handled one at a time
async function assertHead(c, branchCode, id) {
  const h = (await c.query(`SELECT p.payment_id FROM payments p JOIN clients cl USING (account_no)
                             WHERE cl.branch_code=$1 AND p.status='Pending' ${FIFO_ORDER} LIMIT 1`, [branchCode])).rows[0];
  if (!h || Number(h.payment_id) !== Number(id)) throw Object.assign(new Error('FIFO: process Queue #1 (the oldest pending payment) first'), { status: 409 });
}

// GET /api/staff/payments/queue -> the buffer in FIFO order + live M/M/1 numbers
router.get('/payments/queue', async (req, res) => {
  const bc = req.user.branchCode;
  const q = (await query(
    `SELECT ROW_NUMBER() OVER (${FIFO_ORDER}) AS queue_no, p.payment_id, p.account_no, c.name, p.amount, p.payment_type, p.method,
            p.reference_no, p.created_at AS submitted_at, EXTRACT(EPOCH FROM (now() - p.created_at))::int AS waiting_seconds
       FROM payments p JOIN clients c USING (account_no)
      WHERE c.branch_code=$1 AND p.status='Pending' ${FIFO_ORDER}`, [bc])).rows;
  const m = (await query(
    `WITH done AS (SELECT p.created_at, p.verified_at, LAG(p.verified_at) OVER (ORDER BY p.verified_at) AS prev_done
                     FROM payments p JOIN clients c USING (account_no)
                    WHERE c.branch_code=$1 AND p.verified_at >= now() - interval '24 hours')
     SELECT (SELECT COUNT(*) FROM payments p JOIN clients c USING (account_no)
              WHERE c.branch_code=$1 AND p.method='GCash' AND p.created_at >= now() - interval '1 hour')::int AS arrivals_last_hour,
            AVG(EXTRACT(EPOCH FROM (verified_at - GREATEST(created_at, COALESCE(prev_done, created_at))))) AS avg_service_seconds
       FROM done`, [bc])).rows[0];
  const lambda = Number(m.arrivals_last_hour), svc = m.avg_service_seconds === null ? null : Number(m.avg_service_seconds);
  const mu = svc ? 3600 / svc : null;
  res.json({ queue: q, metrics: {
    Lq: q.length, lambda_per_hour: lambda, mu_per_hour: mu, rho: mu ? lambda / mu : null,
    avg_wait_seconds: q.length ? q.reduce((a, r) => a + r.waiting_seconds, 0) / q.length : 0,
    longest_wait_seconds: q.length ? q[0].waiting_seconds : 0 } });
});

// GET /api/staff/statements/open?q=  -> unpaid statements of this branch (for the cash entry)
router.get('/statements/open', async (req, res) => {
  const { rows } = await query(
    `SELECT s.statement_id, s.account_no, c.name, s.amount, s.balance, s.due_date, pl.monthly_rate
       FROM statements s JOIN clients c USING (account_no) JOIN plans pl USING (plan_id)
      WHERE c.branch_code=$1 AND s.balance > 0 AND (c.name ILIKE $2 OR c.account_no LIKE $2)
      ORDER BY s.due_date, s.account_no LIMIT 20`, [req.user.branchCode, `%${req.query.q || ''}%`]);
  res.json(rows);
});

// GET /api/staff/payments?status=Pending
router.get('/payments', async (req, res) => {
  const { rows } = await query(
    `SELECT p.*, c.name FROM payments p JOIN clients c USING (account_no)
      WHERE c.branch_code=$1 AND ($2::text IS NULL OR p.status=$2)
      ORDER BY CASE WHEN p.status='Pending' THEN p.created_at END ASC, p.created_at DESC LIMIT 500`, [req.user.branchCode, req.query.status || null]);   // Pending: oldest first (FIFO)
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
      await lockQueue(c, req.user.branchCode); await assertHead(c, req.user.branchCode, req.params.id);   // only Queue #1
      const p = (await c.query(
        `SELECT p.* FROM payments p JOIN clients cl USING (account_no)
          WHERE p.payment_id=$1 AND cl.branch_code=$2 AND p.status='Pending' FOR UPDATE OF p`,
        [req.params.id, req.user.branchCode])).rows[0];
      if (!p) throw new Error('Pending payment not found in your branch');
      return applyVerifiedPayment(c, p.payment_id, req.user.userId, req.user.branchCode);
    });
    res.json({ orNo });
  } catch (e) { res.status(e.status || 400).json({ error: e.message }); }
});

router.patch('/payments/:id/reject', async (req, res) => {
  try {
    await tx(async c => {
      await lockQueue(c, req.user.branchCode); await assertHead(c, req.user.branchCode, req.params.id);   // only Queue #1
      await c.query(`UPDATE payments SET status='Rejected', verified_by_staff=$2, verified_at=now() WHERE payment_id=$1`, [req.params.id, req.user.userId]);
      await logActivity(c, req.user.userId, req.user.branchCode, `Rejected payment #${req.params.id}`);
    });
    res.json({ ok: true });
  } catch (e) { res.status(e.status || 400).json({ error: e.message }); }
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
