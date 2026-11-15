const express = require("express");
const pool = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");
const { sendBillingEmail } = require("../services/email");

const router = express.Router();

// Protect all admin endpoints
router.use(requireAuth, requireRole("admin"));

// GET /api/admin/clients
router.get("/clients", async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT c.account_no,
             c.name,
             c.email,
             c.address,
             c.due_day,
             c.status,
             c.created_at,
             c.updated_at,
             b.branch_code,
             b.name AS branch,
             p.plan_id,
             p.name AS plan_name,
             p.monthly_rate
      FROM clients c
      LEFT JOIN branches b ON b.branch_code = c.branch_code
      LEFT JOIN plans p ON p.plan_id = c.plan_id
      ORDER BY c.account_no ASC
    `);
    res.json(rows);
  } catch (err) {
    console.error("GET /api/admin/clients error:", err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/clients
router.post("/clients", async (req, res) => {
  const { account_no, name, email, address, branch_code, plan_id, due_day, status } = req.body || {};
  if (!account_no || !name || !branch_code || !plan_id) {
    return res.status(400).json({ error: "account_no, name, branch_code, and plan_id are required." });
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO clients (account_no, name, email, address, branch_code, plan_id, due_day, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())
       RETURNING *`,
      [
        account_no,
        name,
        email || null,
        address || null,
        branch_code,
        plan_id,
        due_day || 15,
        status || "Active"
      ]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error("POST /api/admin/clients error:", err);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/admin/clients/:accountNo
router.patch("/clients/:accountNo", async (req, res) => {
  const { accountNo } = req.params;
  const { name, email, address, branch_code, plan_id, due_day, status } = req.body || {};

  try {
    const { rows } = await pool.query(
      `UPDATE clients
       SET name = COALESCE($1, name),
           email = COALESCE($2, email),
           address = COALESCE($3, address),
           branch_code = COALESCE($4, branch_code),
           plan_id = COALESCE($5, plan_id),
           due_day = COALESCE($6, due_day),
           status = COALESCE($7, status),
           updated_at = NOW()
       WHERE account_no = $8
       RETURNING *`,
      [name, email, address, branch_code, plan_id, due_day, status, accountNo]
    );
    if (!rows.length) return res.status(404).json({ error: "Client not found." });
    res.json(rows[0]);
  } catch (err) {
    console.error("PATCH /api/admin/clients/:accountNo error:", err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/statements
router.get("/statements", async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT s.statement_id,
             s.invoice_no,
             s.account_no,
             s.billing_month,
             s.bill_date,
             s.due_date,
             s.amount,
             s.amount_paid,
             s.balance,
             s.payment_status,
             s.send_status,
             c.name,
             c.branch_code,
             b.name AS branch
      FROM statements s
      LEFT JOIN clients c ON c.account_no = s.account_no
      LEFT JOIN branches b ON b.branch_code = c.branch_code
      ORDER BY s.billing_month DESC, s.statement_id DESC
    `);
    res.json(rows);
  } catch (err) {
    console.error("GET /api/admin/statements error:", err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/statements/:id/send
router.post("/statements/:id/send", async (req, res) => {
  const { id } = req.params;
  try {
    const { rows } = await pool.query(
      `SELECT s.*, c.name, c.email, c.address, b.name AS branch, p.name AS plan_name
       FROM statements s
       JOIN clients c ON c.account_no = s.account_no
       LEFT JOIN branches b ON b.branch_code = c.branch_code
       LEFT JOIN plans p ON p.plan_id = c.plan_id
       WHERE s.statement_id = $1`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: "Statement not found." });

    const stmt = rows[0];
    let delivered = false;
    if (stmt.email && typeof sendBillingEmail === "function") {
      try {
        await sendBillingEmail(stmt);
        delivered = true;
      } catch (mailErr) {
        console.error("Brevo send error:", mailErr);
      }
    }

    const newSendStatus = delivered ? "Delivered" : "Failed";
    await pool.query(
      `UPDATE statements SET send_status = $1 WHERE statement_id = $2`,
      [newSendStatus, id]
    );

    await pool.query(
      `INSERT INTO notices (account_no, notice_date, channel, recipient, notice_type, delivery_status)
       VALUES ($1, CURRENT_DATE, 'Email', $2, '7-Day Billing Notice', $3)`,
      [stmt.account_no, stmt.email || "No email on file", delivered ? "Sent" : "Failed"]
    );

    res.json({ delivered, send_status: newSendStatus });
  } catch (err) {
    console.error("POST /api/admin/statements/:id/send error:", err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/payments
router.get("/payments", async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT p.payment_id,
             p.statement_id,
             p.account_no,
             p.payment_date,
             p.amount,
             p.payment_method,
             p.reference_no,
             p.or_no,
             p.status,
             p.created_at,
             c.name,
             c.branch_code,
             b.name AS branch
      FROM payments p
      LEFT JOIN clients c ON c.account_no = p.account_no
      LEFT JOIN branches b ON b.branch_code = c.branch_code
      ORDER BY p.payment_date DESC, p.payment_id DESC
    `);
    res.json(rows);
  } catch (err) {
    console.error("GET /api/admin/payments error:", err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/notices
router.get("/notices", async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT n.notice_id,
             n.account_no,
             n.notice_date,
             n.channel,
             n.recipient,
             n.notice_type,
             n.delivery_status,
             n.created_at,
             c.name
      FROM notices n
      LEFT JOIN clients c ON c.account_no = n.account_no
      ORDER BY n.notice_date DESC, n.notice_id DESC
    `);
    res.json(rows);
  } catch (err) {
    console.error("GET /api/admin/notices error:", err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/notices/:id/resend
router.post("/notices/:id/resend", async (req, res) => {
  const { id } = req.params;
  try {
    const { rows } = await pool.query(
      `SELECT n.*, c.name, c.email
       FROM notices n
       LEFT JOIN clients c ON c.account_no = n.account_no
       WHERE n.notice_id = $1`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: "Notice not found." });

    const notice = rows[0];
    let delivered = false;
    if (notice.channel === "Email" && (notice.recipient || notice.email) && typeof sendBillingEmail === "function") {
      try {
        await sendBillingEmail({
          email: notice.recipient || notice.email,
          name: notice.name,
          account_no: notice.account_no,
          notice_type: notice.notice_type
        });
        delivered = true;
      } catch (mailErr) {
        console.error("Resend email error:", mailErr);
      }
    } else if (notice.channel === "Portal Notification") {
      delivered = true;
    }

    const newStatus = delivered ? "Sent" : "Failed";
    await pool.query(
      `UPDATE notices SET delivery_status = $1, notice_date = CURRENT_DATE WHERE notice_id = $2`,
      [newStatus, id]
    );

    res.json({ delivered, delivery_status: newStatus });
  } catch (err) {
    console.error("POST /api/admin/notices/:id/resend error:", err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;