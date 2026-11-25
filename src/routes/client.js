const router = require('express').Router();
const bcrypt = require('bcrypt');
const { requireAuth, requireRole, requirePasswordChangeComplete } = require('../middleware/auth');
const { query } = require('../db');
const { buildStatementPdf, loadStatement } = require('../services/statementPdf');
const {
  ACCOUNT_SUMMARY_CTES_BY_ACCOUNT,
  buildAccountSummaryCtes
} = require('../services/accountSummary');
const { pagination } = require('../utils/pagination');

router.use(requireAuth, requireRole('client'), requirePasswordChangeComplete);
const wrap = fn => async (req, res, next) => {
  try {
    await fn(req, res, next);
  } catch (err) {
    next(err);
  }
};

// GET /api/client/me  -> account overview (dates are sent as plain YYYY-MM-DD text, no time-zone shifting)
router.get('/me', wrap(async (req, res) => {
  const { rows } = await query(
    `WITH ${ACCOUNT_SUMMARY_CTES_BY_ACCOUNT}
     SELECT c.account_no, c.name, c.email, c.contact_no, c.address,
            summary.effective_status AS status,
            summary.total_balance AS current_balance,
            summary.previous_balance, summary.current_month_due, summary.total_balance,
            CASE WHEN summary.total_balance > 0 THEN 'Unpaid'
                 ELSE COALESCE(summary.latest_payment_status, 'Unpaid') END AS payment_status,
            c.status_reason, c.router_location, c.due_day,
            c.registered_date::text AS registered_date, c.grace_end_date::text AS grace_end_date,
            c.installed_date::text AS installed_date,
            p.plan_name, p.monthly_rate, b.name AS branch,
            summary.has_pending_payment AS has_pending,
            TO_CHAR(summary.current_due_date, 'YYYY-MM-DD') AS current_due_date,
            (SELECT row_to_json(r) FROM (SELECT status, request_date::text AS request_date FROM cancellation_requests
              WHERE account_no = c.account_no ORDER BY request_id DESC LIMIT 1) r) AS cancel
       FROM clients c JOIN plans p ON p.plan_id=c.plan_id
       JOIN branches b ON b.branch_code=c.branch_code
       JOIN account_summary summary ON summary.account_no=c.account_no
      WHERE c.account_no = $1`, [req.user.accountNo]);
  res.json(rows[0]);
}));

// Statement and payment history is served in bounded pages.
router.get('/statements', wrap(async (req, res) => {
  const page = pagination(req);
  const { rows } = await query(
    `WITH ${ACCOUNT_SUMMARY_CTES_BY_ACCOUNT}
     SELECT s.statement_id, s.invoice_no, s.billing_month::text, s.issued_date::text, s.due_date::text, s.amount,
            s.payment_status AS stored_payment_status,
            COALESCE(statement_paid.verified_paid, 0) AS amount_paid,
            GREATEST(s.amount - COALESCE(statement_paid.verified_paid, 0), 0) AS balance,
            summary.previous_balance, summary.current_month_due, summary.total_balance,
            CASE WHEN COALESCE(statement_paid.verified_paid, 0) >= s.amount THEN 'Paid'
                 WHEN COALESCE(statement_paid.verified_paid, 0) > 0 THEN 'Partially paid'
                 ELSE 'Unpaid' END AS payment_status
       FROM v_client_statements s
       JOIN account_summary summary ON summary.account_no=s.account_no
       LEFT JOIN summary_payment_totals statement_paid ON statement_paid.statement_id=s.statement_id
      WHERE s.account_no=$1 ORDER BY s.billing_month DESC LIMIT $2 OFFSET $3`,
    [req.user.accountNo, page.limit, page.offset]);
  res.json(rows);
}));
router.get('/statement-months', wrap(async (req, res) => {
  const { rows } = await query(
    `WITH bounds AS (
       SELECT date_trunc('month', LEAST(
                COALESCE(MIN(s.billing_month), MIN(c.installed_date)),
                COALESCE(MIN(c.installed_date), MIN(s.billing_month))
              ))::date AS first_month,
              date_trunc('month', (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Manila')::date)::date AS last_month
         FROM clients c
         LEFT JOIN statements s ON s.account_no=c.account_no
        WHERE c.account_no=$1
     )
     SELECT TO_CHAR(generated.month_start, 'YYYY-MM') AS month
       FROM bounds
       CROSS JOIN LATERAL generate_series(
         COALESCE(first_month, last_month), last_month, INTERVAL '1 month'
       ) AS generated(month_start)
      ORDER BY generated.month_start DESC`,
    [req.user.accountNo]
  );
  res.json(rows.map(row => row.month));
}));
router.get('/payments', wrap(async (req, res) => {
  const page = pagination(req);
  const { rows } = await query(
    `SELECT payment_id, statement_id, amount, method, payment_type, reference_no, or_no, status, payment_date::text, created_at
       FROM v_client_payments WHERE account_no=$1 ORDER BY created_at DESC, payment_id DESC LIMIT $2 OFFSET $3`,
    [req.user.accountNo, page.limit, page.offset]);
  res.json(rows);
}));
router.get('/notices', wrap(async (req, res) => {          // bell notifications (portal channel), newest first, last 3 months
  const page = pagination(req);
  const { rows } = await query(
    `SELECT n.notice_id, n.notice_type, n.message, n.created_at, (n.read_at IS NOT NULL) AS is_read,
            s.invoice_no, s.amount, s.due_date::text AS due_date
       FROM notices n LEFT JOIN statements s ON s.statement_id = n.statement_id
      WHERE n.account_no=$1 AND n.channel='Portal Notification' AND n.notice_date >= (date_trunc('month', current_date) - interval '3 months')::date
      ORDER BY n.created_at DESC, n.notice_id DESC LIMIT $2 OFFSET $3`,
    [req.user.accountNo, page.limit, page.offset]);
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
  if ((await query(
    `SELECT 1 FROM payments
      WHERE method='GCash' AND reference_no=$1 AND status IN ('Pending','Verified')
      LIMIT 1`, [referenceNo]
  )).rowCount) {
    return res.status(409).json({ error: 'This GCash reference number has already been submitted or verified.' });
  }

  const s = (await query(
    `WITH ${buildAccountSummaryCtes('account', 2)}
     SELECT s.*, summary.effective_status AS client_status,
            summary.previous_balance, summary.current_month_due, summary.total_balance,
            COALESCE(paid.verified_paid, 0) AS verified_paid,
            s.due_date < (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Manila')::date AS is_past_due,
            GREATEST(s.amount - COALESCE(paid.verified_paid, 0), 0) AS remaining_balance
       FROM statements s JOIN clients c ON c.account_no=s.account_no
       JOIN account_summary summary ON summary.account_no=c.account_no
       LEFT JOIN summary_payment_totals paid ON paid.statement_id=s.statement_id
      WHERE s.statement_id=$1 AND s.account_no=$2`, [statementId, req.user.accountNo])).rows[0];
  if (!s) return res.status(404).json({ error: 'Statement not found' });
  const remainingBalance = Number(s.remaining_balance);
  const verifiedPaid = Number(s.verified_paid);
  const partialStatement = verifiedPaid > 0 || String(s.payment_status).toLowerCase() === 'partially paid';
  const terminated = String(s.client_status).toLowerCase() === 'terminated';
  if (remainingBalance <= 0) return res.status(400).json({ error: 'Already fully paid' });
  if ((await query("SELECT 1 FROM payments WHERE account_no=$1 AND status='Pending'", [req.user.accountNo])).rowCount)
    return res.status(409).json({ error: 'You already have a payment waiting for staff verification' });

  const amt = Number(amount);
  if (!(amt > 0) || amt > remainingBalance) return res.status(400).json({ error: 'Invalid amount' });
  const pastDue = s.is_past_due;
  const isFull = amt === remainingBalance;
  if ((partialStatement || terminated) && !isFull)
    return res.status(400).json({ error: terminated
      ? 'Terminated accounts must pay the full remaining balance.'
      : 'A partially paid statement requires full payment of its remaining balance.' });
  if (pastDue && !isFull) return res.status(400).json({ error: 'After the due date the full balance is required' });

  try {
    const r = await query(
      `INSERT INTO payments (statement_id, account_no, amount, method, payment_type, reference_no, payment_date)
       VALUES ($1,$2,$3,'GCash',$4,$5,current_date) RETURNING payment_id, status`,
      [statementId, req.user.accountNo, amt, isFull ? 'Full payment' : 'Partial payment', referenceNo]);
    res.status(201).json(r.rows[0]);
  } catch (e) {
    if (e.code === '23505' && e.constraint === 'uq_payments_gcash_reference_active') {
      return res.status(409).json({ error: 'This GCash reference number has already been submitted or verified.' });
    }
    if (e.code === '23505' && e.constraint === 'uq_payments_one_pending_per_account') {
      return res.status(409).json({ error: 'You already have a payment waiting for staff verification.' });
    }
    next500(res, e);
  }
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
  if (open.rowCount) return res.status(409).json({ error: 'You already have a pending request.' });
  try {
    const r = await query(
      `INSERT INTO cancellation_requests (account_no, request_date, reason) VALUES ($1,current_date,$2) RETURNING request_id, status`,
      [req.user.accountNo, reason]);
    res.status(201).json(r.rows[0]);
  } catch (e) {
    if (e.code === '23505' && e.constraint === 'uq_cancellations_one_pending_per_account') {
      return res.status(409).json({ error: 'You already have a pending request.' });
    }
    next500(res, e);
  }
}));

function next500(res, e) {
  console.error('Client API request failed:', e && (e.code || e.name) || 'Error');
  res.status(500).json({ error: 'Server error' });
}
module.exports = router;
