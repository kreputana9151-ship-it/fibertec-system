// Sends the queued (Pending) email notices: payment receipts, disconnection warnings, rejected-payment notes.
const { query } = require('../db');
const { sendEmail } = require('./mailer');
const peso = n => 'PHP ' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const site = () => (process.env.APP_URL ? `\n\nLog in to your portal: ${process.env.APP_URL}` : '');

function compose(n) {
  const hi = `Hi ${n.name.split(' ')[0]},\n\n`;
  if (n.notice_type === 'Disconnection Warning')
    return { subject: 'FiberTec: your payment is overdue', text: `${hi}your e-Statement ${n.invoice_no} (${peso(n.balance)}) was due ${n.due_date} and is still unpaid. Your account is now in the grace period until ${n.grace_end || 'the date shown in your portal'}. Please pay the full balance before then to avoid disconnection.${site()}` };
  if (n.notice_type === 'Payment Receipt') return { subject: 'FiberTec: payment received', text: `${hi}${n.message || 'we received your payment. Thank you!'}${site()}` };
  return { subject: 'FiberTec: notice about your account', text: `${hi}${n.message || 'Please check your account for details.'}${site()}` };
}

async function deliverPendingEmails() {
  const { rows } = await query(
    `SELECT n.notice_id, n.notice_type, n.message, n.recipient, c.name, s.invoice_no,
            GREATEST(s.amount - COALESCE(v.verified_paid, 0), 0) AS balance,
            s.due_date::text AS due_date, c.grace_end_date::text AS grace_end
       FROM notices n JOIN clients c ON c.account_no = n.account_no LEFT JOIN statements s ON s.statement_id = n.statement_id
       LEFT JOIN LATERAL (
         SELECT COALESCE(SUM(p.amount), 0) AS verified_paid
           FROM payments p
          WHERE p.statement_id=s.statement_id AND p.status='Verified'
       ) v ON TRUE
      WHERE n.channel='Email' AND n.delivery_status='Pending' AND n.notice_type <> '7-Day Billing Notice'
        AND n.created_at > now() - interval '3 days' ORDER BY n.notice_id LIMIT 50`);
  for (const n of rows) {
    const claim = await query("UPDATE notices SET delivery_status='Failed' WHERE notice_id=$1 AND delivery_status='Pending'", [n.notice_id]);   // claim, so it is never sent twice
    if (!claim.rowCount) continue;
    const m = compose(n), ok = await sendEmail(n.recipient, m.subject, m.text);
    if (ok) await query("UPDATE notices SET delivery_status='Sent' WHERE notice_id=$1", [n.notice_id]);
  }
  return rows.length;
}
module.exports = { deliverPendingEmails };
