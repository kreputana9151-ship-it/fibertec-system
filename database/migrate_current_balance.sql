-- Run once on existing databases to add the live account balance maintained by billing transactions.
ALTER TABLE clients ADD COLUMN IF NOT EXISTS current_balance NUMERIC(10,2) NOT NULL DEFAULT 0;

UPDATE clients c
   SET current_balance = COALESCE(
     (SELECT s.balance
        FROM statements s
       WHERE s.account_no = c.account_no
       ORDER BY s.billing_month DESC
       LIMIT 1), 0);
