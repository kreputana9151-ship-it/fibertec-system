const router = require('express').Router();
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { requireAuth, requireRole } = require('../middleware/auth');
const { query, tx } = require('../db');
const { sendStatement, generateStatementsForToday, runStatusEngine } = require('../services/billing');
const { changeStatus, logActivity } = require('../services/audit');
const { sendEmail } = require('../services/mailer');
const { ACCOUNT_SUMMARY_CTES } = require('../services/accountSummary');
const { publicErrorMessage, publicErrorStatus } = require('../utils/publicError');
const { installedDateError } = require('../utils/businessDate');
const { pagination } = require('../utils/pagination');
const { duplicateClientError, duplicateClientMessage } = require('../utils/clientDuplicate');

router.use(requireAuth, requireRole('admin'));
// Admin sees all branches; billing history is retained, while activity feeds use a six-month window.
const wrap = fn => async (req, res, next) => {
  try {
    await fn(req, res, next);
  } catch (err) {
    next(err);
  }
};

const SIX = "date_trunc('month', current_date) - interval '6 months'";

function selectedMonth(value) {
  if (!value) return null;
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(value) ? value : false;
}

async function setTemporaryClientPassword(c, accountNo) {
  const target = (await c.query(
    `SELECT u.user_id
       FROM users u JOIN clients cl ON cl.user_id=u.user_id
      WHERE cl.account_no=$1 AND u.role='client'
      FOR UPDATE OF u`,
    [accountNo]
  )).rows[0];
  if (!target) throw Object.assign(new Error('Client account not found.'), { status: 404 });

  const temporaryPassword = `Ft-${crypto.randomBytes(9).toString('hex')}`;
  await c.query(
    `UPDATE users
        SET password_hash=$2, must_change_password=TRUE,
            failed_login_attempts=0, login_locked_until=NULL
      WHERE user_id=$1`,
    [target.user_id, await bcrypt.hash(temporaryPassword, 10)]
  );
  await c.query(
    'UPDATE password_resets SET used_at=COALESCE(used_at, now()) WHERE user_id=$1 AND used_at IS NULL',
    [target.user_id]
  );
  return temporaryPassword;
}

const periodAnalyticsSql = `
  WITH ${ACCOUNT_SUMMARY_CTES},
  selected_period AS (
    SELECT COALESCE(
             TO_DATE($1, 'YYYY-MM'),
             date_trunc('month', (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Manila')::date)::date
           ) AS month_start,
           (COALESCE(
             TO_DATE($1, 'YYYY-MM'),
             date_trunc('month', (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Manila')::date)::date
           ) + INTERVAL '1 month - 1 day')::date AS month_end,
           date_trunc('month', (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Manila')::date)::date AS current_month
  ),
  branch_scope AS (
    SELECT branch_code, name FROM branches
     WHERE ($2::text IS NULL OR branch_code=$2)
  ),
  period_population AS (
    SELECT c.account_no, c.branch_code, c.plan_id,
           CASE
             WHEN period.month_start = period.current_month THEN summary.effective_status
             WHEN history.new_status IS NOT NULL THEN history.new_status
             WHEN c.termination_date <= period.month_end THEN 'Terminated'
             ELSE 'Active'
           END AS effective_status
      FROM clients c
      JOIN branch_scope b ON b.branch_code=c.branch_code
      JOIN account_summary summary ON summary.account_no=c.account_no
      CROSS JOIN selected_period period
      LEFT JOIN LATERAL (
        SELECT log.new_status
          FROM account_status_log log
         WHERE log.account_no = c.account_no
           AND (log.changed_at AT TIME ZONE 'Asia/Manila')::date <= period.month_end
         ORDER BY log.changed_at DESC, log.log_id DESC
         LIMIT 1
      ) history ON TRUE
     WHERE c.installed_date <= period.month_end
  ),
  client_totals AS (
    SELECT population.branch_code, COUNT(*)::int AS client_count,
           COUNT(*) FILTER (WHERE population.effective_status='Active')::int AS active_count
      FROM period_population population
     GROUP BY population.branch_code
  ),
  period_client_totals AS (
    SELECT population.branch_code, COUNT(*)::int AS client_count
      FROM period_population population
     GROUP BY population.branch_code
  ),
  plan_totals AS (
    SELECT p.plan_name, COUNT(*)::int AS client_count
      FROM period_population population
      JOIN plans p USING (plan_id)
     GROUP BY p.plan_name
  ),
  statement_totals AS (
    SELECT c.branch_code, COALESCE(SUM(s.amount),0) AS billed,
           COALESCE(SUM(paid.verified_paid) FILTER (WHERE s.statement_id IS NOT NULL),0) AS collected,
           COUNT(s.statement_id)::int AS statement_count,
           COUNT(*) FILTER (WHERE s.send_status='Delivered')::int AS delivered_count
      FROM branch_scope b
      LEFT JOIN clients c USING (branch_code)
      LEFT JOIN statements s ON s.account_no=c.account_no
        AND ($1::text IS NULL OR TO_CHAR(s.billing_month, 'YYYY-MM')=$1)
      LEFT JOIN summary_payment_totals paid ON paid.statement_id=s.statement_id
     GROUP BY c.branch_code
  ),
  payment_totals AS (
    SELECT b.branch_code,
           COALESCE(SUM(p.amount) FILTER (WHERE p.status='Verified'),0) AS revenue
      FROM branch_scope b
      LEFT JOIN clients c USING (branch_code)
      LEFT JOIN payments p ON p.account_no=c.account_no
        AND ($1::text IS NULL OR TO_CHAR(COALESCE(p.payment_date, p.created_at::date), 'YYYY-MM')=$1)
     GROUP BY b.branch_code
  ),
  registration_totals AS (
    SELECT c.branch_code, COUNT(*)::int AS registrations
      FROM clients c JOIN branch_scope b USING (branch_code)
     WHERE ($1::text IS NULL OR TO_CHAR(c.installed_date, 'YYYY-MM')=$1)
     GROUP BY c.branch_code
  ),
  cancellation_totals AS (
    SELECT c.branch_code, COUNT(*)::int AS cancellations
      FROM clients c
      JOIN branch_scope b USING (branch_code)
     WHERE c.status='Terminated'
       AND ($1::text IS NULL OR TO_CHAR(c.termination_date, 'YYYY-MM')=$1)
     GROUP BY c.branch_code
  ),
  branch_data AS (
    SELECT b.branch_code, b.name AS branch,
           COALESCE(ct.client_count,0) AS clients,
           COALESCE(ct.active_count,0) AS active,
           COALESCE(pct.client_count,0) AS period_clients,
           COALESCE(st.billed,0) AS billed,
           COALESCE(st.collected,0) AS collected,
           COALESCE(pt.revenue,0) AS revenue,
           CASE WHEN COALESCE(st.billed,0)=0 THEN 0
                ELSE ROUND(COALESCE(st.collected,0)/st.billed*100,1) END AS collection_efficiency,
           COALESCE(st.statement_count,0) AS statements,
           COALESCE(st.delivered_count,0) AS delivered,
           COALESCE(rt.registrations,0) AS registrations,
           COALESCE(xt.cancellations,0) AS cancellations
      FROM branch_scope b
      LEFT JOIN client_totals ct USING (branch_code)
      LEFT JOIN period_client_totals pct USING (branch_code)
      LEFT JOIN statement_totals st USING (branch_code)
      LEFT JOIN payment_totals pt USING (branch_code)
      LEFT JOIN registration_totals rt USING (branch_code)
      LEFT JOIN cancellation_totals xt USING (branch_code)
  ),
  status_data AS (
    SELECT population.effective_status AS status, COUNT(*)::int AS count
      FROM period_population population
     GROUP BY population.effective_status
  )
  SELECT
    COALESCE((SELECT json_agg(json_build_object(
      'branch_code', branch_code, 'branch', branch, 'clients', clients, 'active', active,
      'period_clients', period_clients,
      'billed', billed, 'collected', collected, 'revenue', revenue,
      'collection_efficiency', collection_efficiency,
      'statements', statements, 'delivered', delivered, 'registrations', registrations,
      'cancellations', cancellations
    ) ORDER BY branch_code) FROM branch_data), '[]'::json) AS branches,
    COALESCE((SELECT json_agg(json_build_object('status', status, 'count', count) ORDER BY status)
                FROM status_data), '[]'::json) AS statuses,
    COALESCE((SELECT json_agg(json_build_object('plan', plan_name, 'count', client_count) ORDER BY plan_name)
                FROM plan_totals), '[]'::json) AS plan_distribution,
    COALESCE((SELECT json_agg(payment) FROM (
      SELECT json_build_object(
        'payment_id', p.payment_id, 'account_no', p.account_no, 'name', c.name,
        'branch', b.name, 'amount', p.amount, 'status', p.status,
        'payment_date', COALESCE(p.payment_date, p.created_at::date)::text
      ) AS payment
        FROM payments p
        JOIN clients c ON c.account_no=p.account_no
        JOIN branch_scope b ON b.branch_code=c.branch_code
       WHERE ($1::text IS NULL OR TO_CHAR(COALESCE(p.payment_date, p.created_at::date), 'YYYY-MM')=$1)
       ORDER BY COALESCE(p.payment_date, p.created_at::date) DESC, p.payment_id DESC
       LIMIT 12
    ) recent), '[]'::json) AS recent_payments`;

async function loadPeriodAnalytics(month, branchCode) {
  const { rows } = await query(periodAnalyticsSql, [month, branchCode || null]);
  return rows[0];
}

// GET /api/admin/months -> continuous month range from the earliest billing/install date to Manila today
router.get('/months', wrap(async (req, res) => {
  try {
    const { rows } = await query(
      `WITH bounds AS (
         SELECT date_trunc('month', LEAST(
                  COALESCE((SELECT MIN(billing_month) FROM statements), (SELECT MIN(installed_date) FROM clients)),
                  COALESCE((SELECT MIN(installed_date) FROM clients), (SELECT MIN(billing_month) FROM statements))
                ))::date AS first_month,
                date_trunc('month', (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Manila')::date)::date AS last_month
       )
       SELECT TO_CHAR(generated.month_start, 'YYYY-MM') AS month
         FROM bounds
         CROSS JOIN LATERAL generate_series(
           COALESCE(first_month, last_month), last_month, INTERVAL '1 month'
         ) AS generated(month_start)
        ORDER BY generated.month_start DESC`
    );
    res.json(rows.map(r => r.month));
  } catch (e) {
    console.error('GET /api/admin/months failed:', e && (e.code || e.name) || 'Error');
    res.status(500).json({ error: 'Could not load billing months.' });
  }
}));

// GET /api/admin/dashboard?month=2026-10&branch=04
router.get('/dashboard', wrap(async (req, res) => {
  const month = selectedMonth(req.query.month);
  if (month === false) return res.status(400).json({ error: 'Month must use YYYY-MM format.' });
  try {
    res.json(await loadPeriodAnalytics(month, req.query.branch));
  } catch (e) {
    console.error('GET /api/admin/dashboard failed:', e && (e.code || e.name) || 'Error');
    res.status(500).json({ error: 'Could not load dashboard analytics.' });
  }
}));

// GET /api/admin/password-reset-requests
router.get('/password-reset-requests', wrap(async (req, res) => {
  try {
    const page = pagination(req);
    const { rows } = await query(
      `SELECT id, account_no, client_name, status,
              TO_CHAR(requested_at AT TIME ZONE 'Asia/Manila', 'YYYY-MM-DD HH24:MI:SS') AS requested_at_manila
         FROM password_reset_requests
        WHERE status='Pending'
        ORDER BY requested_at, id
        LIMIT $1 OFFSET $2`,
      [page.limit, page.offset]
    );
    res.json(rows);
  } catch (e) {
    console.error('GET /api/admin/password-reset-requests failed:', e && (e.code || e.name) || 'Error');
    res.status(500).json({ error: 'Could not load password reset requests.' });
  }
}));

// POST /api/admin/password-reset-requests/:id/reset
router.post('/password-reset-requests/:id/reset', wrap(async (req, res) => {
  if (!/^[0-9]+$/.test(req.params.id)) return res.status(400).json({ error: 'Invalid password reset request.' });
  try {
    const result = await tx(async c => {
      const request = (await c.query(
        `SELECT id, account_no, client_name
           FROM password_reset_requests
          WHERE id=$1::integer AND status='Pending'
          FOR UPDATE`,
        [req.params.id]
      )).rows[0];
      if (!request) throw Object.assign(new Error('Pending password reset request not found.'), { status: 404 });

      const temporaryPassword = await setTemporaryClientPassword(c, request.account_no);
      await c.query(
        `UPDATE password_reset_requests
            SET status='Resolved', resolved_at=now(), resolved_by=$2
          WHERE id=$1`,
        [request.id, req.user.userId]
      );
      await logActivity(c, req.user.userId, null, `Resolved password reset request #${request.id} for ${request.account_no}`);
      return { accountNo: request.account_no, clientName: request.client_name, temporaryPassword };
    });
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('POST /api/admin/password-reset-requests/:id/reset failed:', e && (e.code || e.name) || 'Error');
    res.status(publicErrorStatus(e, 500)).json({ error: publicErrorMessage(e, 'Could not reset the client password.') });
  }
}));

// GET /api/admin/cancellations?branch=04
router.get('/cancellations', wrap(async (req, res) => {
  try {
    const page = pagination(req);
    const { rows } = await query(
      `SELECT r.request_id, r.account_no, r.request_date, r.reason, r.status,
              c.name, b.name AS branch
         FROM cancellation_requests r
         JOIN clients c ON c.account_no=r.account_no
         JOIN branches b ON b.branch_code=c.branch_code
        WHERE r.status='Pending'
          AND ($1::text IS NULL OR c.branch_code::text=$1::text)
           AND NOT EXISTS (
             SELECT 1 FROM account_status_log h
              WHERE h.account_no=c.account_no
                AND h.new_status='Active'
                AND h.changed_at > r.created_at
           )
        ORDER BY r.created_at DESC, r.request_id DESC
        LIMIT $2 OFFSET $3`,
      [req.query.branch || null, page.limit, page.offset]
    );
    res.json(rows);
  } catch (e) {
    console.error('GET /api/admin/cancellations failed:', e && (e.code || e.name) || 'Error');
    res.status(500).json({ error: 'Could not load pending cancellation requests.' });
  }
}));

// GET /api/admin/clients?branch=04&status=Active
router.get('/clients', wrap(async (req, res) => {
  try {
    const page = pagination(req);
    const { rows } = await query(
      `WITH ${ACCOUNT_SUMMARY_CTES}
       SELECT c.account_no,
                c.name,
                c.contact_no,
                c.address,
                b.name AS branch,
                c.plan_id,
                p.plan_name,
                p.monthly_rate,
                summary.total_balance AS current_balance,
                summary.total_balance AS outstanding_balance,
                summary.previous_balance,
                summary.current_month_due,
                summary.total_balance,
                CASE WHEN summary.total_balance > 0 THEN 'Unpaid'
                     ELSE COALESCE(summary.latest_payment_status, 'Unpaid') END AS payment_status,
                summary.has_pending_payment,
                TO_CHAR(summary.current_due_date, 'YYYY-MM-DD') AS current_due_date,
                summary.effective_status AS status,
                CASE WHEN summary.previous_balance > 0 THEN 'Previous billing month arrears'
                     WHEN summary.effective_status='Under Review'
                     THEN COALESCE(NULLIF(BTRIM(c.status_reason), ''),
                       CASE WHEN summary.total_balance > 0
                            THEN 'Grace period ended' ELSE 'Flagged for account review' END)
                     ELSE c.status_reason END AS status_reason,
              c.due_day,
              c.email,
              c.facebook,
              c.router_location,
              TO_CHAR(c.registered_date, 'YYYY-MM-DD') AS registered_date,
              TO_CHAR(c.installed_date, 'YYYY-MM-DD') AS installed_date,
              TO_CHAR(c.termination_date, 'YYYY-MM-DD') AS termination_date,
              TO_CHAR(c.registered_date, 'YYYY-MM') AS created_month,
              TO_CHAR(c.termination_date, 'YYYY-MM') AS terminated_month,
              TO_CHAR(c.registered_date, 'YYYY-MM-DD') AS created_at,
              TO_CHAR(c.termination_date, 'YYYY-MM-DD') AS updated_at,
              CASE WHEN summary.effective_status='Under Review'
                   THEN TO_CHAR(COALESCE(c.flagged_date, summary.overdue_due_date,
                     (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Manila')::date), 'YYYY-MM-DD')
                   ELSE TO_CHAR(c.flagged_date, 'YYYY-MM-DD') END AS flagged_date,
              TO_CHAR(summary.overdue_due_date, 'YYYY-MM-DD') AS overdue_due_date,
              TO_CHAR(c.grace_end_date, 'YYYY-MM-DD') AS grace_end_date
         FROM clients c
         JOIN branches b ON b.branch_code=c.branch_code
         JOIN plans p ON p.plan_id=c.plan_id
         JOIN account_summary summary ON summary.account_no=c.account_no
        WHERE ($1::text IS NULL OR c.branch_code=$1)
          AND ($2::text IS NULL OR summary.effective_status=$2)
        ORDER BY c.branch_code, c.client_seq
        LIMIT $3 OFFSET $4`,
      [req.query.branch || null, req.query.status || null, page.limit, page.offset]
    );
    res.json(rows);
  } catch (e) {
    console.error('GET /api/admin/clients failed:', e && (e.code || e.name) || 'Error');
    res.status(500).json({ error: publicErrorMessage(e, 'Could not load client records.') });
  }
}));

// GET /api/admin/statements?month=2026-10&branch=04
router.get('/statements', wrap(async (req, res) => {
  const month = selectedMonth(req.query.month);
  if (month === false) return res.status(400).json({ error: 'Month must use YYYY-MM format.' });
  const page = pagination(req);
  const { rows } = await query(
    `WITH ${ACCOUNT_SUMMARY_CTES}
     SELECT s.statement_id, s.invoice_no, s.account_no, s.billing_month, s.issued_date, s.due_date, s.amount,
            COALESCE(statement_paid.verified_paid, 0) AS amount_paid,
            GREATEST(s.amount - COALESCE(statement_paid.verified_paid, 0), 0) AS balance,
            summary.previous_balance, summary.current_month_due, summary.total_balance,
            summary.effective_status AS client_status,
            CASE WHEN COALESCE(statement_paid.verified_paid, 0) >= s.amount THEN 'Paid'
                 WHEN COALESCE(statement_paid.verified_paid, 0) > 0 THEN 'Partially paid'
                 ELSE 'Unpaid' END AS payment_status,
            s.send_status, s.sent_by_admin, s.sent_at, s.created_at, c.name, c.branch_code
       FROM statements s JOIN clients c ON c.account_no=s.account_no
       JOIN account_summary summary ON summary.account_no=c.account_no
       LEFT JOIN summary_payment_totals statement_paid ON statement_paid.statement_id=s.statement_id
      WHERE ($1::text IS NULL OR TO_CHAR(s.billing_month, 'YYYY-MM')=$1)
        AND ($2::text IS NULL OR c.branch_code=$2)
      ORDER BY s.billing_month DESC, s.account_no
      LIMIT $3 OFFSET $4`, [month, req.query.branch || null, page.limit, page.offset]);
  res.json(rows);
}));

// GET /api/admin/payments?month=2026-11&branch=04&status=Verified
router.get('/payments', wrap(async (req, res) => {
  const month = selectedMonth(req.query.month);
  if (month === false) return res.status(400).json({ error: 'Month must use YYYY-MM format.' });
  const page = pagination(req);
  const { rows } = await query(
    `WITH ${ACCOUNT_SUMMARY_CTES}
     SELECT p.*, c.name, c.branch_code, b.name AS branch,
            summary.effective_status AS client_status,
            summary.previous_balance, summary.current_month_due, summary.total_balance
       FROM payments p
       JOIN clients c ON c.account_no=p.account_no
       JOIN branches b ON b.branch_code = c.branch_code
       JOIN account_summary summary ON summary.account_no=c.account_no
      WHERE ($1::text IS NULL OR TO_CHAR(COALESCE(p.payment_date, p.created_at::date), 'YYYY-MM') = $1)
        AND ($2::text IS NULL OR c.branch_code = $2)
        AND ($3::text IS NULL OR p.status = $3)
      ORDER BY COALESCE(p.payment_date, p.created_at::date) DESC, p.payment_id DESC
      LIMIT $4 OFFSET $5`,
    [month, req.query.branch || null, req.query.status || null, page.limit, page.offset]
  );
  res.json(rows);
}));

// POST /api/admin/statements/generate  -> run generation now (for demo / testing)
router.post('/statements/generate', wrap(async (req, res) => {
  const created = await generateStatementsForToday();
  res.json({ created });
}));

// POST /api/admin/statements/:id/send   (send or re-send one statement)
router.post('/statements/:id/send', wrap(async (req, res) => {
  try {
    const ok = await sendStatement(req.params.id, req.user.userId);
    await tx(c => logActivity(c, req.user.userId, null, `Sent statement #${req.params.id} (${ok ? 'Delivered' : 'Failed'})`));
    res.json({ delivered: ok });
  } catch (e) {
    res.status(publicErrorStatus(e, 404)).json({ error: publicErrorMessage(e, 'Could not send statement.') });
  }
}));

// GET /api/admin/notices?status=Failed
router.get('/notices', wrap(async (req, res) => {
  const page = pagination(req);
  const { rows } = await query(
    `SELECT n.*, c.name FROM notices n JOIN clients c ON c.account_no=n.account_no
      WHERE n.notice_date >= (${SIX}) AND ($1::text IS NULL OR n.delivery_status=$1)
      ORDER BY n.created_at DESC, n.notice_id DESC LIMIT $2 OFFSET $3`,
    [req.query.status || null, page.limit, page.offset]);
  res.json(rows);
}));

// POST /api/admin/notices/:id/resend
router.post('/notices/:id/resend', wrap(async (req, res) => {
  const n = (await query('SELECT * FROM notices WHERE notice_id=$1', [req.params.id])).rows[0];
  if (!n) return res.status(404).json({ error: 'Notice not found' });
  const ok = n.channel === 'Email' ? await sendEmail(n.recipient, n.notice_type, n.message || 'Resent notice') : true;
  await tx(async c => {
    await c.query('UPDATE notices SET delivery_status=$2, resent_by_admin=$3 WHERE notice_id=$1',
      [n.notice_id, ok ? 'Sent' : 'Failed', req.user.userId]);
    await logActivity(c, req.user.userId, null, `Resent notice #${n.notice_id}`);
  });
  res.json({ delivered: ok });
}));

// PATCH /api/admin/clients/:accountNo
router.patch('/clients/:accountNo', wrap(async (req, res) => {
  if (/\s/.test(req.params.accountNo)) return res.status(400).json({ error: 'Account number must not contain whitespace.' });
  const b = req.body || {};
  const name = String(b.name || '').trim();
  const contactNo = String(b.contactNo || '').trim();
  const email = typeof b.email === 'string' ? b.email.trim().toLowerCase() : '';
  const address = String(b.address || '').trim();
  const planId = Number(b.planId);
  const facebook = String(b.facebook || '').trim() || null;
  const routerLocation = String(b.routerLocation || '').trim() || null;
  const installedDate = b.installedDate === undefined && b.installed_date === undefined
    ? null
    : (b.installedDate || b.installed_date);

  if (!name || !contactNo || !email || !address || !Number.isInteger(planId)) {
    return res.status(400).json({ error: 'Please complete the client name, contact number, email, address, and plan.' });
  }
  if (installedDate !== null) {
    const installedDateIssue = installedDateError(installedDate);
    if (installedDateIssue) return res.status(400).json({ error: installedDateIssue });
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
      const duplicates = (await c.query(
        `SELECT
           EXISTS (
             SELECT 1 FROM clients
              WHERE BTRIM(contact_no)=$1 AND account_no<>$3
           ) AS contact_exists,
           EXISTS (
             SELECT 1 FROM clients
              WHERE LOWER(BTRIM(email))=$2 AND account_no<>$3
           ) AS email_exists`,
        [contactNo, email, req.params.accountNo]
      )).rows[0];
      if (duplicates.contact_exists) throw duplicateClientError('contact_no');
      if (duplicates.email_exists) throw duplicateClientError('email');
      const plan = await c.query('SELECT 1 FROM plans WHERE plan_id=$1', [planId]);
      if (!plan.rows.length) throw new Error('Selected internet plan was not found.');
      if (installedDate !== null) {
        const current = await c.query(
          'SELECT installed_date::text AS installed_date FROM clients WHERE account_no=$1 FOR UPDATE',
          [req.params.accountNo]
        );
        if (!current.rows.length) throw Object.assign(new Error('Client not found.'), { status: 404 });
        if (current.rows[0].installed_date !== installedDate) {
          const history = await c.query(
            'SELECT 1 FROM statements WHERE account_no=$1 LIMIT 1',
            [req.params.accountNo]
          );
          if (history.rowCount) {
            throw Object.assign(
              new Error('Installed date cannot be changed after billing statements have been generated.'),
              { status: 409 }
            );
          }
        }
      }

      const updated = await c.query(
        `UPDATE clients
            SET name=$2, contact_no=$3, email=$4, address=$5, plan_id=$6,
                router_location=$7, facebook=$8,
                installed_date=COALESCE($9::date, installed_date),
                due_day=COALESCE($10::smallint, due_day)
          WHERE account_no=$1`,
        [req.params.accountNo, name, contactNo, email, address, planId, routerLocation, facebook,
          installedDate, installedDate === null ? null : Number(installedDate.slice(8, 10))]
      );
      if (!updated.rowCount) throw new Error('Client not found.');
    });
    res.json({ ok: true });
  } catch (e) {
    const duplicateMessage = duplicateClientMessage(e);
    if (duplicateMessage) return res.status(409).json({ error: duplicateMessage });
    res.status(publicErrorStatus(e, 400)).json({ error: publicErrorMessage(e, 'Could not update client details.') });
  }
}));

// POST /api/admin/clients/:accountNo/reset-password
router.post('/clients/:accountNo/reset-password', wrap(async (req, res) => {
  const accountNo = String(req.params.accountNo || '').trim();
  if (!/^[0-9]{8}$/.test(accountNo)) return res.status(400).json({ error: 'Account number must be 8 digits.' });
  try {
    const temporaryPassword = await tx(async c => {
      const password = await setTemporaryClientPassword(c, accountNo);
      await logActivity(c, req.user.userId, null, `Reset client password for ${accountNo}`);
      return password;
    });
    res.json({ ok: true, temporaryPassword });
  } catch (e) {
    console.error('POST /api/admin/clients/:accountNo/reset-password failed:', e && (e.code || e.name) || 'Error');
    res.status(publicErrorStatus(e, 500)).json({ error: publicErrorMessage(e, 'Could not reset client password.') });
  }
}));

// PATCH /api/admin/clients/:accountNo/status  { status: 'Active'|'Terminated', reason }
router.patch('/clients/:accountNo/status', wrap(async (req, res) => {
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
  } catch (e) {
    res.status(publicErrorStatus(e, 400)).json({ error: publicErrorMessage(e, 'Could not update client status.') });
  }
}));

// GET /api/admin/clients/:accountNo/status-log
router.get('/clients/:accountNo/status-log', wrap(async (req, res) => {
  if (/\s/.test(req.params.accountNo)) return res.status(400).json({ error: 'Account number must not contain whitespace.' });
  const { rows } = await query('SELECT * FROM account_status_log WHERE account_no=$1 ORDER BY changed_at DESC', [req.params.accountNo]);
  res.json(rows);
}));

// GET /api/admin/analytics?month=2026-10&branch=04
router.get('/analytics', wrap(async (req, res) => {
  const month = selectedMonth(req.query.month);
  if (month === false) return res.status(400).json({ error: 'Month must use YYYY-MM format.' });
  try {
    res.json(await loadPeriodAnalytics(month, req.query.branch));
  } catch (e) {
    console.error('GET /api/admin/analytics failed:', e && (e.code || e.name) || 'Error');
    res.status(500).json({ error: 'Could not load branch analytics.' });
  }
}));

// GET /api/admin/activity?branch=04  (6 months)
router.get('/activity', wrap(async (req, res) => {
  const page = pagination(req, 500);
  const { rows } = await query(
    `SELECT a.*, u.login_id FROM activity_log a JOIN users u USING (user_id)
      WHERE a.logged_at >= (${SIX}) AND ($1::text IS NULL OR a.branch_code=$1)
      ORDER BY a.logged_at DESC, a.log_id DESC LIMIT $2 OFFSET $3`,
    [req.query.branch || null, page.limit, page.offset]);
  res.json(rows);
}));

// POST /api/admin/run-daily  -> trigger the daily job by hand (for the defense demo)
router.post('/run-daily', wrap(async (req, res) => {
  const created = await generateStatementsForToday();
  const status = await runStatusEngine();
  res.json({ statementsCreated: created, status });
}));

// GET /api/admin/users?q=bagong  -> find any client / staff / admin account (no passwords are ever returned)
router.get('/users', wrap(async (req, res) => {
  const { rows } = await query(
    `SELECT u.user_id, u.login_id, u.role, u.is_active, c.email, COALESCE(a.full_name, s.full_name, c.name) AS name
       FROM users u LEFT JOIN admins a ON a.user_id=u.user_id LEFT JOIN staff s ON s.user_id=u.user_id LEFT JOIN clients c ON c.user_id=u.user_id
      WHERE $1::text IS NULL OR u.login_id ILIKE '%'||$1||'%' OR c.name ILIKE '%'||$1||'%' OR c.email ILIKE '%'||$1||'%'
      ORDER BY u.role, u.login_id LIMIT 100`, [req.query.q || null]);
  res.json(rows);
}));

// POST /api/admin/users/:userId/reset-password  { newPassword }
router.post('/users/:userId/reset-password', wrap(async (req, res) => {
  const pw = (req.body || {}).newPassword;
  if (typeof pw !== 'string' || pw.length < 8 || pw.length > 72 || /\s/.test(pw)) {
    return res.status(400).json({ error: 'Password must be 8 to 72 characters and must not contain whitespace.' });
  }
  const target = (await query('SELECT login_id FROM users WHERE user_id=$1', [req.params.userId])).rows[0];
  if (!target) return res.status(404).json({ error: 'Account not found' });
  await tx(async c => {
    await c.query(
      'UPDATE users SET password_hash=$2, must_change_password=TRUE, failed_login_attempts=0, login_locked_until=NULL WHERE user_id=$1',
      [req.params.userId, await bcrypt.hash(pw, 10)]);
    await c.query(
      'UPDATE password_resets SET used_at=COALESCE(used_at, now()) WHERE user_id=$1 AND used_at IS NULL',
      [req.params.userId]
    );
    await logActivity(c, req.user.userId, null, `Reset password of ${target.login_id}`);
  });
  res.json({ ok: true });
}));

module.exports = router;