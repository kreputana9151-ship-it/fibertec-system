-- Run once on existing databases to add the live account balance maintained by billing transactions.
ALTER TABLE clients ADD COLUMN IF NOT EXISTS current_balance NUMERIC(10,2) NOT NULL DEFAULT 0;

UPDATE clients c
   SET current_balance = COALESCE((
     SELECT SUM(GREATEST(s.amount - COALESCE(v.verified_paid, 0), 0))
       FROM statements s
       LEFT JOIN LATERAL (
         SELECT COALESCE(SUM(p.amount), 0) AS verified_paid
           FROM payments p
          WHERE p.statement_id=s.statement_id AND p.status='Verified'
       ) v ON TRUE
      WHERE s.account_no = c.account_no
   ), 0);
