function buildAccountSummaryCtes(scope, paramIndex = 1) {
  const scopeParam = `$${paramIndex}`;
  const paymentFilter = scope === 'account'
    ? `AND p.account_no=${scopeParam}`
    : scope === 'branch'
      ? `AND p.account_no IN (SELECT account_no FROM clients WHERE branch_code=${scopeParam})`
      : '';
  const statementFilter = scope === 'account'
    ? `AND s.account_no=${scopeParam}`
    : scope === 'branch'
      ? `AND s.account_no IN (SELECT account_no FROM clients WHERE branch_code=${scopeParam})`
      : '';
  const clientFilter = scope === 'account'
    ? `WHERE c.account_no=${scopeParam}`
    : scope === 'branch'
      ? `WHERE c.branch_code=${scopeParam}`
      : '';
  return `
billing_clock AS (
  SELECT (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Manila')::date AS today,
         date_trunc('month', (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Manila')::date)::date AS current_month
),
summary_payment_totals AS (
  SELECT p.statement_id,
         SUM(p.amount) FILTER (WHERE p.status='Verified') AS verified_paid,
         COALESCE(BOOL_OR(p.status='Pending'), FALSE) AS has_pending_payment
    FROM payments p
   WHERE p.status IN ('Verified','Pending')
     ${paymentFilter}
   GROUP BY p.statement_id
),
statement_balances AS (
  SELECT s.statement_id, s.account_no, s.billing_month, s.due_date, s.amount,
         COALESCE(p.verified_paid, s.amount_paid, 0) AS amount_paid,
         GREATEST(s.amount - COALESCE(p.verified_paid, s.amount_paid, 0), 0) AS balance,
         COALESCE(p.has_pending_payment, FALSE) AS has_pending_payment,
         clock.current_month
    FROM statements s
    CROSS JOIN billing_clock clock
    LEFT JOIN summary_payment_totals p USING (statement_id)
   WHERE s.billing_month <= clock.current_month
     ${statementFilter}
),
balance_totals AS (
  SELECT s.account_no,
         SUM(s.balance) AS total_balance,
         COALESCE(SUM(s.balance) FILTER (WHERE s.billing_month < s.current_month), 0) AS previous_balance,
         COALESCE(SUM(s.balance) FILTER (WHERE s.billing_month = s.current_month), 0) AS current_month_due,
         BOOL_OR(s.has_pending_payment) AS has_pending_payment
    FROM statement_balances s
   GROUP BY s.account_no
),
latest_statement AS (
  SELECT DISTINCT ON (s.account_no)
         s.account_no, s.statement_id, s.billing_month, s.due_date, s.balance,
         s.amount, s.amount_paid, s.has_pending_payment,
         CASE WHEN s.amount_paid >= s.amount THEN 'Paid'
              WHEN s.amount_paid > 0 THEN 'Partially paid'
              ELSE 'Unpaid' END AS payment_status
    FROM statement_balances s
   ORDER BY s.account_no, s.billing_month DESC, s.due_date DESC, s.statement_id DESC
),
current_statement AS (
  SELECT s.account_no, s.due_date, s.balance
    FROM statement_balances s
   WHERE s.billing_month = s.current_month
),
oldest_open_statement AS (
  SELECT DISTINCT ON (s.account_no)
         s.account_no, s.due_date
    FROM statement_balances s
   WHERE s.balance > 0
     AND s.due_date <= (SELECT today FROM billing_clock)
   ORDER BY s.account_no, s.billing_month, s.due_date
),
account_summary AS (
  SELECT c.account_no,
         COALESCE(t.total_balance, 0) AS total_balance,
         COALESCE(t.previous_balance, 0) AS previous_balance,
         COALESCE(t.current_month_due, 0) AS current_month_due,
         COALESCE(t.has_pending_payment, FALSE) AS has_pending_payment,
         latest.statement_id AS latest_statement_id,
         latest.billing_month AS latest_billing_month,
         latest.due_date AS latest_due_date,
         latest.balance AS latest_statement_balance,
         latest.payment_status AS latest_payment_status,
         current_cycle.due_date AS current_due_date,
         open_cycle.due_date AS overdue_due_date,
         CASE
           WHEN COALESCE(t.previous_balance, 0) > 0 THEN 'Terminated'
           WHEN c.status='Terminated'
            AND LOWER(BTRIM(COALESCE(c.termination_reason, ''))) NOT IN ('non-payment', 'no admin decision within 3 days')
             THEN 'Terminated'
           WHEN c.status='Terminated' AND COALESCE(t.total_balance, 0) > 0 THEN 'Terminated'
           WHEN COALESCE(t.total_balance, 0) = 0 THEN 'Active'
           WHEN COALESCE(t.current_month_due, 0) > 0 THEN
             CASE
               WHEN current_cycle.due_date >= clock.today THEN 'Active'
               WHEN clock.today <= current_cycle.due_date + 5 THEN 'Grace Period'
               WHEN clock.today <= current_cycle.due_date + 8 THEN 'Under Review'
               ELSE 'Terminated'
             END
           ELSE 'Active'
         END AS effective_status
    FROM clients c
    CROSS JOIN billing_clock clock
    LEFT JOIN balance_totals t ON t.account_no=c.account_no
    LEFT JOIN latest_statement latest ON latest.account_no=c.account_no
    LEFT JOIN current_statement current_cycle ON current_cycle.account_no=c.account_no
    LEFT JOIN oldest_open_statement open_cycle ON open_cycle.account_no=c.account_no
  ${clientFilter}
)
`;
}

const ACCOUNT_SUMMARY_CTES = buildAccountSummaryCtes();
const ACCOUNT_SUMMARY_CTES_BY_ACCOUNT = buildAccountSummaryCtes('account');
const ACCOUNT_SUMMARY_CTES_BY_BRANCH = buildAccountSummaryCtes('branch');

async function loadAccountSummary(db, accountNo) {
  const { rows } = await db.query(
    `WITH ${ACCOUNT_SUMMARY_CTES_BY_ACCOUNT}
     SELECT * FROM account_summary WHERE account_no=$1`,
    [accountNo]
  );
  return rows[0] || null;
}

module.exports = {
  ACCOUNT_SUMMARY_CTES,
  ACCOUNT_SUMMARY_CTES_BY_ACCOUNT,
  ACCOUNT_SUMMARY_CTES_BY_BRANCH,
  buildAccountSummaryCtes,
  loadAccountSummary
};
