BEGIN;

LOCK TABLE clients, plans, statements, payments, notices IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
  manila_today DATE := (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Manila')::date;
BEGIN
  IF EXISTS (
    SELECT 1
      FROM statements s
      JOIN payments p USING (statement_id)
     WHERE s.due_date > manila_today + 7
        OR s.issued_date > manila_today + 7
  ) THEN
    RAISE EXCEPTION
      'Cannot remove advance statements that have payments; reconcile those payment records first.';
  END IF;

  UPDATE notices n
     SET statement_id = NULL
    FROM statements s
   WHERE n.statement_id = s.statement_id
     AND (s.due_date > manila_today + 7 OR s.issued_date > manila_today + 7);

  DELETE FROM statements
   WHERE due_date > manila_today + 7
      OR issued_date > manila_today + 7;
END $$;

DO $$
DECLARE
  unique_constraint RECORD;
  account_attnum SMALLINT;
  month_attnum SMALLINT;
BEGIN
  SELECT attnum INTO account_attnum
    FROM pg_attribute
   WHERE attrelid = 'statements'::regclass AND attname = 'account_no';
  SELECT attnum INTO month_attnum
    FROM pg_attribute
   WHERE attrelid = 'statements'::regclass AND attname = 'billing_month';

  FOR unique_constraint IN
    SELECT conname
      FROM pg_constraint
     WHERE conrelid = 'statements'::regclass
       AND contype = 'u'
       AND cardinality(conkey) = 2
       AND conkey @> ARRAY[account_attnum, month_attnum]::SMALLINT[]
  LOOP
    EXECUTE format('ALTER TABLE statements DROP CONSTRAINT %I', unique_constraint.conname);
  END LOOP;
END $$;

UPDATE statements
   SET billing_month = date_trunc('month', due_date)::date;

CREATE TEMP TABLE statement_dedup_map ON COMMIT DROP AS
WITH ranked AS (
  SELECT statement_id,
         FIRST_VALUE(statement_id) OVER (
           PARTITION BY account_no, date_trunc('month', due_date)
           ORDER BY (issued_date <= (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Manila')::date) DESC,
                    due_date ASC,
                    statement_id ASC
         ) AS keep_statement_id,
         ROW_NUMBER() OVER (
           PARTITION BY account_no, date_trunc('month', due_date)
           ORDER BY (issued_date <= (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Manila')::date) DESC,
                    due_date ASC,
                    statement_id ASC
         ) AS row_num
    FROM statements
)
SELECT statement_id, keep_statement_id
  FROM ranked
 WHERE row_num > 1;

UPDATE payments p
   SET statement_id = duplicate.keep_statement_id
  FROM statement_dedup_map duplicate
 WHERE p.statement_id = duplicate.statement_id;

UPDATE notices n
   SET statement_id = duplicate.keep_statement_id
  FROM statement_dedup_map duplicate
 WHERE n.statement_id = duplicate.statement_id;

DELETE FROM statements s
 USING statement_dedup_map duplicate
 WHERE s.statement_id = duplicate.statement_id;

WITH verified_payments AS (
  SELECT statement_id, SUM(amount) AS amount_paid
    FROM payments
   WHERE status = 'Verified'
   GROUP BY statement_id
), corrected_statements AS (
  SELECT s.statement_id, p.monthly_rate, COALESCE(v.amount_paid, 0) AS amount_paid
    FROM statements s
    JOIN clients c ON c.account_no = s.account_no
    JOIN plans p ON p.plan_id = c.plan_id
    LEFT JOIN verified_payments v ON v.statement_id = s.statement_id
)
UPDATE statements s
   SET amount = corrected.monthly_rate,
       amount_paid = LEAST(corrected.monthly_rate, corrected.amount_paid),
       balance = GREATEST(corrected.monthly_rate - corrected.amount_paid, 0),
       payment_status = CASE
         WHEN corrected.amount_paid >= corrected.monthly_rate THEN 'Paid'
         WHEN corrected.amount_paid > 0 THEN 'Partially paid'
         ELSE 'Unpaid'
       END
  FROM corrected_statements corrected
 WHERE s.statement_id = corrected.statement_id;

UPDATE clients c
   SET current_balance = COALESCE((
     SELECT SUM(GREATEST(s.amount - s.amount_paid, 0))
       FROM statements s
      WHERE s.account_no = c.account_no
   ), 0);

ALTER TABLE statements
  ADD CONSTRAINT statements_account_no_billing_month_key UNIQUE (account_no, billing_month);

COMMIT;
