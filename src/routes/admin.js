const router = require('express').Router();
const { requireAuth, requireRole } = require('../middleware/auth');
const { query, tx } = require('../db');
const { sendStatement, generateStatementsForToday, runStatusEngine } = require('../services/billing');
const { changeStatus, logActivity } = require('../services/audit');
const { sendEmail } = require('../services/mailer');

router.use(requireAuth, requireRole('admin'));
// admin sees ALL branches. History shown to admin = last 6 months (purge job deletes older rows)

const SIX = "date_trunc('month', current_date) - interval '6 months'";

function selectedMonth(value) {
  if (!value) return null;
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(value) ? value : false;
}

const periodAnalyticsSql = `
  WITH branch_scope AS (
    SELECT branch_code, name FROM branches
     WHERE ($2::text IS NULL OR branch_code=$2)
  ),
  status_snapshot AS (
    SELECT c.account_no, c.branch_code,
           CASE
             WHEN $1::text IS NULL OR $1=TO_CHAR(current_date, 'YYYY-MM') THEN c.status
             ELSE COALESCE((
               SELECT h.new_status
                 FROM account_status_log h
                WHERE h.account_no=c.account_no
                  AND TO_CHAR(h.changed_at, 'YYYY-MM') <= $1
                ORDER BY h.changed_at DESC, h.log_id DESC
                LIMIT 1
             ), 'Active')
           END AS status
      FROM clients c
     WHERE $1::text IS NULL
        OR c.registered_date < (TO_DATE($1, 'YYYY-MM') + INTERVAL '1 month')::date
  ),
  client_totals AS (
    SELECT c.branch_code, COUNT(*)::int AS client_count,
           COUNT(*) FILTER (WHERE c.status='Active')::int AS active_count
      FROM status_snapshot c JOIN branch_scope b USING (branch_code)
     GROUP BY c.branch_code
  ),
  statement_totals AS (
    SELECT c.branch_code, COALESCE(SUM(s.amount),0) AS billed,
           COALESCE(SUM(paid.verified_paid),0) AS collected,
           COUNT(s.statement_id)::int AS statement_count,
           COUNT(*) FILTER (WHERE s.send_status='Delivered')::int AS delivered_count
      FROM branch_scope b
      LEFT JOIN clients c USING (branch_code)
      LEFT JOIN statements s ON s.account_no=c.account_no
        AND ($1::text IS NULL OR TO_CHAR(s.billing_month, 'YYYY-MM')=$1)
      LEFT JOIN LATERAL (
        SELECT COALESCE(SUM(p.amount), 0) AS verified_paid
          FROM payments p
         WHERE p.statement_id=s.statement_id AND p.status='Verified'
      ) paid ON TRUE
     GROUP BY c.branch_code
  ),
  registration_totals AS (
    SELECT c.branch_code, COUNT(*)::int AS registrations
      FROM clients c JOIN branch_scope b USING (branch_code)
     WHERE ($1::text IS NULL OR TO_CHAR(c.registered_date, 'YYYY-MM')=$1)
     GROUP BY c.branch_code
  ),
  cancellation_totals AS (
    SELECT c.branch_code, COUNT(*)::int AS cancellations
      FROM cancellation_requests r
      JOIN clients c USING (account_no)
      JOIN branch_scope b USING (branch_code)
     WHERE r.status='Approved'
       AND ($1::text IS NULL OR TO_CHAR(COALESCE(r.decided_at::date, r.request_date), 'YYYY-MM')=$1)
     GROUP BY c.branch_code
  ),
  branch_data AS (
    SELECT b.branch_code, b.name AS branch,
           COALESCE(ct.client_count,0) AS clients,
           COALESCE(ct.active_count,0) AS active,
           COALESCE(st.billed,0) AS billed,
           COALESCE(st.collected,0) AS collected,
           CASE WHEN COALESCE(st.billed,0)=0 THEN 0
                ELSE ROUND(COALESCE(st.collected,0)/st.billed*100,1) END AS collection_efficiency,
           COALESCE(st.statement_count,0) AS statements,
           COALESCE(st.delivered_count,0) AS delivered,
           COALESCE(rt.registrations,0) AS registrations,
           COALESCE(xt.cancellations,0) AS cancellations
      FROM branch_scope b
      LEFT JOIN client_totals ct USING (branch_code)
      LEFT JOIN statement_totals st USING (branch_code)
      LEFT JOIN registration_totals rt USING (branch_code)
      LEFT JOIN cancellation_totals xt USING (branch_code)
  ),
  status_data AS (
    SELECT c.status, COUNT(*)::int AS count
      FROM status_snapshot c JOIN branch_scope b USING (branch_code)
     GROUP BY c.status
  )
  SELECT
    COALESCE((SELECT json_agg(json_build_object(
      'branch_code', branch_code, 'branch', branch, 'clients', clients, 'active', active,
      'billed', billed, 'collected', collected, 'collection_efficiency', collection_efficiency,
      'statements', statements, 'delivered', delivered, 'registrations', registrations,
      'cancellations', cancellations
    ) ORDER BY branch_code) FROM branch_data), '[]'::json) AS branches,
    COALESCE((SELECT json_agg(json_build_object('status', status, 'count', count) ORDER BY status)
                FROM status_data), '[]'::json) AS statuses,
    COALESCE((SELECT json_agg(payment) FROM (
      SELECT json_build_object(
        'payment_id', p.payment_id, 'account_no', p.account_no, 'name', c.name,
        'branch', b.name, 'amount', p.amount, 'status', p.status,
        'payment_date', COALESCE(p.payment_date, p.created_at::date)::text
      ) AS payment
        FROM payments p
        JOIN clients c USING (account_no)
        JOIN branch_scope b USING (branch_code)
       WHERE ($1::text IS NULL OR TO_CHAR(COALESCE(p.payment_date, p.created_at::date), 'YYYY-MM')=$1)
       ORDER BY COALESCE(p.payment_date, p.created_at::date) DESC, p.payment_id DESC
       LIMIT 12
    ) recent), '[]'::json) AS recent_payments`;

async function loadPeriodAnalytics(month, branchCode) {
  const { rows } = await query(periodAnalyticsSql, [month, branchCode || null]);
  return rows[0];
}

// GET /api/admin/months -> months with statements or payments, plus the current month
router.get('/months', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT DISTINCT month
         FROM (
           SELECT TO_CHAR(billing_month, 'YYYY-MM') AS month FROM statements
           UNION ALL
           SELECT TO_CHAR(COALESCE(payment_date, created_at::date), 'YYYY-MM') FROM payments
           UNION ALL
           SELECT TO_CHAR(current_date, 'YYYY-MM')
         ) available_months
        ORDER BY month DESC`
    );
    res.json(rows.map(r => r.month));
  } catch (e) {
    console.error('GET /api/admin/months error:', e);
    res.status(500).json({ error: 'Could not load billing months.' });
  }
});

// GET /api/admin/dashboard?month=2026-10&branch=04
router.get('/dashboard', async (req, res) => {
  const month = selectedMonth(req.query.month);
  if (month === false) return res.status(400).json({ error: 'Month must use YYYY-MM format.' });
  try {
    res.json(await loadPeriodAnalytics(month, req.query.branch));
  } catch (e) {
    console.error('GET /api/admin/dashboard error:', e);
    res.status(500).json({ error: 'Could not load dashboard analytics.' });
  }
});

// GET /api/admin/cancellations?branch=04
router.get('/cancellations', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT r.request_id, r.account_no, r.request_date, r.reason, r.status,
              c.name, b.name AS branch
         FROM cancellation_requests r
         JOIN clients c USING (account_no)
         JOIN branches b USING (branch_code)
        WHERE r.status='Pending'
          AND ($1::text IS NULL OR c.branch_code::text=$1::text)
           AND NOT EXISTS (
             SELECT 1 FROM account_status_log h
              WHERE h.account_no=c.account_no
                AND h.new_status='Active'
                AND h.changed_at > r.created_at
           )
        ORDER BY r.created_at DESC, r.request_id DESC`,
      [req.query.branch || null]
    );
    res.json(rows);
  } catch (e) {
    console.error('GET /api/admin/cancellations error:', e);
    res.status(500).json({ error: 'Could not load pending cancellation requests.' });
  }
});

// GET /api/admin/clients?branch=04&status=Active
router.get('/clients', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT c.account_no,
                c.name,
                c.contact_no,
                c.address,
                b.name AS branch,
                c.plan_id,
                p.plan_name,
                p.monthly_rate,
                COALESCE(latest.balance, 0) AS current_balance,
                COALESCE(latest.balance, 0) AS outstanding_balance,
                CASE WHEN c.status='Terminated' AND latest.balance IS NOT NULL
                     THEN CASE WHEN latest.balance > 0 THEN 'Unpaid' ELSE 'Paid' END
                     ELSE latest.payment_status END AS payment_status,
                COALESCE(latest.has_pending_payment, FALSE) AS has_pending_payment,
                TO_CHAR(latest.due_date, 'YYYY-MM-DD') AS current_due_date,
              c.status,
              c.status_reason,
              c.due_day,
              c.email,
              c.facebook,
              c.router_location,
              TO_CHAR(c.registered_date, 'YYYY-MM-DD') AS registered_date,
              TO_CHAR(c.termination_date, 'YYYY-MM-DD') AS termination_date,
              TO_CHAR(c.registered_date, 'YYYY-MM') AS created_month,
              TO_CHAR(c.termination_date, 'YYYY-MM') AS terminated_month,
              TO_CHAR(c.registered_date, 'YYYY-MM-DD') AS created_at,
              TO_CHAR(c.termination_date, 'YYYY-MM-DD') AS updated_at,
              TO_CHAR(c.flagged_date, 'YYYY-MM-DD') AS flagged_date,
              TO_CHAR(c.grace_end_date, 'YYYY-MM-DD') AS grace_end_date
         FROM clients c
         JOIN branches b USING (branch_code)
         JOIN plans p USING (plan_id)
         LEFT JOIN LATERAL (
           SELECT s.due_date,
                  GREATEST(s.amount - COALESCE(paid.verified_paid, 0), 0) AS balance,
                  CASE WHEN COALESCE(paid.verified_paid, 0) >= s.amount THEN 'Paid'
                       WHEN COALESCE(paid.verified_paid, 0) > 0 THEN 'Partially paid'
                       ELSE 'Unpaid' END AS payment_status,
                  paid.has_pending_payment
             FROM statements s
             LEFT JOIN LATERAL (
               SELECT COALESCE(SUM(pm.amount) FILTER (WHERE pm.status='Verified'), 0) AS verified_paid,
                      COALESCE(BOOL_OR(pm.status='Pending'), FALSE) AS has_pending_payment
                 FROM payments pm WHERE pm.statement_id=s.statement_id
             ) paid ON TRUE
            WHERE s.account_no=c.account_no
            ORDER BY s.billing_month DESC LIMIT 1
         ) latest ON TRUE
        WHERE ($1::text IS NULL OR c.branch_code=$1) AND ($2::text IS NULL OR c.status=$2)
        ORDER BY c.branch_code, c.client_seq`,
      [req.query.branch || null, req.query.status || null]
    );
    res.json(rows);
  } catch (e) {
    console.error('GET /api/admin/clients error:', e);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/statements?month=2026-10&branch=04
router.get('/statements', async (req, res) => {
  const month = selectedMonth(req.query.month);
  if (month === false) return res.status(400).json({ error: 'Month must use YYYY-MM format.' });
  const { rows } = await query(
    `SELECT s.statement_id, s.invoice_no, s.account_no, s.billing_month, s.issued_date, s.due_date, s.amount,
            COALESCE(v.verified_paid, 0) AS amount_paid,
            GREATEST(s.amount - COALESCE(v.verified_paid, 0), 0) AS balance,
            CASE WHEN COALESCE(v.verified_paid, 0) >= s.amount THEN 'Paid'
                 WHEN COALESCE(v.verified_paid, 0) > 0 THEN 'Partially paid'
                 ELSE 'Unpaid' END AS payment_status,
            s.send_status, s.sent_by_admin, s.sent_at, s.created_at, c.name, c.branch_code
       FROM statements s JOIN clients c USING (account_no)
       LEFT JOIN LATERAL (
         SELECT COALESCE(SUM(p.amount), 0) AS verified_paid
           FROM payments p
          WHERE p.statement_id=s.statement_id AND p.status='Verified'
       ) v ON TRUE
      WHERE ($1::text IS NULL OR TO_CHAR(s.billing_month, 'YYYY-MM')=$1)
        AND ($2::text IS NULL OR c.branch_code=$2)
      ORDER BY s.billing_month DESC, s.account_no`, [month, req.query.branch || null]);
  res.json(rows);
});

// GET /api/admin/payments?month=2026-11&branch=04&status=Verified
router.get('/payments', async (req, res) => {
  const month = selectedMonth(req.query.month);
  if (month === false) return res.status(400).json({ error: 'Month must use YYYY-MM format.' });
  const { rows } = await query(
    `SELECT p.*, c.name, c.branch_code, b.name AS branch
       FROM payments p
       JOIN clients c USING (account_no)
       JOIN branches b ON b.branch_code = c.branch_code
      WHERE ($1::text IS NULL OR TO_CHAR(COALESCE(p.payment_date, p.created_at::date), 'YYYY-MM') = $1)
        AND ($2::text IS NULL OR c.branch_code = $2)
        AND ($3::text IS NULL OR p.status = $3)
      ORDER BY COALESCE(p.payment_date, p.created_at::date) DESC, p.payment_id DESC`,
    [month, req.query.branch || null, req.query.status || null]
  );
  res.json(rows);
});

// POST /api/admin/statements/generate  -> run generation now (for demo / testing)
router.post('/statements/generate', async (req, res) => {
  const created = await generateStatementsForToday();
  res.json({ created });
});

// POST /api/admin/statements/:id/send   (send or re-send one statement)
router.post('/statements/:id/send', async (req, res) => {
  try {
    const ok = await sendStatement(req.params.id, req.user.userId);
    await tx(c => logActivity(c, req.user.userId, null, `Sent statement #${req.params.id} (${ok ? 'Delivered' : 'Failed'})`));
    res.json({ delivered: ok });
  } catch (e) { res.status(404).json({ error: e.message }); }
});

// GET /api/admin/notices?status=Failed
router.get('/notices', async (req, res) => {
  const { rows } = await query(
    `SELECT n.*, c.name FROM notices n JOIN clients c USING (account_no)
      WHERE n.notice_date >= (${SIX}) AND ($1::text IS NULL OR n.delivery_status=$1)
      ORDER BY n.created_at DESC LIMIT 500`, [req.query.status || null]);
  res.json(rows);
});

// POST /api/admin/notices/:id/resend
router.post('/notices/:id/resend', async (req, res) => {
  const n = (await query('SELECT * FROM notices WHERE notice_id=$1', [req.params.id])).rows[0];
  if (!n) return res.status(404).json({ error: 'Notice not found' });
  const ok = n.channel === 'Email' ? await sendEmail(n.recipient, n.notice_type, n.message || 'Resent notice') : true;
  await tx(async c => {
    await c.query('UPDATE notices SET delivery_status=$2, resent_by_admin=$3 WHERE notice_id=$1',
      [n.notice_id, ok ? 'Sent' : 'Failed', req.user.userId]);
    await logActivity(c, req.user.userId, null, `Resent notice #${n.notice_id}`);
  });
  res.json({ delivered: ok });
});

// PATCH /api/admin/clients/:accountNo
router.patch('/clients/:accountNo', async (req, res) => {
  if (/\s/.test(req.params.accountNo)) return res.status(400).json({ error: 'Account number must not contain whitespace.' });
  const b = req.body || {};
  const name = String(b.name || '').trim();
  const contactNo = String(b.contactNo || '').trim();
  const email = typeof b.email === 'string' ? b.email.toLowerCase() : '';
  const address = String(b.address || '').trim();
  const planId = Number(b.planId);
  const facebook = String(b.facebook || '').trim() || null;
  const routerLocation = String(b.routerLocation || '').trim() || null;

  if (!name || !contactNo || !email || !address || !Number.isInteger(planId)) {
    return res.status(400).json({ error: 'Please complete the client name, contact number, email, address, and plan.' });
  }
  if (/\s/.test(email)) {
    return res.status(400).json({ error: 'Client email must not contain whitespace.' });
  }
  if (!/^09[0-9]{9}$/.test(contactNo)) {
    return res.status(400).json({ error: 'Mobile number must be 11 digits starting with 09.' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Please enter a valid client email address.' });
  }
  if (name.length > 100 || contactNo.length > 15 || email.length > 100 ||
      address.length > 255 || (facebook && facebook.length > 100) ||
      (routerLocation && routerLocation.length > 150)) {
    return res.status(400).json({ error: 'One or more client fields exceed the allowed length.' });
  }

  try {
    await tx(async c => {
      const dup = await c.query(
        'SELECT 1 FROM clients WHERE LOWER(email)=$1 AND account_no<>$2 LIMIT 1',
        [email, req.params.accountNo]
      );
      if (dup.rows.length) throw new Error('Another client account already uses this email address.');
      const plan = await c.query('SELECT 1 FROM plans WHERE plan_id=$1', [planId]);
      if (!plan.rows.length) throw new Error('Selected internet plan was not found.');

      const updated = await c.query(
        `UPDATE clients
            SET name=$2, contact_no=$3, email=$4, address=$5, plan_id=$6,
                router_location=$7, facebook=$8
          WHERE account_no=$1`,
        [req.params.accountNo, name, contactNo, email, address, planId, routerLocation, facebook]
      );
      if (!updated.rowCount) throw new Error('Client not found.');
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// PATCH /api/admin/clients/:accountNo/status  { status: 'Active'|'Terminated', reason }
router.patch('/clients/:accountNo/status', async (req, res) => {
  if (/\s/.test(req.params.accountNo)) return res.status(400).json({ error: 'Account number must not contain whitespace.' });
  const { status, reason } = req.body || {};
  if (!['Active', 'Terminated'].includes(status)) return res.status(400).json({ error: 'Use Active or Terminated' });
  try {
    await tx(async c => {
      const extra = status === 'Terminated' ? { termReason: reason || 'Admin decision' } : {};
      await changeStatus(c, req.params.accountNo, status, reason || (status === 'Active' ? 'Reinstated by admin' : 'Terminated by admin'), req.user.userId, extra);
      await logActivity(c, req.user.userId, null, `Set ${req.params.accountNo} to ${status}`);
    });
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// GET /api/admin/clients/:accountNo/status-log
router.get('/clients/:accountNo/status-log', async (req, res) => {
  if (/\s/.test(req.params.accountNo)) return res.status(400).json({ error: 'Account number must not contain whitespace.' });
  const { rows } = await query('SELECT * FROM account_status_log WHERE account_no=$1 ORDER BY changed_at DESC', [req.params.accountNo]);
  res.json(rows);
});

// GET /api/admin/analytics?month=2026-10&branch=04
router.get('/analytics', async (req, res) => {
  const month = selectedMonth(req.query.month);
  if (month === false) return res.status(400).json({ error: 'Month must use YYYY-MM format.' });
  try {
    res.json(await loadPeriodAnalytics(month, req.query.branch));
  } catch (e) {
    console.error('GET /api/admin/analytics error:', e);
    res.status(500).json({ error: 'Could not load branch analytics.' });
  }
});

// GET /api/admin/activity?branch=04  (6 months)
router.get('/activity', async (req, res) => {
  const { rows } = await query(
    `SELECT a.*, u.login_id FROM activity_log a JOIN users u USING (user_id)
      WHERE a.logged_at >= (${SIX}) AND ($1::text IS NULL OR a.branch_code=$1)
      ORDER BY a.logged_at DESC LIMIT 500`, [req.query.branch || null]);
  res.json(rows);
});

// POST /api/admin/run-daily  -> trigger the daily job by hand (for the defense demo)
router.post('/run-daily', async (req, res) => {
  const created = await generateStatementsForToday();
  const status = await runStatusEngine();
  res.json({ statementsCreated: created, status });
});

// GET /api/admin/users?q=bagong  -> find any client / staff / admin account (no passwords are ever returned)
router.get('/users', async (req, res) => {
  const { rows } = await query(
    `SELECT u.user_id, u.login_id, u.role, u.is_active, c.email, COALESCE(a.full_name, s.full_name, c.name) AS name
       FROM users u LEFT JOIN admins a ON a.user_id=u.user_id LEFT JOIN staff s ON s.user_id=u.user_id LEFT JOIN clients c ON c.user_id=u.user_id
      WHERE $1::text IS NULL OR u.login_id ILIKE '%'||$1||'%' OR c.name ILIKE '%'||$1||'%' OR c.email ILIKE '%'||$1||'%'
      ORDER BY u.role, u.login_id LIMIT 100`, [req.query.q || null]);
  res.json(rows);
});

// POST /api/admin/users/:userId/reset-password  { newPassword }
router.post('/users/:userId/reset-password', async (req, res) => {
  const pw = (req.body || {}).newPassword;
  if (typeof pw !== 'string' || pw.length < 8 || pw.length > 72 || /\s/.test(pw)) {
    return res.status(400).json({ error: 'Password must be 8 to 72 characters and must not contain whitespace.' });
  }
  const target = (await query('SELECT login_id FROM users WHERE user_id=$1', [req.params.userId])).rows[0];
  if (!target) return res.status(404).json({ error: 'Account not found' });
  await tx(async c => {
    await c.query('UPDATE users SET password_hash=$2 WHERE user_id=$1',
      [req.params.userId, await require('bcrypt').hash(pw, 10)]);
    await logActivity(c, req.user.userId, null, `Reset password of ${target.login_id}`);
  });
  res.json({ ok: true });
});

module.exports = router;