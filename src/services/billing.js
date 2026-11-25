const { tx, query } = require('../db');
const { changeStatus, addNotice, logActivity } = require('./audit');
const { ACCOUNT_SUMMARY_CTES, loadAccountSummary } = require('./accountSummary');
const { sendEmail } = require('./mailer');
const { loadStatement, pdfBuffer } = require('./statementPdf');
const { deliverPendingEmails } = require('./notify');

const pad = (n, l = 2) => String(n).padStart(l, '0');
const dateOnly = value => {
  const date = value instanceof Date ? value.toISOString().slice(0, 10) : String(value || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`Invalid billing date: ${value}`);
  return date;
};
const iso = dateOnly;
const manilaDate = value => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(value);
  const part = type => parts.find(item => item.type === type).value;
  return `${part('year')}-${part('month')}-${part('day')}`;
};
const anniversaryDate = (installedDate, monthOffset) => {
  const [year, month, day] = dateOnly(installedDate).split('-').map(Number);
  const target = new Date(Date.UTC(year, month - 1 + monthOffset, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), Math.min(day, last))).toISOString().slice(0, 10);
};
const monthStart = value => `${dateOnly(value).slice(0, 7)}-01`;
const addDays = (value, days) => {
  const [year, month, day] = dateOnly(value).split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
};
const isInBillingWindow = (dueDate, today) =>
  today >= addDays(dueDate, -7) && dueDate <= addDays(today, 7);

// Invoice month follows the cycle's due month, e.g. "B1 - 2612 - 1001".
const invoiceNo = (shortName, dueDate, accountNo) =>
  `${shortName} - ${dateOnly(dueDate).slice(2, 4)}${dateOnly(dueDate).slice(5, 7)} - ${accountNo.slice(4)}`;

async function insertStatement(c, { accountNo, shortName, issuedDate, dueDate }) {
  const summary = await loadAccountSummary(c, accountNo);
  if (!summary) throw new Error('Client account not found while creating a statement.');
  if (Number(summary.previous_balance) > 0) return false;

  const result = await c.query(
    `INSERT INTO statements (invoice_no, account_no, billing_month, issued_date, due_date, amount, balance)
     SELECT $1,$2,$3,$4,$5,p.monthly_rate,p.monthly_rate
       FROM clients cl JOIN plans p USING (plan_id)
      WHERE cl.account_no=$2
     ON CONFLICT (account_no, billing_month) DO NOTHING
     RETURNING statement_id`,
    [invoiceNo(shortName, dueDate, accountNo), accountNo, monthStart(dueDate), issuedDate, dueDate]
  );
  await c.query(
    `UPDATE clients cl
        SET current_balance=COALESCE((
          SELECT SUM(GREATEST(s.amount - COALESCE(s.amount_paid, 0), 0))
            FROM statements s
           WHERE s.account_no=cl.account_no
             AND s.billing_month <= date_trunc('month', (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Manila')::date)::date
        ), 0)
      WHERE cl.account_no=$1`,
    [accountNo]
  );
  return result.rowCount > 0;
}

async function createInitialStatement(c, { accountNo, shortName, installedDate, staffUserId, branchCode }) {
  const issuedDate = dateOnly(installedDate);
  const todayDate = manilaDate(new Date());
  if (issuedDate > todayDate) return false;

  // Create the initial installation/subscription statement (paid upon registration)
  const initStmt = await c.query(
    `INSERT INTO statements (invoice_no, account_no, billing_month, issued_date, due_date, amount, amount_paid, balance, payment_status, send_status, sent_at)
     SELECT $1, $2, $3::date, $4::date, $4::date, p.monthly_rate, p.monthly_rate, 0, 'Paid', 'Delivered', now()
       FROM clients cl JOIN plans p USING (plan_id)
      WHERE cl.account_no=$2
     ON CONFLICT (account_no, billing_month) DO NOTHING
     RETURNING statement_id, amount`,
    [invoiceNo(shortName, issuedDate, accountNo), accountNo, monthStart(issuedDate), issuedDate]
  );

  if (initStmt.rowCount > 0) {
    const stmt = initStmt.rows[0];
    const orNo = await nextOfficialReceipt(c);
    await c.query(
      `INSERT INTO payments (statement_id, account_no, amount, method, payment_type, payment_date, status, or_no, verified_by_staff, verified_at)
       VALUES ($1, $2, $3, 'Cash', 'Full payment', $4::date, 'Verified', $5, $6, now())`,
      [stmt.statement_id, accountNo, stmt.amount, issuedDate, orNo, staffUserId || null]
    );
    await addNotice(c, {
      accountNo,
      statementId: stmt.statement_id,
      type: 'Payment Receipt',
      channel: 'Portal Notification',
      status: 'Sent',
      message: `Initial subscription payment of PHP ${Number(stmt.amount).toFixed(2)} received upon registration (O.R. ${orNo}). Thank you!`
    });
    if (staffUserId && branchCode) {
      await logActivity(c, staffUserId, branchCode, `Recorded initial Cash payment ${orNo} for ${accountNo}`);
    }
    return true;
  }

  const dueDate = anniversaryDate(installedDate, 1);
  if (!isInBillingWindow(dueDate, todayDate)) return false;
  return insertStatement(c, { accountNo, shortName, issuedDate, dueDate });
}

/* Create at most the current cycle's statement when its due date is within seven days. */
async function generateStatementsForToday(today = new Date()) {
  const todayDate = today instanceof Date ? manilaDate(today) : dateOnly(today);
  return tx(async c => {
    const { rows } = await c.query(
      `WITH ${ACCOUNT_SUMMARY_CTES},
       billing_run_clock AS (
         SELECT $1::date AS today,
                date_trunc('month', $1::date)::date AS current_month
       ),
       billing_latest_statement AS (
         SELECT s.account_no, MAX(s.due_date) AS due_date
           FROM statements s
           CROSS JOIN billing_run_clock clock
          WHERE s.billing_month <= clock.current_month
          GROUP BY s.account_no
       ),
       eligible_cycles AS (
         SELECT cl.account_no, cl.installed_date, cl.due_day, b.short_name,
                COALESCE(latest.due_date, cl.installed_date) AS issued_date,
                (date_trunc('month', cl.installed_date)::date
                  + make_interval(months =>
                    CASE WHEN latest.due_date IS NULL THEN 1
                         ELSE (
                           (EXTRACT(YEAR FROM latest.due_date)::int
- EXTRACT(YEAR FROM cl.installed_date)::int) * 12
                           + EXTRACT(MONTH FROM latest.due_date)::int
- EXTRACT(MONTH FROM cl.installed_date)::int + 1
                         )
                    END
                  ))::date AS due_month,
                clock.today
           FROM clients cl
           JOIN branches b USING (branch_code)
           JOIN account_summary summary USING (account_no)
           LEFT JOIN billing_latest_statement latest USING (account_no)
           CROSS JOIN billing_run_clock clock
          WHERE summary.effective_status IN ('Active','Grace Period')
            AND summary.previous_balance=0
            AND cl.installed_date <= clock.today
       ),
       dated_cycles AS (
         SELECT cycle.*,
                (cycle.due_month
                  + LEAST(
                      cycle.due_day::int,
                      EXTRACT(DAY FROM (cycle.due_month + INTERVAL '1 month - 1 day'))::int
                    ) - 1)::date AS due_date
           FROM eligible_cycles cycle
       ),
       inserted AS (
         INSERT INTO statements
           (invoice_no, account_no, billing_month, issued_date, due_date, amount, balance)
         SELECT cycle.short_name || ' - ' || TO_CHAR(cycle.due_date, 'YYMM')
                  || ' - ' || SUBSTRING(cycle.account_no FROM 5),
                cycle.account_no, date_trunc('month', cycle.due_date)::date,
                cycle.issued_date, cycle.due_date, plan.monthly_rate, plan.monthly_rate
           FROM dated_cycles cycle
           JOIN clients cl USING (account_no)
           JOIN plans plan USING (plan_id)
          WHERE cycle.today >= cycle.due_date - INTERVAL '7 days'
            AND cycle.due_date <= cycle.today + INTERVAL '7 days'
         ON CONFLICT (account_no, billing_month) DO NOTHING
         RETURNING account_no
       )
       SELECT account_no FROM inserted`,
      [todayDate]
    );
    if (rows.length) {
      await c.query(
        `UPDATE clients cl
            SET current_balance=COALESCE((
              SELECT SUM(GREATEST(s.amount - COALESCE(s.amount_paid, 0), 0))
                FROM statements s
               WHERE s.account_no=cl.account_no
                 AND s.billing_month <= date_trunc(
                   'month', (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Manila')::date
                 )::date
            ), 0)
          WHERE cl.account_no=ANY($1::char(8)[])`,
        [rows.map(row => row.account_no)]
      );
    }
    return rows.length;
  });
}

/* Send one statement by email + bell notice. adminUserId = null when the system sends it. */
async function sendStatement(statementId, adminUserId) {
  const { rows } = await query(
    `SELECT s.statement_id, s.invoice_no, s.account_no, s.due_date, s.amount,
            COALESCE(v.verified_paid, 0) AS amount_paid,
            GREATEST(s.amount - COALESCE(v.verified_paid, 0), 0) AS balance,
            c.email, c.name
       FROM statements s JOIN clients c USING (account_no)
       LEFT JOIN LATERAL (
         SELECT COALESCE(SUM(p.amount), 0) AS verified_paid
           FROM payments p
          WHERE p.statement_id=s.statement_id AND p.status='Verified'
       ) v ON TRUE
      WHERE s.statement_id=$1`,
    [statementId]
  );
  if (!rows.length) throw new Error('Statement not found');
  const s = rows[0];
  const money = n => 'PHP ' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const paymentInstructions = Number(s.amount_paid) > 0 && Number(s.balance) > 0
    ? 'A partial payment has already been verified. Please pay the remaining balance.'
    : 'You can pay in full or submit a partial payment.';
  let attachments = [];
  try { const d = await loadStatement(query, statementId); attachments = [{ name: `FiberTec-Statement-${s.invoice_no.replace(/[^A-Za-z0-9-]+/g, '')}.pdf`, content: (await pdfBuffer(d.s, d.pays)).toString('base64') }]; }
  catch (e) { console.error('[statement pdf]', e.message); }
  const ok = await sendEmail(
    s.email, `FiberTec e-Statement ${s.invoice_no}`,
    `Hi ${s.name.split(' ')[0]},\n\nyour e-Statement ${s.invoice_no} is ready (PDF attached).\nAmount due: ${money(s.balance)}\nDue date: ${dateOnly(s.due_date)}\nAccount no.: ${s.account_no}\n\n${paymentInstructions} Pay with GCash and submit the 13-digit reference number in the client portal, or pay in cash at your branch.${process.env.APP_URL ? `\n\nClient portal: ${process.env.APP_URL}` : ''}`,
    { attachments }
  );
  await tx(async c => {
    await c.query(
      'UPDATE statements SET send_status=$2, sent_by_admin=$3, sent_at=now() WHERE statement_id=$1',
      [statementId, ok ? 'Delivered' : 'Failed', adminUserId || null]
    );
    await addNotice(c, { accountNo: s.account_no, statementId, type: '7-Day Billing Notice', channel: 'Email', status: ok ? 'Sent' : 'Failed' });
    await addNotice(c, { accountNo: s.account_no, statementId, type: '7-Day Billing Notice', channel: 'Portal Notification', status: 'Sent' });
  });
  return ok;
}

async function sendPendingStatements() {
  const { rows } = await query(
    "SELECT statement_id FROM statements WHERE send_status='Not Yet Sent' AND issued_date <= (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Manila')::date"
  );
  for (const r of rows) await sendStatement(r.statement_id, null);
  return rows.length;
}

/* Daily status engine
   Active -> Grace Period       : day after due date, balance still > 0 (sends Disconnection Warning)
   Grace Period -> Under Review : after the 5 grace days, still unpaid
   Under Review -> Terminated   : 3 days after flagged, if the admin has not decided */
async function runStatusEngine() {
  const out = { grace: 0, review: 0, terminated: 0 };

  const paidTerminations = await query(
    `WITH ${ACCOUNT_SUMMARY_CTES}
     SELECT c.account_no
       FROM clients c
       JOIN account_summary summary USING (account_no)
      WHERE c.status IN ('Grace Period', 'Under Review', 'Terminated')
        AND summary.total_balance=0`
  );
  for (const r of paidTerminations.rows) {
    await tx(c => changeStatus(c, r.account_no, 'Active', 'All balances paid', null));
  }

  const arrears = await query(
    `WITH ${ACCOUNT_SUMMARY_CTES}
     SELECT c.account_no
       FROM clients c
       JOIN account_summary summary USING (account_no)
      WHERE summary.previous_balance > 0
        AND c.status <> 'Terminated'`
  );
  for (const r of arrears.rows) {
    await tx(c => changeStatus(c, r.account_no, 'Terminated',
      'Unpaid balance from a previous billing month', null, { termReason: 'Non-payment' }));
    out.terminated++;
  }

  const a = await query(
    `SELECT DISTINCT ON (c.account_no) c.account_no, s.statement_id,
            TO_CHAR(s.due_date + 5, 'YYYY-MM-DD') AS grace_end_date
       FROM clients c JOIN statements s USING (account_no)
       LEFT JOIN LATERAL (
         SELECT COALESCE(SUM(p.amount), 0) AS verified_paid
           FROM payments p
          WHERE p.statement_id=s.statement_id AND p.status='Verified'
       ) v ON TRUE
      WHERE c.status='Active'
        AND s.billing_month = date_trunc('month', (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Manila')::date)::date
        AND GREATEST(s.amount - COALESCE(v.verified_paid, 0), 0) > 0
        AND s.due_date < (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Manila')::date
      ORDER BY c.account_no, s.due_date DESC`
  );
  for (const r of a.rows) {
    await tx(async c => {
      await changeStatus(c, r.account_no, 'Grace Period', 'Unpaid after due date', null,
        { graceEnd: r.grace_end_date });
      await addNotice(c, { accountNo: r.account_no, statementId: r.statement_id, type: 'Disconnection Warning', channel: 'Email' });
      await addNotice(c, { accountNo: r.account_no, statementId: r.statement_id, type: 'Disconnection Warning', channel: 'Portal Notification', status: 'Sent' });
    });
    out.grace++;
  }

  const g = await query(
    `SELECT account_no FROM clients
      WHERE status='Grace Period'
        AND grace_end_date < (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Manila')::date`
  );
  for (const r of g.rows) {
    await tx(c => changeStatus(c, r.account_no, 'Under Review', 'Grace period ended', null));
    out.review++;
  }

  const u = await query(
    `SELECT account_no FROM clients
      WHERE status='Under Review'
        AND flagged_date <= (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Manila')::date - 3`
  );
  for (const r of u.rows) {
    await tx(c => changeStatus(c, r.account_no, 'Terminated', 'No admin decision within 3 days', null,
      { termReason: 'Non-payment' }));
    out.terminated++;
  }
  await deliverPendingEmails();
  return out;
}

/* Apply a VERIFIED payment to its statement, issue the OR number,
   and return the account to Active if the full balance is cleared. */
async function nextOfficialReceipt(c) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const generated = (await c.query(
      `SELECT nextval('official_receipt_seq'::regclass) AS sequence,
              EXTRACT(YEAR FROM CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Manila')::int AS year`
    )).rows[0];
    const orNo = `OR-${generated.year}-${String(generated.sequence).padStart(6, '0')}`;
    const existing = await c.query('SELECT 1 FROM payments WHERE or_no=$1 LIMIT 1', [orNo]);
    if (!existing.rowCount) return orNo;
  }
  throw new Error('Could not allocate a unique official receipt number. Please retry verification.');
}

async function applyVerifiedPayment(c, paymentId, staffUserId, branchCode) {
  const p = (await c.query('SELECT * FROM payments WHERE payment_id=$1 FOR UPDATE', [paymentId])).rows[0];
  if (!p || p.status !== 'Pending') throw new Error('Pending payment not found.');
  const s = (await c.query('SELECT * FROM statements WHERE statement_id=$1 FOR UPDATE', [p.statement_id])).rows[0];
  if (!s || s.account_no !== p.account_no) throw new Error('Payment statement not found.');
  const verified = Number((await c.query(
    `SELECT COALESCE(SUM(amount), 0) AS total
       FROM payments WHERE statement_id=$1 AND status='Verified'`, [s.statement_id]
  )).rows[0].total);
  const remaining = Math.max(Number(s.amount) - verified, 0);
  if (Number(p.amount) > remaining) {
    const excess = Number(p.amount) - remaining;
    throw new Error(`Payment exceeds the remaining statement balance by PHP ${excess.toFixed(2)}. Reject this payment instead of verifying it.`);
  }

  const paid = verified + Number(p.amount);
  const balance = Math.max(Number(s.amount) - paid, 0);
  const orNo = await nextOfficialReceipt(c);
  await c.query(
    'UPDATE statements SET amount_paid=$2, balance=$3, payment_status=$4 WHERE statement_id=$1',
    [s.statement_id, paid, balance, balance === 0 ? 'Paid' : 'Partially paid']
  );
  await c.query(
    "UPDATE payments SET status='Verified', or_no=$2, verified_by_staff=$3, verified_at=now() WHERE payment_id=$1",
    [paymentId, orNo, staffUserId]
  );
  await c.query(
    `UPDATE clients
        SET current_balance=COALESCE((
          SELECT SUM(GREATEST(st.amount - COALESCE(st.amount_paid, 0), 0))
            FROM statements st
           WHERE st.account_no=$1
             AND st.billing_month <= date_trunc('month', (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Manila')::date)::date
        ), 0)
      WHERE account_no=$1`,
    [p.account_no]
  );

  const cl = (await c.query(
    'SELECT status, current_balance FROM clients WHERE account_no=$1 FOR UPDATE', [p.account_no]
  )).rows[0];
  if (Number(cl.current_balance) === 0 && ['Grace Period', 'Under Review', 'Terminated'].includes(cl.status)) {
    await changeStatus(c, p.account_no, 'Active', 'Full balance paid', staffUserId);
  }
  const msg = `We received your ${p.method} payment of PHP ${Number(p.amount).toFixed(2)}. Previous verified payments: PHP ${verified.toFixed(2)}. Remaining balance: PHP ${balance.toFixed(2)} (${p.reference_no ? `Ref ${p.reference_no}, ` : ''}O.R. ${orNo}). Thank you!`;
  const rc = { accountNo: p.account_no, statementId: s.statement_id, type: 'Payment Receipt', message: msg };
  await addNotice(c, { ...rc, channel: 'Portal Notification', status: 'Sent' });      // bell notification
  await addNotice(c, { ...rc, channel: 'Email', status: 'Pending' });                 // email, sent right after the commit
  await logActivity(c, staffUserId, branchCode, `Verified ${p.method} payment ${orNo} for ${p.account_no}`);
  return orNo;
}

module.exports = { generateStatementsForToday, createInitialStatement, sendStatement, sendPendingStatements, runStatusEngine, applyVerifiedPayment, iso };