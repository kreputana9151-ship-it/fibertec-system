const { tx, query } = require('../db');
const { changeStatus, addNotice, logActivity } = require('./audit');
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
const addMonthClamped = value => {
  const [year, month, day] = dateOnly(value).split('-').map(Number);
  const next = new Date(Date.UTC(year, month, 1));
  const last = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth(), Math.min(day, last))).toISOString().slice(0, 10);
};
const monthStart = value => `${dateOnly(value).slice(0, 7)}-01`;

// Invoice month follows the cycle's due month, e.g. "B1 - 2612 - 1001".
const invoiceNo = (shortName, dueDate, accountNo) =>
  `${shortName} - ${dateOnly(dueDate).slice(2, 4)}${dateOnly(dueDate).slice(5, 7)} - ${accountNo.slice(4)}`;

async function insertStatement(c, { accountNo, shortName, issuedDate, dueDate, amount }) {
  const result = await c.query(
    `INSERT INTO statements (invoice_no, account_no, billing_month, issued_date, due_date, amount, balance)
     VALUES ($1,$2,$3,$4,$5,$6,$6) ON CONFLICT (account_no, billing_month) DO NOTHING
     RETURNING statement_id`,
    [invoiceNo(shortName, dueDate, accountNo), accountNo, monthStart(dueDate), issuedDate, dueDate, amount]
  );
  if (!result.rowCount) return false;
  await c.query('UPDATE clients SET current_balance=$2 WHERE account_no=$1', [accountNo, amount]);
  return true;
}

async function createInitialStatement(c, { accountNo, shortName, monthlyRate, registeredDate }) {
  const issuedDate = dateOnly(registeredDate);
  if (issuedDate > manilaDate(new Date())) return false;
  const dueDate = addMonthClamped(issuedDate);
  return insertStatement(c, {
    accountNo, shortName, issuedDate, dueDate, amount: Number(monthlyRate)
  });
}

/* Create each statement on its cycle anniversary, due one clamped month later. */
async function generateStatementsForToday(today = new Date()) {
  const todayDate = today instanceof Date ? manilaDate(today) : dateOnly(today);
  const { rows: clients } = await query(
    `SELECT c.account_no, c.registered_date::text AS registered_date, p.monthly_rate, b.short_name
       FROM clients c JOIN plans p USING (plan_id) JOIN branches b USING (branch_code)
      WHERE c.status IN ('Active','Grace Period')`
  );
  let created = 0;
  for (const c of clients) {
    await tx(async cx => {
      const { rows: latestRows } = await cx.query(
        `SELECT s.due_date::text AS due_date,
                GREATEST(s.amount - COALESCE(v.verified_paid, 0), 0) AS balance
           FROM statements s
           LEFT JOIN LATERAL (
             SELECT COALESCE(SUM(p.amount), 0) AS verified_paid
               FROM payments p
              WHERE p.statement_id=s.statement_id AND p.status='Verified'
           ) v ON TRUE
          WHERE s.account_no=$1
          ORDER BY s.due_date DESC LIMIT 1`, [c.account_no]
      );
      let latest = latestRows[0] || null;
      let issuedDate = latest ? dateOnly(latest.due_date) : dateOnly(c.registered_date);
      while (issuedDate <= todayDate) {
        const dueDate = addMonthClamped(issuedDate);
        const amount = Number(c.monthly_rate) + Number(latest ? latest.balance : 0);
        const inserted = await insertStatement(cx, {
          accountNo: c.account_no,
          shortName: c.short_name,
          issuedDate,
          dueDate,
          amount
        });
        if (!inserted) break;
        created++;
        latest = { due_date: dueDate, balance: amount };
        issuedDate = dueDate;
      }
    });
  }
  return created;
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
    ? 'A partial payment has already been verified. Please pay the full remaining balance.'
    : 'On or before the due date you can pay in full, or pay half.';
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

  const a = await query(
    `SELECT DISTINCT ON (c.account_no) c.account_no, s.statement_id,
            TO_CHAR(s.due_date + 5, 'YYYY-MM-DD') AS grace_end_date
       FROM clients c JOIN statements s USING (account_no)
       LEFT JOIN LATERAL (
         SELECT COALESCE(SUM(p.amount), 0) AS verified_paid
           FROM payments p
          WHERE p.statement_id=s.statement_id AND p.status='Verified'
       ) v ON TRUE
      WHERE c.status='Active' AND GREATEST(s.amount - COALESCE(v.verified_paid, 0), 0) > 0
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
async function applyVerifiedPayment(c, paymentId, staffUserId, branchCode) {
  const p = (await c.query('SELECT * FROM payments WHERE payment_id=$1 FOR UPDATE', [paymentId])).rows[0];
  if (!p || p.status !== 'Pending') throw new Error('Pending payment not found.');
  const s = (await c.query('SELECT * FROM statements WHERE statement_id=$1 FOR UPDATE', [p.statement_id])).rows[0];
  if (!s || s.account_no !== p.account_no) throw new Error('Payment statement not found.');
  const client = (await c.query('SELECT status FROM clients WHERE account_no=$1', [p.account_no])).rows[0];
  const verified = Number((await c.query(
    `SELECT COALESCE(SUM(amount), 0) AS total
       FROM payments WHERE statement_id=$1 AND status='Verified'`, [s.statement_id]
  )).rows[0].total);
  const remaining = Math.max(Number(s.amount) - verified, 0);
  if (Number(p.amount) > remaining) throw new Error('Payment exceeds the remaining statement balance.');
  const terminated = client && String(client.status).toLowerCase() === 'terminated';
  if ((terminated || verified > 0 || String(s.payment_status).toLowerCase() === 'partially paid') && Number(p.amount) !== remaining)
    throw new Error(terminated
      ? 'Terminated accounts must pay the full remaining balance.'
      : 'A partially paid statement requires full payment of its remaining balance.');

  const paid = verified + Number(p.amount);
  const balance = Math.max(Number(s.amount) - paid, 0);
  const orNo = p.or_no || `OR-${new Date().getFullYear()}-${String(paymentId).padStart(6, '0')}`;
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
        SET current_balance=COALESCE(
          (SELECT GREATEST(st.amount - COALESCE(v.verified_paid, 0), 0)
             FROM statements st
             LEFT JOIN LATERAL (
               SELECT COALESCE(SUM(pm.amount), 0) AS verified_paid
                 FROM payments pm
                WHERE pm.statement_id=st.statement_id AND pm.status='Verified'
             ) v ON TRUE
            WHERE st.account_no=$1 ORDER BY st.billing_month DESC LIMIT 1), 0)
      WHERE account_no=$1`,
    [p.account_no]
  );

  const cl = (await c.query(
    'SELECT status, current_balance FROM clients WHERE account_no=$1 FOR UPDATE', [p.account_no]
  )).rows[0];
  if (Number(cl.current_balance) === 0) {
    if (['Grace Period', 'Under Review'].includes(cl.status))
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
