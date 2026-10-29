const router = require('express').Router();
const { requireAuth, requireRole } = require('../middleware/auth');
const { query, tx } = require('../db');
const { sendStatement, generateStatementsForToday, runStatusEngine } = require('../services/billing');
const { changeStatus, logActivity } = require('../services/audit');
const { sendEmail } = require('../services/mailer');

router.use(requireAuth, requireRole('admin'));
// admin sees ALL branches. History shown to admin = last 6 months (purge job deletes older rows)

const SIX = "date_trunc('month', current_date) - interval '6 months'";

// GET /api/admin/clients?branch=04&status=Active
router.get('/clients', async (req, res) => {
  const { rows } = await query(
    `SELECT c.account_no, c.name, b.name AS branch, p.plan_name, c.status, c.due_day, c.email
       FROM clients c JOIN branches b USING (branch_code) JOIN plans p USING (plan_id)
      WHERE ($1::text IS NULL OR c.branch_code=$1) AND ($2::text IS NULL OR c.status=$2)
      ORDER BY c.branch_code, c.client_seq`, [req.query.branch || null, req.query.status || null]);
  res.json(rows);
});

// GET /api/admin/statements?month=2026-10-01&branch=04
router.get('/statements', async (req, res) => {
  const { rows } = await query(
    `SELECT s.*, c.name, c.branch_code FROM statements s JOIN clients c USING (account_no)
      WHERE s.billing_month >= (${SIX})
        AND ($1::date IS NULL OR s.billing_month=$1) AND ($2::text IS NULL OR c.branch_code=$2)
      ORDER BY s.billing_month DESC, s.account_no`, [req.query.month || null, req.query.branch || null]);
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
  const ok = n.channel === 'Email' ? await sendEmail(n.recipient, n.notice_type, 'Resent notice') : true;
  await tx(async c => {
    await c.query('UPDATE notices SET delivery_status=$2, resent_by_admin=$3 WHERE notice_id=$1',
      [n.notice_id, ok ? 'Sent' : 'Failed', req.user.userId]);
    await logActivity(c, req.user.userId, null, `Resent notice #${n.notice_id}`);
  });
  res.json({ delivered: ok });
});

// PATCH /api/admin/clients/:accountNo/status  { status: 'Active'|'Terminated', reason }
// Admin decides on Under Review accounts, can terminate, and can reinstate a Terminated account.
router.patch('/clients/:accountNo/status', async (req, res) => {
  const { status, reason } = req.body || {};
  if (!['Active', 'Terminated'].includes(status)) return res.status(400).json({ error: 'Use Active or Terminated' });
  try {
    await tx(async c => {
      const extra = status === 'Terminated'
        ? { termDate: new Date().toISOString().slice(0, 10), termReason: reason || 'Admin decision' } : {};
      await changeStatus(c, req.params.accountNo, status, reason || (status === 'Active' ? 'Reinstated by admin' : 'Terminated by admin'), req.user.userId, extra);
      await logActivity(c, req.user.userId, null, `Set ${req.params.accountNo} to ${status}`);
    });
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// GET /api/admin/clients/:accountNo/status-log
router.get('/clients/:accountNo/status-log', async (req, res) => {
  const { rows } = await query('SELECT * FROM account_status_log WHERE account_no=$1 ORDER BY changed_at DESC', [req.params.accountNo]);
  res.json(rows);
});

// GET /api/admin/analytics?month=2026-10-01  -> Billed vs Collected + Collection Efficiency per branch
router.get('/analytics', async (req, res) => {
  const { rows } = await query(
    `SELECT b.branch_code, b.name AS branch,
            COALESCE(SUM(s.amount),0)      AS billed,
            COALESCE(SUM(s.amount_paid),0) AS collected,
            CASE WHEN COALESCE(SUM(s.amount),0)=0 THEN 0
                 ELSE ROUND(SUM(s.amount_paid)/SUM(s.amount)*100,1) END AS collection_efficiency
       FROM branches b
       LEFT JOIN clients c ON c.branch_code=b.branch_code
       LEFT JOIN statements s ON s.account_no=c.account_no AND s.billing_month=$1::date
      GROUP BY b.branch_code, b.name ORDER BY b.branch_code`,
    [req.query.month || new Date().toISOString().slice(0, 8) + '01']);
  res.json(rows);
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

module.exports = router;
