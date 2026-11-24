-- Backfill review metadata for clients whose review fields were never recorded.
WITH review_clients AS (
  SELECT c.account_no,
         CASE
           WHEN COALESCE(latest.balance, c.current_balance, 0) > 0 THEN 'Grace period ended'
           ELSE 'Flagged for account review'
         END AS fallback_reason,
         overdue.due_date AS fallback_flagged_date
    FROM clients c
    LEFT JOIN LATERAL (
      SELECT GREATEST(s.amount - COALESCE(paid.verified_paid, 0), 0) AS balance
        FROM statements s
        LEFT JOIN LATERAL (
          SELECT COALESCE(SUM(pm.amount) FILTER (WHERE pm.status = 'Verified'), 0) AS verified_paid
            FROM payments pm
           WHERE pm.statement_id = s.statement_id
        ) paid ON TRUE
       WHERE s.account_no = c.account_no
       ORDER BY s.billing_month DESC
       LIMIT 1
    ) latest ON TRUE
    LEFT JOIN LATERAL (
      SELECT s.due_date
        FROM statements s
        LEFT JOIN LATERAL (
          SELECT COALESCE(SUM(pm.amount) FILTER (WHERE pm.status = 'Verified'), 0) AS verified_paid
            FROM payments pm
           WHERE pm.statement_id = s.statement_id
        ) paid ON TRUE
       WHERE s.account_no = c.account_no
         AND s.due_date <= (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Manila')::date
         AND GREATEST(s.amount - COALESCE(paid.verified_paid, 0), 0) > 0
       ORDER BY s.due_date DESC, s.billing_month DESC
       LIMIT 1
    ) overdue ON TRUE
   WHERE c.status = 'Under Review'
)
UPDATE clients c
   SET status_reason = COALESCE(NULLIF(BTRIM(c.status_reason), ''), rc.fallback_reason),
       flagged_date = COALESCE(
         c.flagged_date,
         rc.fallback_flagged_date,
         (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Manila')::date
       )
  FROM review_clients rc
 WHERE c.account_no = rc.account_no
   AND (NULLIF(BTRIM(c.status_reason), '') IS NULL OR c.flagged_date IS NULL);
