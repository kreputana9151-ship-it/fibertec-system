const router = require('express').Router();
const bcrypt = require('bcrypt');
const { requireAuth, requireRole } = require('../middleware/auth');
const { query, tx } = require('../db');
const { applyVerifiedPayment, createInitialStatement } = require('../services/billing');
const { changeStatus, logActivity, addNotice } = require('../services/audit');
const { deliverPendingEmails } = require('../services/notify');

router.use(requireAuth, requireRole('staff'));
// every query below uses req.user.branchCode, so staff can never see another branch

// GET /api/staff/clients?q=
router.get('/clients', async (req, res) => {
  try {
    const q = `%${req.query.q || ''}%`;
    const { rows } = await query(
      `SELECT c.account_no, c.name, c.contact_no, c.email, c.address, c.status,
              COALESCE(latest.balance, 0) AS current_balance,
              COALESCE(latest.balance, 0) AS outstanding_balance,
              CASE WHEN c.status='Terminated' AND latest.balance IS NOT NULL
                   THEN CASE WHEN latest.balance > 0 THEN 'Unpaid' ELSE 'Paid' END
                   ELSE latest.payment_status END AS payment_status,
              COALESCE(latest.has_pending_payment, FALSE) AS has_pending_payment,
              TO_CHAR(latest.due_date, 'YYYY-MM-DD') AS current_due_date,
              CASE WHEN c.status='Under Review'
                   THEN COALESCE(NULLIF(BTRIM(c.status_reason), ''),
                     CASE WHEN COALESCE(latest.balance, c.current_balance, 0) > 0
                          THEN 'Grace period ended' ELSE 'Flagged for account review' END)
                   ELSE c.status_reason END AS status_reason,
              c.facebook, c.router_location,
              p.plan_id, p.plan_name, p.monthly_rate, c.due_day,
              TO_CHAR(c.registered_date, 'YYYY-MM-DD') AS registered_date,
              TO_CHAR(c.termination_date, 'YYYY-MM-DD') AS termination_date,
              TO_CHAR(c.registered_date, 'YYYY-MM') AS created_month,
              TO_CHAR(c.termination_date, 'YYYY-MM') AS terminated_month,
              c.termination_reason,
              CASE WHEN c.status='Under Review'
                   THEN TO_CHAR(COALESCE(c.flagged_date, overdue.due_date,
                     (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Manila')::date), 'YYYY-MM-DD')
                   ELSE TO_CHAR(c.flagged_date, 'YYYY-MM-DD') END AS flagged_date,
              TO_CHAR(overdue.due_date, 'YYYY-MM-DD') AS overdue_due_date,
              TO_CHAR(c.grace_end_date, 'YYYY-MM-DD') AS grace_end_date
         FROM clients c JOIN plans p USING (plan_id)
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
         LEFT JOIN LATERAL (
           SELECT s.due_date
             FROM statements s
             LEFT JOIN LATERAL (
               SELECT COALESCE(SUM(pm.amount) FILTER (WHERE pm.status='Verified'), 0) AS verified_paid
                 FROM payments pm WHERE pm.statement_id=s.statement_id
             ) paid ON TRUE
            WHERE s.account_no=c.account_no
              AND s.due_date <= (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Manila')::date
              AND GREATEST(s.amount - COALESCE(paid.verified_paid, 0), 0) > 0
            ORDER BY s.due_date DESC, s.billing_month DESC LIMIT 1
         ) overdue ON TRUE
        WHERE c.branch_code=$1 AND (c.name ILIKE $2 OR c.account_no LIKE $2 OR c.email ILIKE $2)
        ORDER BY c.client_seq`,
      [req.user.branchCode, q]
    );
    res.json(rows);
  } catch (e) {
    console.error('GET /api/staff/clients error:', e);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/staff/clients.csv  (Export CSV)
router.get('/clients.csv', async (req, res) => {
  const { rows } = await query(
    `SELECT c.account_no, c.name, c.contact_no, c.email, p.plan_name, c.status
       FROM clients c JOIN plans p USING (plan_id) WHERE c.branch_code=$1 ORDER BY c.client_seq`,
    [req.user.branchCode]
  );
  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = ['account_no,name,contact_no,email,plan,status', ...rows.map(r => Object.values(r).map(esc).join(','))].join('\n');
  res.type('text/csv').attachment(`clients_${req.user.branchCode}.csv`).send(csv);
});

// POST /api/staff/clients  -> register a client in the staff's own branch with staff-assigned email & password
router.post('/clients', async (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  const contactNo = String(b.contactNo || b.contact_no || '').trim();
  const email = typeof b.email === 'string' ? b.email.toLowerCase() : '';
  const password = typeof b.password === 'string' ? b.password : '';
  const address = String(b.address || '').trim();
  const planId = b.planId || b.plan_id;
  const registeredDate = b.registeredDate || b.registered_date || new Date().toISOString().slice(0, 10);

  if (!name || !contactNo || !email || !address || !planId || !registeredDate) {
    return res.status(400).json({ error: 'Please complete all required client details (name, contact number, email, address, plan, and registration date).' });
  }
  if (/\s/.test(email)) {
    return res.status(400).json({ error: 'Client email must not contain whitespace.' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Please enter a valid client email address.' });
  }
  if (/\s/.test(password)) {
    return res.status(400).json({ error: 'Client portal password must not contain whitespace.' });
  }
  if (password.length < 8 || password.length > 72) {
    return res.status(400).json({ error: 'Client portal password must be between 8 and 72 characters.' });
  }

  const reg = new Date(`${registeredDate}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(registeredDate)) || isNaN(reg.getTime()) || reg.toISOString().slice(0, 10) !== registeredDate) {
    return res.status(400).json({ error: 'Invalid registration date.' });
  }

  const hash = await bcrypt.hash(password, 10);

  try {
    const out = await tx(async c => {
      const dup = await c.query('SELECT 1 FROM clients WHERE LOWER(email) = $1 LIMIT 1', [email]);
      if (dup.rows.length) {
        throw new Error('A client account with this email address already exists.');
      }

      await c.query('SELECT pg_advisory_xact_lock($1)', [Number(req.user.branchCode)]);
      const seq = (await c.query('SELECT COALESCE(MAX(client_seq),0)+1 AS n FROM clients WHERE branch_code=$1', [req.user.branchCode])).rows[0].n;
      if (seq > 9999) throw new Error('Branch is full (9999 clients)');
      const accountNo = req.user.branchCode + String(reg.getUTCFullYear() % 100).padStart(2, '0') + String(seq).padStart(4, '0');

      const u = await c.query(
        `INSERT INTO users (login_id, password_hash, role, is_active)
         VALUES ($1, $2, 'client', TRUE)
         RETURNING user_id`,
        [accountNo, hash]
      );

      await c.query(
        `INSERT INTO clients (account_no, user_id, branch_code, client_seq, plan_id, name, contact_no, email, address,
                              facebook, router_location, registered_date, due_day, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::date,$13,'Active')`,
        [
          accountNo,
          u.rows[0].user_id,
          req.user.branchCode,
          seq,
          planId,
          name,
          contactNo,
          email,
          address,
          b.facebook || null,
          b.routerLocation || b.router_location || null,
          registeredDate,
          reg.getUTCDate()
        ]
      );

      const billing = (await c.query(
        `SELECT p.monthly_rate, b.short_name
           FROM plans p CROSS JOIN branches b
          WHERE p.plan_id=$1 AND b.branch_code=$2`,
        [planId, req.user.branchCode]
      )).rows[0];
      await createInitialStatement(c, {
        accountNo,
        shortName: billing.short_name,
        monthlyRate: billing.monthly_rate,
        registeredDate
      });

      const welcomeMsg = `Welcome to FiberTec IT Solutions, ${name}! Your Account No. is ${accountNo}. Use your registered email (${email}) or Account No. (${accountNo}) and your assigned password to sign in to the FiberTec Client Portal.`;

      await addNotice(c, {
        accountNo,
        type: 'System Notice',
        channel: 'Portal Notification',
        status: 'Sent',
        message: welcomeMsg
      });

      await addNotice(c, {
        accountNo,
        type: 'System Notice',
        channel: 'Email',
        recipient: email,
        status: 'Pending',
        message: welcomeMsg
      });

      await logActivity(c, req.user.userId, req.user.branchCode, `Registered client ${accountNo} (${name}) with portal credentials`);
      return { accountNo, email, name };
    });

    res.status(201).json({
      ok: true,
      accountNo: out.accountNo,
      email: out.email,
      message: `Client ${out.name} (${out.accountNo}) registered successfully. Portal login is now active.`
    });

    deliverPendingEmails().catch(e => console.error('Welcome email delivery error:', e));
  } catch (e) {
    console.error('POST /api/staff/clients error:', e);
    res.status(400).json({ error: e.message });
  }
});

// ---- Payments Verification Queue: single-server FIFO (M/M/1) ----
const FIFO_ORDER = 'ORDER BY p.created_at ASC, p.payment_id ASC';
async function lockQueue(c, branchCode) { await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['fifo-' + branchCode]); }
async function assertHead(c, branchCode, id) {
  const h = (await c.query(`SELECT p.payment_id FROM payments p JOIN clients cl USING (account_no)
                             WHERE cl.branch_code=$1 AND p.status='Pending' ${FIFO_ORDER} LIMIT 1`, [branchCode])).rows[0];
  if (!h || Number(h.payment_id) !== Number(id)) {
    throw Object.assign(new Error('FIFO Queue Rule: Please process Queue #1 (the oldest pending payment) first.'), { status: 409 });
  }
}

// GET /api/staff/payments/queue
router.get('/payments/queue', async (req, res) => {
  const bc = req.user.branchCode;
  const q = (await query(
    `SELECT ROW_NUMBER() OVER (${FIFO_ORDER}) AS queue_no, p.payment_id, p.account_no, c.name, p.amount, p.payment_type, p.method,
            s.amount AS statement_total, COALESCE(v.verified_paid, 0) AS verified_paid,
            p.reference_no, p.created_at AS submitted_at, EXTRACT(EPOCH FROM (now() - p.created_at))::int AS waiting_seconds
       FROM payments p JOIN clients c USING (account_no)
       JOIN statements s ON s.statement_id=p.statement_id
       LEFT JOIN LATERAL (
         SELECT COALESCE(SUM(vp.amount), 0) AS verified_paid
           FROM payments vp
          WHERE vp.statement_id=p.statement_id AND vp.status='Verified'
       ) v ON TRUE
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
  res.json({
    queue: q,
    metrics: {
      Lq: q.length,
      lambda_per_hour: lambda,
      mu_per_hour: mu,
      rho: mu ? lambda / mu : null,
      avg_wait_seconds: q.length ? q.reduce((a, r) => a + r.waiting_seconds, 0) / q.length : 0,
      longest_wait_seconds: q.length ? q[0].waiting_seconds : 0
    }
  });
});

// GET /api/staff/statements/open?q=
router.get('/statements/open', async (req, res) => {
  const { rows } = await query(
    `SELECT s.statement_id, s.account_no, c.name, c.status AS client_status, s.amount, s.payment_status AS stored_payment_status,
            COALESCE(v.verified_paid, 0) AS amount_paid,
            GREATEST(s.amount - COALESCE(v.verified_paid, 0), 0) AS balance,
            CASE WHEN COALESCE(v.verified_paid, 0) >= s.amount THEN 'Paid'
                 WHEN COALESCE(v.verified_paid, 0) > 0 THEN 'Partially paid'
                 ELSE 'Unpaid' END AS payment_status,
            s.due_date, pl.monthly_rate
       FROM statements s JOIN clients c USING (account_no) JOIN plans pl USING (plan_id)
       LEFT JOIN LATERAL (
         SELECT COALESCE(SUM(p.amount), 0) AS verified_paid
           FROM payments p
          WHERE p.statement_id=s.statement_id AND p.status='Verified'
       ) v ON TRUE
      WHERE c.branch_code=$1 AND GREATEST(s.amount - COALESCE(v.verified_paid, 0), 0) > 0
        AND (c.name ILIKE $2 OR c.account_no LIKE $2)
      ORDER BY s.due_date, s.account_no LIMIT 20`, [req.user.branchCode, `%${req.query.q || ''}%`]);
  res.json(rows);
});

// GET /api/staff/payments?status=Pending
router.get('/payments', async (req, res) => {
  const { rows } = await query(
    `SELECT p.*, c.name FROM payments p JOIN clients c USING (account_no)
      WHERE c.branch_code=$1 AND ($2::text IS NULL OR p.status=$2)
      ORDER BY CASE WHEN p.status='Pending' THEN p.created_at END ASC, p.created_at DESC LIMIT 500`, [req.user.branchCode, req.query.status || null]);
  res.json(rows);
});

// POST /api/staff/payments/cash
router.post('/payments/cash', async (req, res) => {
  const { statementId, amount, orNo } = req.body || {};
  try {
    const out = await tx(async c => {
      const s = (await c.query(
        `SELECT s.*, cl.status AS client_status, COALESCE(v.verified_paid, 0) AS verified_paid,
                GREATEST(s.amount - COALESCE(v.verified_paid, 0), 0) AS remaining_balance
           FROM statements s JOIN clients cl USING (account_no)
           LEFT JOIN LATERAL (
             SELECT COALESCE(SUM(p.amount), 0) AS verified_paid
               FROM payments p
              WHERE p.statement_id=s.statement_id AND p.status='Verified'
           ) v ON TRUE
          WHERE s.statement_id=$1 AND cl.branch_code=$2
          FOR UPDATE OF s`, [statementId, req.user.branchCode])).rows[0];
      if (!s) throw new Error('Statement not found in your branch.');
      const amt = Number(amount);
      const remainingBalance = Number(s.remaining_balance);
      if (!(amt > 0) || amt > remainingBalance) throw new Error('Payment amount must be greater than 0 and not exceed the remaining balance.');
      const pastDue = new Date(s.due_date) < new Date(new Date().toDateString());
      const isFull = amt === remainingBalance;
      const terminated = String(s.client_status).toLowerCase() === 'terminated';
      if ((terminated || Number(s.verified_paid) > 0 || String(s.payment_status).toLowerCase() === 'partially paid') && !isFull)
        throw new Error(terminated
          ? 'Terminated accounts must pay the full remaining balance.'
          : 'A partially paid statement requires full payment of its remaining balance.');
      if (pastDue && !isFull) throw new Error('Account is past due: full remaining balance is required.');
      const p = await c.query(
        `INSERT INTO payments (statement_id, account_no, amount, method, payment_type, or_no, payment_date)
         VALUES ($1,$2,$3,'Cash',$4,$5,current_date) RETURNING payment_id`,
        [statementId, s.account_no, amt, isFull ? 'Full payment' : 'Partial payment', orNo || null]);
      return applyVerifiedPayment(c, p.rows[0].payment_id, req.user.userId, req.user.branchCode);
    });
    res.status(201).json({ ok: true, orNo: out, message: `Cash payment recorded and verified (O.R. ${out}).` });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// PATCH /api/staff/payments/:id/verify
router.patch('/payments/:id/verify', async (req, res) => {
  try {
    const orNo = await tx(async c => {
      await lockQueue(c, req.user.branchCode);
      await assertHead(c, req.user.branchCode, req.params.id);
      const p = (await c.query(
        `SELECT p.* FROM payments p JOIN clients cl USING (account_no)
          WHERE p.payment_id=$1 AND cl.branch_code=$2 AND p.status='Pending' FOR UPDATE OF p`,
        [req.params.id, req.user.branchCode])).rows[0];
      if (!p) throw new Error('Pending payment not found in your branch.');
      return applyVerifiedPayment(c, p.payment_id, req.user.userId, req.user.branchCode);
    });
    res.json({ ok: true, orNo, message: `Payment verified successfully (O.R. ${orNo}).` });
    deliverPendingEmails().catch(e => console.error(e));
  } catch (e) { res.status(e.status || 400).json({ error: e.message }); }
});

// PATCH /api/staff/payments/:id/reject
router.patch('/payments/:id/reject', async (req, res) => {
  try {
    await tx(async c => {
      await lockQueue(c, req.user.branchCode);
      await assertHead(c, req.user.branchCode, req.params.id);
      const r = (await c.query(`UPDATE payments SET status='Rejected', verified_by_staff=$2, verified_at=now() WHERE payment_id=$1
                                RETURNING account_no, statement_id, reference_no`, [req.params.id, req.user.userId])).rows[0];
      const msg = `We could not match GCash reference ${r.reference_no} to your payment, so it was not accepted. Please check the reference number and submit your payment again.`;
      await addNotice(c, { accountNo: r.account_no, statementId: r.statement_id, type: 'System Notice', channel: 'Portal Notification', status: 'Sent', message: msg });
      await addNotice(c, { accountNo: r.account_no, statementId: r.statement_id, type: 'System Notice', channel: 'Email', status: 'Pending', message: msg });
      await logActivity(c, req.user.userId, req.user.branchCode, `Rejected payment #${req.params.id}`);
    });
    res.json({ ok: true, message: 'Payment rejected and client notified.' });
    deliverPendingEmails().catch(e => console.error(e));
  } catch (e) { res.status(e.status || 400).json({ error: e.message }); }
});

// GET /api/staff/cancellations ; PATCH /api/staff/cancellations/:id
router.get('/cancellations', async (req, res) => {
  const { rows } = await query(
    `SELECT r.*, c.name FROM cancellation_requests r JOIN clients c USING (account_no)
      WHERE c.branch_code=$1 AND r.status='Pending'
        AND NOT EXISTS (
          SELECT 1 FROM account_status_log h
           WHERE h.account_no=c.account_no
             AND h.new_status='Active'
             AND h.changed_at > r.created_at
        )
      ORDER BY r.created_at DESC`, [req.user.branchCode]);
  res.json(rows);
});

router.patch('/cancellations/:id', async (req, res) => {
  try {
    const approve = req.body && req.body.approve;
    if (typeof approve !== 'boolean') return res.status(400).json({ error: 'Choose whether to approve or reject the cancellation request.' });
    await tx(async c => {
      const r = (await c.query(
        `SELECT r.* FROM cancellation_requests r JOIN clients cl USING (account_no)
          WHERE r.request_id=$1::integer AND cl.branch_code=$2::char(2)
            AND r.status='Pending'
            AND NOT EXISTS (
              SELECT 1 FROM account_status_log h
               WHERE h.account_no=cl.account_no
                 AND h.new_status='Active'
                 AND h.changed_at > r.created_at
            )
          FOR UPDATE OF r`,
        [req.params.id, req.user.branchCode])).rows[0];
      if (!r) throw new Error('Pending cancellation request not found in your branch.');
      await c.query(
        'UPDATE cancellation_requests SET status=$2::varchar(10), decided_by_staff=$3::integer, decided_at=now() WHERE request_id=$1::integer',
        [r.request_id, approve ? 'Approved' : 'Rejected', req.user.userId]);
      if (approve) {
        await changeStatus(c, r.account_no, 'Terminated', 'Cancellation approved', req.user.userId,
          { termReason: 'Client cancellation' });
      }
      await logActivity(c, req.user.userId, req.user.branchCode, `${approve ? 'Approved' : 'Rejected'} cancellation of ${r.account_no}`);
    });
    res.json({
      ok: true,
      message: approve
        ? 'Cancellation request approved and subscriber account terminated.'
        : 'Cancellation request rejected; subscriber remains active.'
    });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// GET /api/staff/activity
router.get('/activity', async (req, res) => {
  const { rows } = await query(
    `SELECT * FROM activity_log WHERE branch_code=$1 AND logged_at >= now() - interval '6 months'
      ORDER BY logged_at DESC LIMIT 200`, [req.user.branchCode]);
  res.json(rows);
});

module.exports = router;