BEGIN;

SET LOCAL search_path = public, pg_temp;
LOCK TABLE clients, plans, statements, payments IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
  missing_columns TEXT;
BEGIN
  SELECT string_agg(required.table_name || '.' || required.column_name, ', ')
    INTO missing_columns
    FROM (VALUES
      ('clients', 'account_no'), ('clients', 'plan_id'), ('clients', 'branch_code'),
      ('clients', 'installed_date'), ('clients', 'due_day'), ('clients', 'status'),
      ('clients', 'termination_date'), ('clients', 'termination_reason'),
      ('clients', 'current_balance'), ('plans', 'plan_id'), ('plans', 'monthly_rate'),
      ('branches', 'branch_code'), ('branches', 'short_name'),
      ('statements', 'statement_id'), ('statements', 'invoice_no'),
      ('statements', 'account_no'), ('statements', 'billing_month'),
      ('statements', 'issued_date'), ('statements', 'due_date'),
      ('statements', 'amount'), ('statements', 'amount_paid'),
      ('statements', 'balance'), ('statements', 'payment_status'),
      ('payments', 'payment_id'), ('payments', 'statement_id'),
      ('payments', 'account_no'), ('payments', 'amount'),
      ('payments', 'method'), ('payments', 'payment_type'),
      ('payments', 'status'), ('payments', 'payment_date'),
      ('payments', 'or_no'), ('payments', 'verified_at')
    ) AS required(table_name, column_name)
   WHERE NOT EXISTS (
     SELECT 1
       FROM information_schema.columns column_info
      WHERE column_info.table_schema = 'public'
        AND column_info.table_name = required.table_name
        AND column_info.column_name = required.column_name
   );

  IF missing_columns IS NOT NULL THEN
    RAISE EXCEPTION 'Cannot synchronize subscription history; missing columns: %', missing_columns;
  END IF;

  IF to_regclass('public.account_status_log') IS NULL THEN
    RAISE EXCEPTION 'Cannot synchronize client statuses; account_status_log is missing.';
  END IF;
END $$;

DO $$
BEGIN
  IF (SELECT COUNT(*) FROM clients) < 58 THEN
    RAISE EXCEPTION 'At least 58 clients are required for the requested 2020 cohort.';
  END IF;
END $$;

CREATE TEMP TABLE synchronized_installation_dates ON COMMIT DROP AS
WITH numbered AS (
  SELECT c.account_no,
         ROW_NUMBER() OVER (ORDER BY c.account_no) AS row_num,
         (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Manila')::date AS today,
         GREATEST(
           1,
           (EXTRACT(YEAR FROM (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Manila')::date)::int - 2021) * 12
             + EXTRACT(MONTH FROM (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Manila')::date)::int
         ) AS later_month_count
    FROM clients c
), scheduled AS (
  SELECT n.*,
         CASE WHEN n.row_num > 58
              THEN (DATE '2021-01-01'
                    + make_interval(months => ((n.row_num - 59) % n.later_month_count)::int))::date
              ELSE NULL::date
          END AS later_month
    FROM numbered n
)
SELECT account_no,
       CASE
         WHEN row_num <= 10
           THEN make_date(2020, 1, ((row_num - 1) * 3 + 1)::int)
         WHEN row_num <= 58
           THEN make_date(
             2020,
             (2 + ((row_num - 11) % 11))::int,
             ((row_num * 7 - 1) % 28 + 1)::int
           )
         ELSE make_date(
           EXTRACT(YEAR FROM later_month)::int,
           EXTRACT(MONTH FROM later_month)::int,
           LEAST(
             ((row_num * 7 - 1) % 28 + 1)::int,
             CASE WHEN date_trunc('month', later_month)::date = date_trunc('month', today)::date
                  THEN EXTRACT(DAY FROM today)::int
                  ELSE 28
             END
           )
         )
       END AS installed_date
  FROM scheduled;

UPDATE clients c
   SET installed_date = dates.installed_date,
       due_day = EXTRACT(DAY FROM dates.installed_date)::smallint
  FROM synchronized_installation_dates dates
 WHERE dates.account_no = c.account_no;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'clients'::regclass
       AND conname = 'clients_installed_date_floor'
  ) THEN
    ALTER TABLE clients
      ADD CONSTRAINT clients_installed_date_floor
      CHECK (installed_date >= DATE '2020-01-01');
  END IF;
END $$;

CREATE TEMP TABLE synchronized_cycles ON COMMIT DROP AS
WITH client_schedule AS (
  SELECT c.account_no, c.installed_date, c.due_day, c.status, c.termination_date,
         p.monthly_rate,
         (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Manila')::date AS today,
         CASE WHEN c.status='Terminated'
              THEN LEAST(
                (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Manila')::date,
                COALESCE(c.termination_date, (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Manila')::date)
              )
              ELSE (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Manila')::date
          END AS cycle_end
    FROM clients c
    JOIN plans p USING (plan_id)
), cycle_months AS (
  SELECT schedule.*,
         generated.month_start::date AS billing_month
    FROM client_schedule schedule
    CROSS JOIN LATERAL generate_series(
      date_trunc('month', schedule.installed_date)::date,
      date_trunc('month', schedule.cycle_end)::date,
      INTERVAL '1 month'
    ) AS generated(month_start)
   WHERE schedule.cycle_end >= schedule.installed_date
), dated_cycles AS (
  SELECT cycle_months.*,
         (billing_month
           + LEAST(
               due_day::int,
               EXTRACT(DAY FROM (billing_month + INTERVAL '1 month - 1 day'))::int
             ) - 1)::date AS due_date,
         CASE WHEN billing_month = date_trunc('month', installed_date)::date
              THEN installed_date
              ELSE (
                (billing_month - INTERVAL '1 month')::date
                + LEAST(
                    due_day::int,
                    EXTRACT(DAY FROM (billing_month - INTERVAL '1 day'))::int
                  ) - 1
              )::date
          END AS issued_date
    FROM cycle_months
)
SELECT account_no, monthly_rate, billing_month, issued_date, due_date
  FROM dated_cycles
 WHERE due_date <= cycle_end
   AND issued_date <= cycle_end
   AND due_date <= today
   AND issued_date <= today;

CREATE TEMP TABLE invalid_synchronized_statements ON COMMIT DROP AS
SELECT s.statement_id
  FROM statements s
  JOIN clients c USING (account_no)
  LEFT JOIN synchronized_cycles cycle
    ON cycle.account_no = s.account_no
   AND cycle.billing_month = s.billing_month
 WHERE cycle.account_no IS NULL
    OR s.issued_date < DATE '2020-01-01'
    OR s.due_date < DATE '2020-01-01'
    OR s.issued_date < c.installed_date
    OR s.due_date < c.installed_date
    OR s.issued_date > (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Manila')::date
    OR s.due_date > (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Manila')::date
    OR s.billing_month > date_trunc('month', (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Manila')::date)::date;

DELETE FROM payments p
 USING invalid_synchronized_statements invalid
 WHERE p.statement_id = invalid.statement_id;

UPDATE notices n
   SET statement_id = NULL
  FROM invalid_synchronized_statements invalid
 WHERE n.statement_id = invalid.statement_id;

DELETE FROM statements s
 USING invalid_synchronized_statements invalid
 WHERE s.statement_id = invalid.statement_id;

CREATE TEMP TABLE duplicate_synchronized_statements ON COMMIT DROP AS
WITH ranked AS (
  SELECT s.statement_id,
         FIRST_VALUE(s.statement_id) OVER (
           PARTITION BY s.account_no, s.billing_month
           ORDER BY EXISTS (
             SELECT 1 FROM payments p
              WHERE p.statement_id=s.statement_id AND p.status='Verified'
           ) DESC, s.due_date, s.statement_id
         ) AS keep_statement_id,
         ROW_NUMBER() OVER (
           PARTITION BY s.account_no, s.billing_month
           ORDER BY EXISTS (
             SELECT 1 FROM payments p
              WHERE p.statement_id=s.statement_id AND p.status='Verified'
           ) DESC, s.due_date, s.statement_id
         ) AS row_num
    FROM statements s
)
SELECT statement_id, keep_statement_id
  FROM ranked
 WHERE row_num > 1;

DELETE FROM payments p
 USING duplicate_synchronized_statements duplicate
 JOIN statements kept ON kept.statement_id = duplicate.keep_statement_id
 WHERE p.statement_id = duplicate.statement_id
   AND p.account_no <> kept.account_no;

UPDATE payments p
   SET statement_id = duplicate.keep_statement_id
  FROM duplicate_synchronized_statements duplicate
 WHERE p.statement_id = duplicate.statement_id;

UPDATE notices n
   SET statement_id = duplicate.keep_statement_id
  FROM duplicate_synchronized_statements duplicate
 WHERE n.statement_id = duplicate.statement_id;

DELETE FROM statements s
 USING duplicate_synchronized_statements duplicate
 WHERE s.statement_id = duplicate.statement_id;

DELETE FROM payments p
 USING clients c
 WHERE p.account_no = c.account_no
   AND (p.payment_date < DATE '2020-01-01'
        OR p.payment_date < c.installed_date
        OR p.payment_date > (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Manila')::date);

CREATE SEQUENCE IF NOT EXISTS statement_invoice_seq;
SELECT setval(
  'statement_invoice_seq',
  GREATEST(
    COALESCE(existing.max_number, 0),
    invoice_sequence.last_value,
    1
  ),
  COALESCE(existing.max_number, 0) > 0 OR invoice_sequence.is_called
)
  FROM (
    SELECT MAX(substring(invoice_no FROM '^FT-([0-9]+)$')::BIGINT) AS max_number
        FROM statements
       WHERE invoice_no ~ '^FT-[0-9]+$'
  ) existing
  CROSS JOIN statement_invoice_seq invoice_sequence;

INSERT INTO statements
  (invoice_no, account_no, billing_month, issued_date, due_date, amount, balance)
SELECT 'FT-' || LPAD(nextval('statement_invoice_seq'::regclass)::text, 17, '0'),
       cycle.account_no, cycle.billing_month, cycle.issued_date, cycle.due_date,
       cycle.monthly_rate, cycle.monthly_rate
  FROM synchronized_cycles cycle
ON CONFLICT (account_no, billing_month) DO NOTHING;

UPDATE statements s
   SET issued_date = cycle.issued_date,
       due_date = cycle.due_date,
       amount = cycle.monthly_rate
  FROM synchronized_cycles cycle
 WHERE s.account_no = cycle.account_no
   AND s.billing_month = cycle.billing_month;

UPDATE payments p
   SET status = 'Rejected',
       or_no = NULL,
       verified_at = COALESCE(p.verified_at, CURRENT_TIMESTAMP)
  FROM statements s
 WHERE p.statement_id = s.statement_id
    AND s.due_date <= (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Manila')::date
   AND p.status = 'Pending';

CREATE TEMP TABLE ranked_historical_payments ON COMMIT DROP AS
SELECT p.payment_id, p.statement_id,
       ROW_NUMBER() OVER (
         PARTITION BY p.statement_id
         ORDER BY p.payment_date, p.created_at, p.payment_id
       ) AS row_num
  FROM payments p
  JOIN statements s ON s.statement_id = p.statement_id
 WHERE s.due_date <= (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Manila')::date
   AND p.status = 'Verified';

UPDATE payments p
   SET status = 'Rejected',
       or_no = NULL,
       verified_at = COALESCE(p.verified_at, CURRENT_TIMESTAMP)
  FROM ranked_historical_payments ranked
 WHERE p.payment_id = ranked.payment_id
   AND ranked.row_num > 1;

UPDATE payments p
   SET amount = s.amount,
       payment_type = 'Full payment',
       payment_date = s.due_date
  FROM ranked_historical_payments ranked
  JOIN statements s ON s.statement_id = ranked.statement_id
 WHERE p.payment_id = ranked.payment_id
   AND ranked.row_num = 1;

INSERT INTO payments
  (statement_id, account_no, amount, method, payment_type, status, payment_date)
SELECT s.statement_id, s.account_no,
       s.amount - COALESCE(verified.amount_paid, 0),
       'Cash',
       CASE WHEN COALESCE(verified.amount_paid, 0) = 0 THEN 'Full payment' ELSE 'Partial payment' END,
       'Verified', s.due_date
  FROM statements s
  LEFT JOIN (
    SELECT statement_id, SUM(amount) AS amount_paid
      FROM payments
     WHERE status = 'Verified'
     GROUP BY statement_id
  ) verified USING (statement_id)
 WHERE s.due_date <= (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Manila')::date
   AND COALESCE(verified.amount_paid, 0) < s.amount;

CREATE SEQUENCE IF NOT EXISTS official_receipt_seq;
CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_or_no
  ON payments(or_no) WHERE or_no IS NOT NULL;

SELECT setval(
  'official_receipt_seq',
  GREATEST(
    COALESCE(receipt_sequence.max_number, 0),
    official_receipt_sequence.last_value,
    1
  ),
  COALESCE(receipt_sequence.max_number, 0) > 0 OR official_receipt_sequence.is_called
)
  FROM (
    SELECT MAX(substring(or_no FROM '^OR-[0-9]{4}-([0-9]+)$')::BIGINT) AS max_number
        FROM payments
       WHERE or_no ~ '^OR-[0-9]{4}-[0-9]+$'
  ) receipt_sequence
  CROSS JOIN official_receipt_seq official_receipt_sequence;

DO $$
DECLARE
  payment_row RECORD;
  receipt_number TEXT;
  receipt_year INT;
BEGIN
  FOR payment_row IN
    SELECT payment_id, payment_date
      FROM payments
     WHERE status = 'Verified' AND or_no IS NULL
     ORDER BY payment_date, payment_id
  LOOP
    receipt_year := EXTRACT(YEAR FROM payment_row.payment_date)::int;
    LOOP
      receipt_number := 'OR-' || receipt_year || '-'
                        || LPAD(nextval('official_receipt_seq'::regclass)::text, 6, '0');
      EXIT WHEN NOT EXISTS (SELECT 1 FROM payments WHERE or_no = receipt_number);
    END LOOP;

    UPDATE payments SET or_no = receipt_number WHERE payment_id = payment_row.payment_id;
  END LOOP;
END $$;

UPDATE statements s
   SET amount_paid = COALESCE(verified.amount_paid, 0),
       balance = GREATEST(s.amount - COALESCE(verified.amount_paid, 0), 0),
       payment_status = CASE
         WHEN COALESCE(verified.amount_paid, 0) >= s.amount THEN 'Paid'
         WHEN COALESCE(verified.amount_paid, 0) > 0 THEN 'Partially paid'
         ELSE 'Unpaid'
       END
  FROM (
    SELECT statement_id, SUM(amount) AS amount_paid
      FROM payments
     WHERE status = 'Verified'
     GROUP BY statement_id
  ) verified
 WHERE s.statement_id = verified.statement_id;

UPDATE statements s
   SET amount_paid = 0,
       balance = s.amount,
       payment_status = 'Unpaid'
 WHERE NOT EXISTS (
   SELECT 1 FROM payments p
    WHERE p.statement_id = s.statement_id AND p.status = 'Verified'
 );

UPDATE clients c
   SET current_balance = COALESCE((
     SELECT SUM(GREATEST(s.amount - COALESCE(s.amount_paid, 0), 0))
       FROM statements s
      WHERE s.account_no = c.account_no
        AND s.billing_month <= date_trunc('month', (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Manila')::date)::date
   ), 0);

CREATE TEMP TABLE synchronized_status_targets ON COMMIT DROP AS
WITH account_balances AS (
  SELECT c.account_no, c.status AS old_status, c.status_reason, c.termination_reason,
         COALESCE(SUM(GREATEST(s.amount - COALESCE(s.amount_paid, 0), 0)), 0) AS total_balance,
         COALESCE(SUM(GREATEST(s.amount - COALESCE(s.amount_paid, 0), 0))
                    FILTER (WHERE s.billing_month < date_trunc('month', (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Manila')::date)::date), 0) AS previous_balance,
         COALESCE(SUM(GREATEST(s.amount - COALESCE(s.amount_paid, 0), 0))
                    FILTER (WHERE s.billing_month = date_trunc('month', (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Manila')::date)::date), 0) AS current_month_due,
         MAX(s.due_date) FILTER (
           WHERE s.billing_month = date_trunc('month', (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Manila')::date)::date
         ) AS current_due_date
    FROM clients c
    LEFT JOIN statements s ON s.account_no = c.account_no
      AND s.billing_month <= date_trunc('month', (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Manila')::date)::date
   GROUP BY c.account_no, c.status, c.status_reason, c.termination_reason
)
SELECT balances.*,
       CASE
         WHEN balances.previous_balance > 0 THEN 'Terminated'
         WHEN balances.old_status='Terminated'
          AND LOWER(BTRIM(COALESCE(balances.termination_reason, ''))) NOT IN ('non-payment', 'no admin decision within 3 days')
           THEN 'Terminated'
         WHEN balances.old_status='Terminated' AND balances.total_balance > 0 THEN 'Terminated'
         WHEN balances.total_balance = 0 THEN 'Active'
         WHEN balances.current_month_due > 0 THEN
           CASE
             WHEN balances.current_due_date >= (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Manila')::date THEN 'Active'
             WHEN (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Manila')::date <= balances.current_due_date + 5 THEN 'Grace Period'
             WHEN (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Manila')::date <= balances.current_due_date + 8 THEN 'Under Review'
             ELSE 'Terminated'
           END
         ELSE 'Active'
       END AS new_status
  FROM account_balances balances;

UPDATE clients c
   SET status = target.new_status,
       status_reason = CASE
         WHEN target.new_status = 'Active' THEN NULL
         WHEN target.new_status = 'Grace Period' THEN 'Unpaid after due date'
         WHEN target.new_status = 'Under Review' THEN 'Grace period ended'
         WHEN target.previous_balance > 0 THEN 'Unpaid balance from a previous billing month'
         WHEN target.old_status = 'Terminated' THEN c.status_reason
         ELSE 'Unpaid balance beyond review window'
       END,
       flagged_date = CASE
         WHEN target.new_status = 'Under Review'
           THEN COALESCE(c.flagged_date, target.current_due_date + 6)
         ELSE NULL
       END,
       grace_end_date = CASE
         WHEN target.new_status = 'Grace Period' THEN target.current_due_date + 5
         ELSE NULL
       END,
       termination_date = CASE
         WHEN target.new_status = 'Terminated'
           THEN COALESCE(c.termination_date, (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Manila')::date)
         ELSE NULL
       END,
       termination_reason = CASE
         WHEN target.new_status = 'Terminated'
          AND (target.previous_balance > 0 OR target.old_status <> 'Terminated')
           THEN 'Non-payment'
         WHEN target.new_status = 'Terminated' THEN c.termination_reason
         ELSE NULL
       END
  FROM synchronized_status_targets target
 WHERE c.account_no = target.account_no;

INSERT INTO account_status_log (account_no, old_status, new_status, reason, changed_by)
SELECT account_no, old_status, new_status,
       COALESCE(NULLIF(status_reason, ''), 'Subscription history reconciliation'),
       NULL
  FROM synchronized_status_targets
 WHERE old_status <> new_status;

CREATE INDEX IF NOT EXISTS idx_statements_billing_month_account
  ON statements(billing_month, account_no);
CREATE INDEX IF NOT EXISTS idx_statements_account_payment_status
  ON statements(account_no, payment_status);
CREATE INDEX IF NOT EXISTS idx_payments_status_payment_date
  ON payments(status, payment_date);
CREATE INDEX IF NOT EXISTS idx_payments_account_status
  ON payments(account_no, status);
CREATE INDEX IF NOT EXISTS idx_clients_installed_status_branch_plan
  ON clients(installed_date, status, branch_code, plan_id);
CREATE INDEX IF NOT EXISTS idx_payments_statement_status
  ON payments(statement_id, status);

DO $$
DECLARE
  missing_activity_month DATE;
BEGIN
  SELECT months.month_start::date
    INTO missing_activity_month
    FROM generate_series(
      DATE '2020-01-01',
      date_trunc('month', (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Manila')::date)::date,
      INTERVAL '1 month'
    ) AS months(month_start)
   WHERE NOT EXISTS (
     SELECT 1
       FROM payments p
      WHERE p.status = 'Verified'
        AND date_trunc('month', p.payment_date)::date = months.month_start::date
   )
   ORDER BY months.month_start
   LIMIT 1;

  IF missing_activity_month IS NOT NULL THEN
    RAISE EXCEPTION 'Cannot complete subscription history; no verified payment activity exists for %.',
      TO_CHAR(missing_activity_month, 'YYYY-MM');
  END IF;
END $$;

COMMIT;
