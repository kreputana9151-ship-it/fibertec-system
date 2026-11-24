const router = require('express').Router();
const bcrypt = require('bcrypt');
const { requireAuth, requireRole } = require('../middleware/auth');
const { query } = require('../db');
const { buildStatementPdf, loadStatement } = require('../services/statementPdf');

router.use(requireAuth, requireRole('client'));
const wrap = fn => (req, res, next) => fn(req, res, next).catch(next);

// GET /api/client/me  -> account overview (dates are sent as plain YYYY-MM-DD text, no time-zone shifting)
router.get('/me', wrap(async (req, res) => {
  const { rows } = await query(
    `SELECT c.account_no, c.name, c.email, c.contact_no, c.address, c.status,
            COALESCE(latest.balance, 0) AS current_balance, latest.payment_status,
            c.status_reason, c.router_location, c.due_day,
            c.registered_date::text AS registered_date, c.grace_end_date::text AS grace_end_date,
            p.plan_name, p.monthly_rate, b.name AS branch,
            EXISTS (SELECT 1 FROM payments y WHERE y.account_no = c.account_no AND y.status = 'Pending') AS has_pending,
            (SELECT row_to_json(r) FROM (SELECT status, request_date::text AS request_date FROM cancellation_requests
              WHERE account_no = c.account_no ORDER BY request_id DESC LIMIT 1) r) AS cancel
       FROM clients c JOIN plans p USING (plan_id) JOIN branches b USING (branch_code)
       LEFT JOIN LATERAL (
         SELECT GREATEST(s.amount - COALESCE(v.verified_paid, 0), 0) AS balance,
                CASE WHEN COALESCE(v.verified_paid, 0) >= s.amount THEN 'Paid'
                     WHEN COALESCE(v.verified_paid, 0) > 0 THEN 'Partially paid'
                     ELSE 'Unpaid' END AS payment_status
           FROM statements s
           LEFT JOIN LATERAL (
             SELECT COALESCE(SUM(pm.amount), 0) AS verified_paid
               FROM payments pm
              WHERE pm.statement_id=s.statement_id AND pm.status='Verified'
           ) v ON TRUE
          WHERE s.account_no=c.account_no
          ORDER BY s.billing_month DESC LIMIT 1
       ) latest ON TRUE
      WHERE c.account_no = $1`, [req.user.accountNo]);
  res.json(rows[0]);
}));

// the history endpoints read the 3-month VIEWS (older data is hidden from clients)
router.get('/statements', wrap(async (req, res) => {
  const { rows } = await query(
    `SELECT s.statement_id, s.invoice_no, s.billing_month::text, s.bill_date::text, s.due_date::text, s.amount,
            s.payment_status AS stored_payment_status,
            COALESCE(v.verified_paid, 0) AS amount_paid,
            GREATEST(s.amount - COALESCE(v.verified_paid, 0), 0) AS balance,
            CASE WHEN COALESCE(v.verified_paid, 0) >= s.amount THEN 'Paid'
                 WHEN COALESCE(v.verified_paid, 0) > 0 THEN 'Partially paid'
                 ELSE 'Unpaid' END AS payment_status
       FROM v_client_statements s
       LEFT JOIN LATERAL (
         SELECT COALESCE(SUM(p.amount), 0) AS verified_paid
           FROM payments p
          WHERE p.statement_id=s.statement_id AND p.status='Verified'
       ) v ON TRUE
      WHERE s.account_no=$1 ORDER BY s.billing_month DESC`, [req.user.accountNo]);
  res.json(rows);
}));
router.get('/payments', wrap(async (req, res) => {
  const { rows } = await query(
    `SELECT payment_id, statement_id, amount, method, payment_type, reference_no, or_no, status, payment_date::text, created_at
       FROM v_client_payments WHERE account_no=$1 ORDER BY created_at DESC`, [req.user.accountNo]);
  res.json(rows);
}));
router.get('/notices', wrap(async (req, res) => {          // bell notifications (portal channel), newest first, last 3 months
  const { rows } = await query(
    `SELECT n.notice_id, n.notice_type, n.message, n.created_at, (n.read_at IS NOT NULL) AS is_read,
            s.invoice_no, s.amount, s.due_date::text AS due_date
       FROM notices n LEFT JOIN statements s ON s.statement_id = n.statement_id
      WHERE n.account_no=$1 AND n.channel='Portal Notification' AND n.notice_date >= (date_trunc('month', current_date) - interval '3 months')::date
      ORDER BY n.created_at DESC, n.notice_id DESC`, [req.user.accountNo]);
  res.json(rows);
}));
router.post('/notices/read-all', wrap(async (req, res) => {
  await query("UPDATE notices SET read_at=now() WHERE account_no=$1 AND channel='Portal Notification' AND read_at IS NULL", [req.user.accountNo]);
  res.json({ ok: true });
}));
router.post('/notices/:id/read', wrap(async (req, res) => {
  if (!/^[0-9]+$/.test(req.params.id)) return res.status(400).json({ error: 'Invalid notice' });
  await query("UPDATE notices SET read_at=COALESCE(read_at, now()) WHERE notice_id=$1 AND account_no=$2 AND channel='Portal Notification'", [req.params.id, req.user.accountNo]);
  res.json({ ok: true });
}));

// GET /api/client/statements/:id/pdf  -> downloadable e-Statement
router.get('/statements/:id/pdf', wrap(async (req, res) => {
  if (!/^[0-9]+$/.test(req.params.id)) return res.status(400).json({ error: 'Invalid statement' });
  const own = await query('SELECT 1 FROM v_client_statements WHERE statement_id=$1 AND account_no=$2', [req.params.id, req.user.accountNo]);
  const d = own.rowCount ? await loadStatement(query, req.params.id) : null;
  if (!d) return res.status(404).json({ error: 'Statement not found' });
  const { s, pays } = d;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="FiberTec-Statement-${s.invoice_no.replace(/[^A-Za-z0-9-]+/g, '')}.pdf"`);
  buildStatementPdf(res, s, pays);
}));

// POST /api/client/payments  { statementId, amount, referenceNo }   (GCash reference, goes to Pending = joins the staff FIFO queue)
// Rules: partial only on/before due date; after the due date the FULL balance is required.
router.post('/payments', wrap(async (req, res) => {
  const body = req.body || {};
  const { statementId, amount } = body;
  const referenceNo = body.referenceNo || body.reference_no || body.ref_no;
  if (typeof referenceNo !== 'string') return res.status(400).json({ error: 'GCash reference must be a 13-digit string.' });
  if (/\s/.test(referenceNo)) return res.status(400).json({ error: 'GCash reference must not contain whitespace.' });
  if (!/^[0-9]{13}$/.test(referenceNo)) return res.status(400).json({ error: 'GCash reference must be 13 digits' });

  const s = (await query(
    `SELECT s.*, COALESCE(v.verified_paid, 0) AS verified_paid,
            GREATEST(s.amount - COALESCE(v.verified_paid, 0), 0) AS remaining_balance
       FROM statements s
       LEFT JOIN LATERAL (
         SELECT COALESCE(SUM(p.amount), 0) AS verified_paid
           FROM payments p
          WHERE p.statement_id=s.statement_id AND p.status='Verified'
       ) v ON TRUE
      WHERE s.statement_id=$1 AND s.account_no=$2`, [statementId, req.user.accountNo])).rows[0];
  if (!s) return res.status(404).json({ error: 'Statement not found' });
  const remainingBalance = Number(s.remaining_balance);
  const verifiedPaid = Number(s.verified_paid);
  const partialStatement = verifiedPaid > 0 || String(s.payment_status).toLowerCase() === 'partially paid';
  if (remainingBalance <= 0) return res.status(400).json({ error: 'Already fully paid' });
  if ((await query("SELECT 1 FROM payments WHERE account_no=$1 AND status='Pending'", [req.user.accountNo])).rowCount)
    return res.status(409).json({ error: 'You already have a payment waiting for staff verification' });

  const amt = Number(amount);
  if (!(amt > 0) || amt > remainingBalance) return res.status(400).json({ error: 'Invalid amount' });
  const pastDue = new Date(s.due_date) < new Date(new Date().toDateString());
  const isFull = amt === remainingBalance;
  if (partialStatement && !isFull) return res.status(400).json({ error: 'A partially paid statement requires full payment of its remaining balance.' });
  if (pastDue && !isFull) return res.status(400).json({ error: 'After the due date the full balance is required' });

  try {
    const r = await query(
      `INSERT INTO payments (statement_id, account_no, amount, method, payment_type, reference_no, payment_date)
       VALUES ($1,$2,$3,'GCash',$4,$5,current_date) RETURNING payment_id, status`,
      [statementId, req.user.accountNo, amt, isFull ? 'Full payment' : 'Partial payment', referenceNo]);
    res.status(201).json(r.rows[0]);
  } catch (e) { next500(res, e); }
}));

// POST /api/client/cancellation  { reason, password }   (the client confirms with their password)
router.post('/cancellation', wrap(async (req, res) => {
  const { reason, password } = req.body || {};
  if (!reason) return res.status(400).json({ error: 'Reason required' });
  if (typeof password !== 'string' || !password) return res.status(400).json({ error: 'Password required.' });
  if (/\s/.test(password)) return res.status(400).json({ error: 'Password must not contain whitespace.' });
  const u = (await query('SELECT password_hash FROM users WHERE user_id=$1', [req.user.userId])).rows[0];
  if (!u || !(await bcrypt.compare(password, u.password_hash))) return res.status(403).json({ error: 'Incorrect password. Cancellation was not submitted.' });
  const open = await query("SELECT 1 FROM cancellation_requests WHERE account_no=$1 AND status='Pending'", [req.user.accountNo]);
  if (open.rowCount) return res.status(409).json({ error: 'You already have a pending request' });
  const r = await query(
    `INSERT INTO cancellation_requests (account_no, request_date, reason) VALUES ($1,current_date,$2) RETURNING request_id, status`,
    [req.user.accountNo, reason]);
  res.status(201).json(r.rows[0]);
}));

function next500(res, e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
module.exports = router;
