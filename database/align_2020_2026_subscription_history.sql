BEGIN;

SET LOCAL search_path = public, pg_temp;
LOCK TABLE clients, plans, statements, payments IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
  missing_columns TEXT;
BEGIN
  IF to_regclass('public.clients') IS NULL OR to_regclass('public.plans') IS NULL
     OR to_regclass('public.statements') IS NULL OR to_regclass('public.payments') IS NULL THEN
    RAISE EXCEPTION 'Expected clients, plans, statements, and payments tables in public schema.';
  END IF;

  SELECT string_agg(required.table_name || '.' || required.column_name, ', ')
    INTO missing_columns
    FROM (VALUES
      ('clients', 'account_no'), ('clients', 'plan_id'), ('clients', 'branch_code'),
      ('clients', 'registered_date'), ('clients', 'due_day'), ('clients', 'status'),
      ('clients', 'termination_date'), ('plans', 'plan_id'),
      ('plans', 'monthly_rate'), ('branches', 'branch_code'), ('branches', 'short_name'),
      ('statements', 'statement_id'), ('statements', 'invoice_no'),
      ('statements', 'account_no'), ('statements', 'issued_date'),
      ('statements', 'due_date'), ('statements', 'amount'),
      ('statements', 'amount_paid'), ('statements', 'balance'),
      ('statements', 'payment_status'), ('payments', 'payment_id'),
      ('payments', 'statement_id'), ('payments', 'account_no'),
      ('payments', 'amount'), ('payments', 'method'), ('payments', 'status'),
      ('payments', 'payment_date'), ('payments', 'or_no'), ('payments', 'payment_type'),
      ('payments', 'created_at'), ('payments', 'verified_at')
    ) AS required(table_name, column_name)
   WHERE NOT EXISTS (
     SELECT 1 FROM information_schema.columns column_info
      WHERE column_info.table_schema = 'public'
        AND column_info.table_name = required.table_name
        AND column_info.column_name = required.column_name
   );

  IF missing_columns IS NOT NULL THEN
    RAISE EXCEPTION 'Cannot align subscription history; missing columns: %', missing_columns;
  END IF;
END $$;

ALTER TABLE clients ADD COLUMN IF NOT EXISTS installed_date DATE;
ALTER TABLE statements ADD COLUMN IF NOT EXISTS billing_month DATE;
UPDATE statements
   SET billing_month = date_trunc('month', due_date)::date
 WHERE billing_month IS NULL;
ALTER TABLE statements ALTER COLUMN billing_month SET NOT NULL;

DO $$
BEGIN
  IF (SELECT COUNT(*) FROM clients) < 58 THEN
    RAISE EXCEPTION 'At least 58 clients are required to assign the requested 2020 founding cohort.';
  END IF;
END $$;

CREATE TEMP TABLE aligned_installation_dates ON COMMIT DROP AS
WITH numbered AS (
  SELECT account_no,
         ROW_NUMBER() OVER (ORDER BY account_no) AS row_num,
         (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Manila')::date AS today
    FROM clients
), month_span AS (
  SELECT GREATEST(
           1,
           ((EXTRACT(YEAR FROM today)::int - 2021) * 12 + EXTRACT(MONTH FROM today)::int)
         ) AS month_count
    FROM numbered
   LIMIT 1
), scheduled AS (
  SELECT n.account_no, n.row_num, n.today,
         CASE
           WHEN n.row_num <= 58 THEN NULL::date
           ELSE (DATE '2021-01-01'
                 + make_interval(months => ((n.row_num - 59) % span.month_count)::int))::date
         END AS target_month
    FROM numbered n CROSS JOIN month_span span
)
SELECT account_no,
       CASE
         WHEN row_num <= 58 THEN
           make_date(2020, ((row_num - 1) % 12 + 1)::int, ((row_num - 1) % 28 + 1)::int)
         ELSE
           make_date(
             EXTRACT(YEAR FROM target_month)::int,
             EXTRACT(MONTH FROM target_month)::int,
             LEAST(
               ((row_num * 7 - 1) % 28 + 1)::int,
               CASE WHEN target_month = date_trunc('month', today)::date
                    THEN EXTRACT(DAY FROM today)::int ELSE 28 END
             )
           )
       END AS installed_date
  FROM scheduled;

UPDATE clients c
   SET installed_date = dates.installed_date,
       due_day = EXTRACT(DAY FROM dates.installed_date)::smallint
  FROM aligned_installation_dates dates
 WHERE dates.account_no = c.account_no;

ALTER TABLE clients ALTER COLUMN installed_date SET NOT NULL;
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

CREATE TEMP TABLE invalid_history_statements ON COMMIT DROP AS
SELECT s.statement_id
  FROM statements s
  JOIN clients c USING (account_no)
 WHERE s.issued_date < DATE '2020-01-01'
    OR s.due_date < DATE '2020-01-01'
    OR s.issued_date < c.installed_date
    OR s.due_date < c.installed_date
    OR s.billing_month < date_trunc('month', c.installed_date)::date
    OR s.issued_date > (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Manila')::date
    OR s.due_date > (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Manila')::date
    OR s.billing_month > date_trunc('month', (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Manila')::date)::date;

DELETE FROM payments p
 USING clients c
 WHERE p.account_no = c.account_no
   AND (p.payment_date < DATE '2020-01-01'
        OR p.payment_date < c.installed_date
        OR p.payment_date > (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Manila')::date);

DELETE FROM payments p
 USING invalid_history_statements invalid
 WHERE p.statement_id = invalid.statement_id;

UPDATE notices n
   SET statement_id = NULL
  FROM invalid_history_statements invalid
 WHERE n.statement_id = invalid.statement_id;

DELETE FROM statements s
 USING invalid_history_statements invalid
 WHERE s.statement_id = invalid.statement_id;

CREATE TEMP TABLE duplicate_history_statements ON COMMIT DROP AS
WITH ranked AS (
  SELECT s.statement_id,
         FIRST_VALUE(s.statement_id) OVER (
           PARTITION BY s.account_no, s.billing_month
           ORDER BY (EXISTS (
             SELECT 1 FROM payments p
              WHERE p.statement_id = s.statement_id AND p.status = 'Verified'
           )) DESC, s.due_date, s.statement_id
         ) AS keep_statement_id,
         ROW_NUMBER() OVER (
           PARTITION BY s.account_no, s.billing_month
           ORDER BY (EXISTS (
             SELECT 1 FROM payments p
              WHERE p.statement_id = s.statement_id AND p.status = 'Verified'
           )) DESC, s.due_date, s.statement_id
         ) AS row_num
    FROM statements s
)
SELECT statement_id, keep_statement_id
  FROM ranked
 WHERE row_num > 1;

DELETE FROM payments p
 USING duplicate_history_statements duplicate
 JOIN statements kept ON kept.statement_id = duplicate.keep_statement_id
 WHERE p.statement_id = duplicate.statement_id
   AND p.account_no <> kept.account_no;

UPDATE payments p
   SET statement_id = duplicate.keep_statement_id
  FROM duplicate_history_statements duplicate
 WHERE p.statement_id = duplicate.statement_id;

UPDATE notices n
   SET statement_id = duplicate.keep_statement_id
  FROM duplicate_history_statements duplicate
 WHERE n.statement_id = duplicate.statement_id;

DELETE FROM statements s
 USING duplicate_history_statements duplicate
 WHERE s.statement_id = duplicate.statement_id;

DO $$
DECLARE
  account_attnum SMALLINT;
  month_attnum SMALLINT;
BEGIN
  SELECT attnum INTO account_attnum FROM pg_attribute
   WHERE attrelid = 'statements'::regclass AND attname = 'account_no' AND NOT attisdropped;
  SELECT attnum INTO month_attnum FROM pg_attribute
   WHERE attrelid = 'statements'::regclass AND attname = 'billing_month' AND NOT attisdropped;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'statements'::regclass AND contype = 'u'
       AND cardinality(conkey) = 2
       AND conkey @> ARRAY[account_attnum, month_attnum]::SMALLINT[]
  ) THEN
    ALTER TABLE statements
      ADD CONSTRAINT statements_account_no_billing_month_key
      UNIQUE (account_no, billing_month);
  END IF;
END $$;

CREATE TEMP TABLE aligned_monthly_cycles ON COMMIT DROP AS
WITH clients_to_bill AS (
  SELECT c.account_no, c.installed_date, c.due_day, c.status, c.termination_date,
         p.monthly_rate,
         b.short_name,
         CASE WHEN c.status = 'Terminated'
              THEN LEAST(
                (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Manila')::date,
                COALESCE(c.termination_date, (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Manila')::date)
              )
              ELSE (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Manila')::date
          END AS cycle_end_date
    FROM clients c
    JOIN plans p USING (plan_id)
    JOIN branches b USING (branch_code)
), month_ranges AS (
  SELECT clients_to_bill.*,
         ((EXTRACT(YEAR FROM cycle_end_date)::int * 12
           + EXTRACT(MONTH FROM cycle_end_date)::int)
          - (EXTRACT(YEAR FROM clients_to_bill.installed_date)::int * 12
             + EXTRACT(MONTH FROM clients_to_bill.installed_date)::int))::int AS cycle_count
    FROM clients_to_bill
), raw_cycles AS (
  SELECT c.*,
         n.cycle_num,
         (date_trunc('month', c.installed_date)::date
           + make_interval(months => n.cycle_num))::date AS cycle_month
    FROM month_ranges c
    CROSS JOIN LATERAL generate_series(1, c.cycle_count) AS n(cycle_num)
), due_cycles AS (
  SELECT raw_cycles.*,
         (cycle_month
           + LEAST(
               due_day::int,
               EXTRACT(DAY FROM (cycle_month + INTERVAL '1 month - 1 day'))::int
             ) - 1)::date AS due_date
    FROM raw_cycles
), dated_cycles AS (
  SELECT due_cycles.*,
         CASE
           WHEN cycle_num = 1 THEN installed_date
           ELSE (
             (cycle_month - INTERVAL '1 month')::date
             + LEAST(
                 due_day::int,
                 EXTRACT(DAY FROM (cycle_month - INTERVAL '1 day'))::int
               ) - 1
           )::date
         END AS issued_date
    FROM due_cycles
)
SELECT account_no, short_name, monthly_rate,
       cycle_month AS billing_month, issued_date, due_date,
       short_name || ' - ' || TO_CHAR(due_date, 'YYMM') || ' - ' || RIGHT(account_no, 4) AS invoice_no,
       ROW_NUMBER() OVER (PARTITION BY account_no ORDER BY due_date DESC) AS reverse_cycle_num
  FROM dated_cycles
 WHERE due_date <= cycle_end_date
   AND issued_date <= cycle_end_date;

CREATE TEMP TABLE statements_outside_aligned_cycles ON COMMIT DROP AS
SELECT s.statement_id
  FROM statements s
  LEFT JOIN aligned_monthly_cycles cycles
    ON cycles.account_no = s.account_no AND cycles.billing_month = s.billing_month
 WHERE cycles.account_no IS NULL;

DELETE FROM payments p
 USING statements_outside_aligned_cycles invalid
 WHERE p.statement_id = invalid.statement_id;

UPDATE notices n
   SET statement_id = NULL
  FROM statements_outside_aligned_cycles invalid
 WHERE n.statement_id = invalid.statement_id;

DELETE FROM statements s
 USING statements_outside_aligned_cycles invalid
 WHERE s.statement_id = invalid.statement_id;

UPDATE statements
   SET invoice_no = 'TMP-' || statement_id::text;

INSERT INTO statements (invoice_no, account_no, billing_month, issued_date, due_date, amount, balance)
SELECT invoice_no, account_no, billing_month, issued_date, due_date, monthly_rate, monthly_rate
  FROM aligned_monthly_cycles
ON CONFLICT (account_no, billing_month) DO NOTHING;

UPDATE statements s
   SET invoice_no = cycles.invoice_no,
       issued_date = cycles.issued_date,
       due_date = cycles.due_date,
       amount = cycles.monthly_rate
  FROM aligned_monthly_cycles cycles
 WHERE s.account_no = cycles.account_no
   AND s.billing_month = cycles.billing_month;

UPDATE payments p
   SET status = 'Rejected',
       verified_at = COALESCE(p.verified_at, CURRENT_TIMESTAMP),
       or_no = NULL
  FROM aligned_monthly_cycles cycles
  JOIN statements s
    ON s.account_no = cycles.account_no AND s.billing_month = cycles.billing_month
 WHERE p.statement_id = s.statement_id
   AND cycles.reverse_cycle_num > 1
   AND p.status = 'Pending';

CREATE TEMP TABLE ranked_historical_payments ON COMMIT DROP AS
WITH ranked AS (
  SELECT p.payment_id, p.statement_id,
         ROW_NUMBER() OVER (
           PARTITION BY p.statement_id ORDER BY p.payment_date, p.created_at, p.payment_id
         ) AS row_num
    FROM payments p
    JOIN statements s ON s.statement_id = p.statement_id
    JOIN aligned_monthly_cycles cycles
      ON cycles.account_no = s.account_no AND cycles.billing_month = s.billing_month
   WHERE cycles.reverse_cycle_num > 1 AND p.status = 'Verified'
)
SELECT payment_id, statement_id, row_num FROM ranked;

UPDATE payments p
   SET status = 'Rejected',
       verified_at = COALESCE(p.verified_at, CURRENT_TIMESTAMP),
       or_no = NULL
  FROM ranked_historical_payments ranked
 WHERE p.payment_id = ranked.payment_id AND ranked.row_num > 1;

UPDATE payments p
   SET amount = cycles.monthly_rate,
       payment_type = 'Full payment',
       payment_date = cycles.due_date
  FROM ranked_historical_payments ranked
  JOIN statements s ON s.statement_id = ranked.statement_id
  JOIN aligned_monthly_cycles cycles
    ON cycles.account_no = s.account_no AND cycles.billing_month = s.billing_month
 WHERE p.payment_id = ranked.payment_id AND ranked.row_num = 1;

INSERT INTO payments (statement_id, account_no, amount, method, payment_type, status, payment_date)
SELECT s.statement_id, cycles.account_no, cycles.monthly_rate, 'Cash', 'Full payment',
       'Verified', cycles.due_date
  FROM aligned_monthly_cycles cycles
  JOIN statements s
    ON s.account_no = cycles.account_no AND s.billing_month = cycles.billing_month
 WHERE cycles.reverse_cycle_num > 1
   AND NOT EXISTS (
     SELECT 1 FROM payments p
      WHERE p.statement_id = s.statement_id AND p.status = 'Verified'
   );

WITH duplicate_receipts AS (
  SELECT payment_id,
         ROW_NUMBER() OVER (
           PARTITION BY or_no
           ORDER BY CASE status WHEN 'Verified' THEN 0 ELSE 1 END, payment_id
         ) AS row_num
    FROM payments
   WHERE or_no IS NOT NULL
)
UPDATE payments p
   SET or_no = NULL
  FROM duplicate_receipts duplicate
 WHERE p.payment_id = duplicate.payment_id AND duplicate.row_num > 1;

CREATE SEQUENCE IF NOT EXISTS official_receipt_seq;
SELECT setval(
  'official_receipt_seq',
  GREATEST(
    COALESCE((
      SELECT MAX(substring(or_no FROM '^OR-[0-9]{4}-([0-9]+)$')::BIGINT)
        FROM payments
       WHERE or_no ~ '^OR-[0-9]{4}-[0-9]+$'
    ), 0),
    (SELECT last_value FROM official_receipt_seq),
    1
  ),
  TRUE
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_or_no
  ON payments(or_no) WHERE or_no IS NOT NULL;

DO $$
DECLARE
  payment_row RECORD;
  next_sequence BIGINT;
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
      next_sequence := nextval('official_receipt_seq'::regclass);
      receipt_number := 'OR-' || receipt_year || '-' || LPAD(next_sequence::text, 6, '0');
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

DO $$
DECLARE
  balance_column TEXT;
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'clients' AND column_name = 'current_balance'
  ) THEN
    balance_column := 'current_balance';
  ELSIF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'clients' AND column_name = 'outstanding_balance'
  ) THEN
    balance_column := 'outstanding_balance';
  ELSE
    RAISE EXCEPTION 'clients requires current_balance or outstanding_balance for reconciliation.';
  END IF;

  EXECUTE format(
    'UPDATE clients c SET %I = COALESCE((
       SELECT SUM(GREATEST(s.amount - s.amount_paid, 0))
         FROM statements s WHERE s.account_no = c.account_no
     ), 0)',
    balance_column
  );

  IF balance_column <> 'current_balance' AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'clients' AND column_name = 'current_balance'
  ) THEN
    UPDATE clients c
       SET current_balance = COALESCE((
         SELECT SUM(GREATEST(s.amount - s.amount_paid, 0))
           FROM statements s WHERE s.account_no = c.account_no
       ), 0);
  END IF;
  IF balance_column <> 'outstanding_balance' AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'clients' AND column_name = 'outstanding_balance'
  ) THEN
    UPDATE clients c
       SET outstanding_balance = COALESCE((
         SELECT SUM(GREATEST(s.amount - s.amount_paid, 0))
           FROM statements s WHERE s.account_no = c.account_no
       ), 0);
  END IF;
END $$;

CREATE OR REPLACE VIEW v_client_payments AS
  SELECT * FROM payments;

CREATE OR REPLACE VIEW v_client_statements AS
  SELECT * FROM statements;

CREATE OR REPLACE FUNCTION purge_old_records() RETURNS void AS $$
DECLARE
  cutoff DATE := (date_trunc('month', (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Manila')::date) - interval '6 months')::date;
BEGIN
  DELETE FROM notices WHERE notice_date < cutoff;
END;
$$ LANGUAGE plpgsql;

COMMIT;
