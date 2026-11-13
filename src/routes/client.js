const router = require('express').Router();
const { requireAuth, requireRole } = require('../middleware/auth');
const { query, tx } = require('../db');

router.use(requireAuth, requireRole('client'));

// GET /api/client/me  -> account overview + remaining days until due date
router.get('/me', async (req, res) => {
  const { rows } = await query(
    `SELECT c.account_no, c.name, c.email, c.contact_no, c.address, c.status, c.grace_end_date,
            p.plan_name, p.monthly_rate, b.name AS branch,
            (SELECT row_to_json(x) FROM (
               SELECT invoice_no, due_date, amount, balance, payment_status,
                      (due_date - current_date) AS days_left
                 FROM statements WHERE account_no = c.account_no
                ORDER BY billing_month DESC LIMIT 1) x) AS current_statement
       FROM clients c JOIN plans p USING (plan_id) JOIN branches b USING (branch_code)
      WHERE c.account_no = $1`, [req.user.accountNo]);
  res.json(rows[0]);
});

// the three history endpoints read the 3-month VIEWS (older data is hidden from clients)
router.get('/statements', async (req, res) => {
  const { rows } = await query('SELECT * FROM v_client_statements WHERE account_no=$1 ORDER BY billing_month DESC', [req.user.accountNo]);
  res.json(rows);
});
router.get('/payments', async (req, res) => {
  const { rows } = await query('SELECT * FROM v_client_payments WHERE account_no=$1 ORDER BY payment_date DESC', [req.user.accountNo]);
  res.json(rows);
});
router.get('/notices', async (req, res) => {
  const { rows } = await query('SELECT * FROM v_client_notices WHERE account_no=$1 ORDER BY notice_date DESC', [req.user.accountNo]);
  res.json(rows);
});

// POST /api/client/payments  { statementId, amount, referenceNo }   (GCash reference, goes to Pending)
// Rules: partial only on/before due date; in grace period the FULL balance is required.
router.post('/payments', async (req, res) => {
  const { statementId, amount, referenceNo } = req.body || {};
  if (!/^[0-9]{13}$/.test(referenceNo || '')) return res.status(400).json({ error: 'GCash reference must be 13 digits' });

  const s = (await query('SELECT * FROM statements WHERE statement_id=$1 AND account_no=$2', [statementId, req.user.accountNo])).rows[0];
  if (!s) return res.status(404).json({ error: 'Statement not found' });
  if (Number(s.balance) <= 0) return res.status(400).json({ error: 'Already fully paid' });

  const amt = Number(amount);
  if (!(amt > 0) || amt > Number(s.balance)) return res.status(400).json({ error: 'Invalid amount' });

  const pastDue = new Date(s.due_date) < new Date(new Date().toDateString());
  const isFull = amt === Number(s.balance);
  if (pastDue && !isFull) return res.status(400).json({ error: 'After the due date the full balance is required' });

  try {
    const r = await query(
      `INSERT INTO payments (statement_id, account_no, amount, method, payment_type, reference_no, payment_date)
       VALUES ($1,$2,$3,'GCash',$4,$5,current_date) RETURNING payment_id, status`,
      [statementId, req.user.accountNo, amt, isFull ? 'Full payment' : 'Partial payment', referenceNo]);
    res.status(201).json(r.rows[0]);
  } catch (e) { next500(res, e); }
});

// POST /api/client/cancellation  { reason }
router.post('/cancellation', async (req, res) => {
  const { reason } = req.body || {};
  if (!reason) return res.status(400).json({ error: 'Reason required' });
  const open = await query("SELECT 1 FROM cancellation_requests WHERE account_no=$1 AND status='Pending'", [req.user.accountNo]);
  if (open.rowCount) return res.status(409).json({ error: 'You already have a pending request' });
  const r = await query(
    `INSERT INTO cancellation_requests (account_no, request_date, reason) VALUES ($1,current_date,$2) RETURNING *`,
    [req.user.accountNo, reason]);
  res.status(201).json(r.rows[0]);
});

function next500(res, e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
module.exports = router;
