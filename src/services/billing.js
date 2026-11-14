const { tx, query } = require('../db');
const { changeStatus, addNotice, logActivity } = require('./audit');
const { sendEmail } = require('./mailer');
const { loadStatement, pdfBuffer } = require('./statementPdf');
const { deliverPendingEmails } = require('./notify');

const pad = (n, l = 2) => String(n).padStart(l, '0');
const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const lastDay = (y, m) => new Date(y, m + 1, 0).getDate();            // m = 0-11
const dueDateFor = (y, m, dueDay) => new Date(y, m, Math.min(dueDay, lastDay(y, m)));

// invoice no. like "B1 - 2610 - 1001"
const invoiceNo = (shortName, billingMonth, accountNo) =>
  `${shortName} - ${String(billingMonth.getFullYear()).slice(2)}${pad(billingMonth.getMonth() + 1)} - ${accountNo.slice(4)}`;

/* Create statements whose bill date (= due date - 7 days) is today.
   Amount = plan rate + previous unpaid balance. Only Active / Grace Period clients. */
async function generateStatementsForToday(today = new Date()) {
  const { rows: clients } = await query(
    `SELECT c.account_no, c.due_day, c.registered_date, p.monthly_rate, b.short_name
       FROM clients c JOIN plans p USING (plan_id) JOIN branches b USING (branch_code)
      WHERE c.status IN ('Active','Grace Period')`
  );
  let created = 0;
  for (const c of clients) {
    for (const offset of [0, 1]) {            // bill may belong to this month's or next month's due date
      const m = new Date(today.getFullYear(), today.getMonth() + offset, 1);
      const due = dueDateFor(m.getFullYear(), m.getMonth(), c.due_day);
      if (iso(addDays(due, -7)) !== iso(today)) continue;
      if (due <= new Date(c.registered_date)) continue;

      await tx(async cx => {
        const prev = await cx.query(
          'SELECT COALESCE(SUM(balance),0) AS bal FROM statements WHERE account_no=$1 AND billing_month < $2',
          [c.account_no, iso(m)]
        );
        const amount = Number(c.monthly_rate) + Number(prev.rows[0].bal);
        const ins = await cx.query(
          `INSERT INTO statements (invoice_no, account_no, billing_month, bill_date, due_date, amount, balance)
           VALUES ($1,$2,$3,$4,$5,$6,$6) ON CONFLICT (account_no, billing_month) DO NOTHING
           RETURNING statement_id`,
          [invoiceNo(c.short_name, m, c.account_no), c.account_no, iso(m), iso(addDays(due, -7)), iso(due), amount]
        );
        if (ins.rowCount) created++;
      });
    }
  }
  return created;
}

/* Send one statement by email + bell notice. adminUserId = null when the system sends it. */
async function sendStatement(statementId, adminUserId) {
  const { rows } = await query(
    'SELECT s.*, c.email, c.name FROM statements s JOIN clients c USING (account_no) WHERE statement_id=$1',
    [statementId]
  );
  if (!rows.length) throw new Error('Statement not found');
  const s = rows[0];
  const money = n => 'PHP ' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  let attachments = [];
  try { const d = await loadStatement(query, statementId); attachments = [{ name: `FiberTec-Statement-${s.invoice_no.replace(/[^A-Za-z0-9-]+/g, '')}.pdf`, content: (await pdfBuffer(d.s, d.pays)).toString('base64') }]; }
  catch (e) { console.error('[statement pdf]', e.message); }
  const ok = await sendEmail(
    s.email, `FiberTec e-Statement ${s.invoice_no}`,
    `Hi ${s.name.split(' ')[0]},\n\nyour e-Statement ${s.invoice_no} is ready (PDF attached).\nAmount due: ${money(s.balance)}\nDue date: ${iso(new Date(s.due_date))}\nAccount no.: ${s.account_no}\n\nOn or before the due date you can pay in full, or pay half. Pay with GCash and submit the 13-digit reference number in the client portal, or pay in cash at your branch.${process.env.APP_URL ? `\n\nClient portal: ${process.env.APP_URL}` : ''}`,
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
    "SELECT statement_id FROM statements WHERE send_status='Not Yet Sent' AND bill_date <= current_date"
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
    `SELECT DISTINCT ON (c.account_no) c.account_no, s.statement_id, s.due_date
       FROM clients c JOIN statements s USING (account_no)
      WHERE c.status='Active' AND s.balance > 0 AND s.due_date < current_date
      ORDER BY c.account_no, s.due_date DESC`
  );
  for (const r of a.rows) {
    await tx(async c => {
      await changeStatus(c, r.account_no, 'Grace Period', 'Unpaid after due date', null,
        { graceEnd: iso(addDays(new Date(r.due_date), 5)) });
      await addNotice(c, { accountNo: r.account_no, statementId: r.statement_id, type: 'Disconnection Warning', channel: 'Email' });
      await addNotice(c, { accountNo: r.account_no, statementId: r.statement_id, type: 'Disconnection Warning', channel: 'Portal Notification', status: 'Sent' });
    });
    out.grace++;
  }

  const g = await query("SELECT account_no FROM clients WHERE status='Grace Period' AND grace_end_date < current_date");
  for (const r of g.rows) {
    await tx(c => changeStatus(c, r.account_no, 'Under Review', 'Grace period ended', null, { flagged: iso(new Date()) }));
    out.review++;
  }

  const u = await query("SELECT account_no FROM clients WHERE status='Under Review' AND flagged_date <= current_date - 3");
  for (const r of u.rows) {
    await tx(c => changeStatus(c, r.account_no, 'Terminated', 'No admin decision within 3 days', null,
      { termDate: iso(new Date()), termReason: 'Non-payment' }));
    out.terminated++;
  }
  await deliverPendingEmails();
  return out;
}

/* Apply a VERIFIED payment to its statement, issue the OR number,
   and return the account to Active if the full balance is cleared. */
async function applyVerifiedPayment(c, paymentId, staffUserId, branchCode) {
  const p = (await c.query('SELECT * FROM payments WHERE payment_id=$1 FOR UPDATE', [paymentId])).rows[0];
  const s = (await c.query('SELECT * FROM statements WHERE statement_id=$1 FOR UPDATE', [p.statement_id])).rows[0];

  const paid = Number(s.amount_paid) + Number(p.amount);
  const balance = Math.max(Number(s.amount) - paid, 0);
  await c.query(
    'UPDATE statements SET amount_paid=$2, balance=$3, payment_status=$4 WHERE statement_id=$1',
    [s.statement_id, paid, balance, balance === 0 ? 'Paid' : 'Partially paid']
  );

  const orNo = p.or_no || `OR-${new Date().getFullYear()}-${String(paymentId).padStart(6, '0')}`;
  await c.query(
    "UPDATE payments SET status='Verified', or_no=$2, verified_by_staff=$3, verified_at=now() WHERE payment_id=$1",
    [paymentId, orNo, staffUserId]
  );

  if (balance === 0) {
    const cl = (await c.query('SELECT status FROM clients WHERE account_no=$1', [p.account_no])).rows[0];
    if (['Grace Period', 'Under Review'].includes(cl.status))
      await changeStatus(c, p.account_no, 'Active', 'Full balance paid', staffUserId);
  }
  const msg = `we received your ${p.method} payment of PHP ${Number(p.amount).toFixed(2)} (${p.reference_no ? `Ref ${p.reference_no}, ` : ''}O.R. ${orNo}). Thank you!`;
  const rc = { accountNo: p.account_no, statementId: s.statement_id, type: 'Payment Receipt', message: msg };
  await addNotice(c, { ...rc, channel: 'Portal Notification', status: 'Sent' });      // bell notification
  await addNotice(c, { ...rc, channel: 'Email', status: 'Pending' });                 // email, sent right after the commit
  await logActivity(c, staffUserId, branchCode, `Verified ${p.method} payment ${orNo} for ${p.account_no}`);
  return orNo;
}

module.exports = { generateStatementsForToday, sendStatement, sendPendingStatements, runStatusEngine, applyVerifiedPayment, iso };
