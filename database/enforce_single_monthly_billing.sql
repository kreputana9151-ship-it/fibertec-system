BEGIN;

LOCK TABLE clients, plans, statements, payments, notices IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE IF NOT EXISTS statement_cleanup_payment_archive AS
SELECT p.*, CURRENT_TIMESTAMP AS archived_at, NULL::text AS archive_reason
  FROM payments p
 WHERE FALSE;

CREATE TEMP TABLE advance_statement_reassignment_map ON COMMIT DROP AS
SELECT advance.statement_id,
       current_cycle.statement_id AS keep_statement_id
  FROM statements advance
  LEFT JOIN LATERAL (
    SELECT current_cycle.statement_id
      FROM statements current_cycle
     WHERE current_cycle.account_no = advance.account_no
       AND current_cycle.statement_id <> advance.statement_id
       AND current_cycle.due_date <= (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Manila')::date + 7
       AND current_cycle.issued_date <= (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Manila')::date + 7
       AND (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Manila')::date >= current_cycle.due_date - 7
     ORDER BY ABS(current_cycle.due_date - (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Manila')::date),
              current_cycle.due_date DESC,
              current_cycle.statement_id
     LIMIT 1
  ) current_cycle ON TRUE
 WHERE advance.due_date > (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Manila')::date + 7
    OR advance.issued_date > (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Manila')::date + 7;

CREATE TEMP TABLE advance_payment_reassignment_map ON COMMIT DROP AS
SELECT p.payment_id,
       CASE WHEN p.account_no = advance.account_no
            THEN reassignment.keep_statement_id
            ELSE NULL
       END AS keep_statement_id
  FROM payments p
  JOIN advance_statement_reassignment_map reassignment
    ON reassignment.statement_id = p.statement_id
  JOIN statements advance ON advance.statement_id = reassignment.statement_id;

INSERT INTO statement_cleanup_payment_archive
SELECT p.*, CURRENT_TIMESTAMP, 'No valid current-cycle statement exists for reassignment'
  FROM payments p
  JOIN advance_payment_reassignment_map reassignment USING (payment_id)
 WHERE reassignment.keep_statement_id IS NULL;

DELETE FROM payments p
 USING advance_payment_reassignment_map reassignment
 WHERE p.payment_id = reassignment.payment_id
   AND reassignment.keep_statement_id IS NULL;

UPDATE payments p
   SET statement_id = reassignment.keep_statement_id
  FROM advance_payment_reassignment_map reassignment
 WHERE p.payment_id = reassignment.payment_id
   AND reassignment.keep_statement_id IS NOT NULL;

UPDATE notices n
   SET statement_id = NULL
  FROM advance_statement_reassignment_map reassignment
 WHERE n.statement_id = reassignment.statement_id;

DELETE FROM statements s
 USING advance_statement_reassignment_map reassignment
 WHERE s.statement_id = reassignment.statement_id;

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

INSERT INTO statement_cleanup_payment_archive
SELECT p.*, CURRENT_TIMESTAMP, 'Payment account does not match the kept statement account'
  FROM payments p
  JOIN statement_dedup_map duplicate ON duplicate.statement_id = p.statement_id
  JOIN statements kept ON kept.statement_id = duplicate.keep_statement_id
 WHERE p.account_no <> kept.account_no;

DELETE FROM payments p
 USING statement_dedup_map duplicate, statements kept
 WHERE p.statement_id = duplicate.statement_id
   AND kept.statement_id = duplicate.keep_statement_id
   AND p.account_no <> kept.account_no;

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
       amount_paid = corrected.amount_paid,
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
