// Builds the e-Statement PDF (same content as the client portal's e-statement panel)
const PDFDocument = require('pdfkit');
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const money = n => 'PHP ' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });   // Helvetica has no peso sign
const fmtDate = s => { const [y, m, d] = s.split('-'); return `${MON[m - 1]} ${Number(d)}, ${y}`; };

function buildStatementPdf(out, s, payments) {
  const doc = new PDFDocument({ size: 'A4', margin: 50, info: { Title: `E-Statement ${s.invoice_no}`, Author: 'FiberTec IT Solutions' } });
  doc.pipe(out);
  const W = doc.page.width - 100;
  const todayParts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date()).reduce((parts, item) => {
    if (item.type !== 'literal') parts[item.type] = item.value;
    return parts;
  }, {});
  const today = `${todayParts.year}-${todayParts.month}-${todayParts.day}`;
  const status = Number(s.balance) <= 0 ? 'Paid' : s.due_date < today ? 'Overdue' : s.payment_status;

  doc.rect(0, 0, doc.page.width, 90).fill('#013f70');
  doc.fillColor('#fff').font('Helvetica-Bold').fontSize(20).text('FiberTec IT Solutions', 50, 28);
  doc.font('Helvetica').fontSize(10).text('E-STATEMENT', 50, 54);
  doc.font('Helvetica-Bold').fontSize(13).text(s.invoice_no, 50, 28, { width: W, align: 'right' });
  doc.font('Helvetica').fontSize(10).text(`Issued ${fmtDate(s.issued_date)}`, 50, 54, { width: W, align: 'right' });

  let y = 115; doc.fillColor('#000');
  [['Status', status], ['Due date', fmtDate(s.due_date)], ['Amount due', money(s.balance)]].forEach((c, i) => {
    const x = 50 + i * (W / 3);
    doc.font('Helvetica').fontSize(9).fillColor('#667').text(c[0], x, y);
    doc.font('Helvetica-Bold').fontSize(14).fillColor('#013f70').text(c[1], x, y + 13, { width: W / 3 - 8 });
  });
  y += 55; doc.moveTo(50, y).lineTo(50 + W, y).strokeColor('#ccd').stroke(); y += 12;

  doc.font('Helvetica-Bold').fontSize(9).fillColor('#667').text('BILL TO', 50, y).text('ACCOUNT', 50, y, { width: W, align: 'right' });
  doc.font('Helvetica-Bold').fontSize(12).fillColor('#000').text(s.name.toUpperCase(), 50, y + 16, { width: W * 0.6 });
  const nameBottom = doc.y;
  doc.font('Helvetica').fontSize(10).fillColor('#444').text(s.address, 50, nameBottom + 2, { width: W * 0.6 });
  doc.font('Helvetica-Bold').fontSize(12).fillColor('#000').text(s.account_no, 50, y + 16, { width: W, align: 'right' });
  doc.font('Helvetica').fontSize(10).fillColor('#444').text(`${s.branch.toUpperCase()} BRANCH`, 50, y + 32, { width: W, align: 'right' });
  y = Math.max(doc.y, y + 50) + 18;

  doc.font('Helvetica-Bold').fontSize(9).fillColor('#667').text('DESCRIPTION', 50, y).text('AMOUNT', 50, y, { width: W, align: 'right' });
  y += 14; doc.moveTo(50, y).lineTo(50 + W, y).strokeColor('#ccd').stroke(); y += 8;
  doc.font('Helvetica-Bold').fontSize(11).fillColor('#000').text(s.plan_name.toUpperCase(), 50, y).text(money(s.amount), 50, y, { width: W, align: 'right' });
  doc.font('Helvetica').fontSize(9).fillColor('#667').text(`${fmtDate(s.issued_date)} - ${fmtDate(s.due_date)}`, 50, y + 15);
  y += 44;

  doc.font('Helvetica-Bold').fontSize(9).fillColor('#667').text('PAYMENTS RECEIVED', 50, y).text(money(s.amount_paid), 50, y, { width: W, align: 'right' });
  y += 14; doc.moveTo(50, y).lineTo(50 + W, y).strokeColor('#ccd').stroke(); y += 8;
  if (!payments.length) { doc.font('Helvetica-Oblique').fontSize(10).fillColor('#889').text('No payments yet', 50, y); y += 20; }
  payments.forEach(p => {
    const ref = [p.method, p.reference_no && `Ref ${p.reference_no}`, p.or_no && `O.R. ${p.or_no}`].filter(Boolean).join('  |  ');
    doc.font('Helvetica').fontSize(10).fillColor('#000').text(ref, 50, y).text(money(p.amount), 50, y, { width: W, align: 'right' });
    doc.fontSize(8.5).fillColor('#667').text(`${fmtDate(p.payment_date)}  -  ${p.status === 'Verified' ? 'Verified' : 'Awaiting verification'}`, 50, y + 13);
    y += 32;
  });

  y += 6; doc.moveTo(50, y).lineTo(50 + W, y).strokeColor('#013f70').lineWidth(1.5).stroke(); y += 10;
  doc.font('Helvetica-Bold').fontSize(13).fillColor('#013f70').text('Total amount due', 50, y).text(money(s.balance), 50, y, { width: W, align: 'right' });
  doc.font('Helvetica').fontSize(9).fillColor('#667').text('Pay with GCash and submit the 13-digit reference number in the client portal, or pay in cash at your branch.', 50, y + 50, { width: W });
  doc.end();
}

// all data one e-Statement needs
async function loadStatement(query, statementId) {
  const s = (await query(
    `SELECT s.invoice_no, s.issued_date::text, s.due_date::text, s.amount,
            COALESCE(v.verified_paid, 0) AS amount_paid,
            GREATEST(s.amount - COALESCE(v.verified_paid, 0), 0) AS balance,
            CASE WHEN COALESCE(v.verified_paid, 0) >= s.amount THEN 'Paid'
                 WHEN COALESCE(v.verified_paid, 0) > 0 THEN 'Partially paid'
                 ELSE 'Unpaid' END AS payment_status,
            c.name, c.address, c.account_no, p.plan_name, b.name AS branch
       FROM statements s JOIN clients c ON c.account_no = s.account_no JOIN plans p ON p.plan_id = c.plan_id JOIN branches b ON b.branch_code = c.branch_code
       LEFT JOIN LATERAL (
         SELECT COALESCE(SUM(pm.amount), 0) AS verified_paid
           FROM payments pm
          WHERE pm.statement_id=s.statement_id AND pm.status='Verified'
       ) v ON TRUE
      WHERE s.statement_id=$1`, [statementId])).rows[0];
  if (!s) return null;
  const pays = (await query(`SELECT method, reference_no, or_no, status, amount, payment_date::text FROM payments
                              WHERE statement_id=$1 AND status <> 'Rejected' ORDER BY created_at`, [statementId])).rows;
  return { s, pays };
}
function pdfBuffer(s, pays) {
  return new Promise((resolve, reject) => {
    const { PassThrough } = require('stream'), out = new PassThrough(), chunks = [];
    out.on('data', c => chunks.push(c)); out.on('end', () => resolve(Buffer.concat(chunks))); out.on('error', reject);
    buildStatementPdf(out, s, pays);
  });
}
module.exports = { buildStatementPdf, loadStatement, pdfBuffer };
