-- Rebuilds statement/payment history while preserving client/account identifiers and notice rows.
-- Existing notice statement links are cleared because statement IDs are regenerated.
-- Run against the intended database; all existing statements and payment rows are replaced.
BEGIN;

SET LOCAL search_path = public, pg_temp;
LOCK TABLE branches, clients, plans, statements, payments, notices
  IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
  missing_columns TEXT;
  today DATE := (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Manila')::date;
BEGIN
  SELECT string_agg(required.table_name || '.' || required.column_name, ', ')
    INTO missing_columns
    FROM (VALUES
      ('branches', 'branch_code'), ('branches', 'short_name'),
      ('clients', 'account_no'), ('clients', 'branch_code'), ('clients', 'plan_id'),
      ('clients', 'installed_date'), ('clients', 'due_day'), ('clients', 'status'),
      ('clients', 'termination_date'), ('clients', 'termination_reason'),
      ('clients', 'current_balance'),
      ('plans', 'plan_id'), ('plans', 'monthly_rate'),
      ('statements', 'statement_id'), ('statements', 'invoice_no'),
      ('statements', 'account_no'), ('statements', 'billing_month'),
      ('statements', 'issued_date'), ('statements', 'due_date'),
      ('statements', 'amount'), ('statements', 'amount_paid'),
      ('statements', 'balance'), ('statements', 'payment_status'),
      ('statements', 'send_status'),
      ('payments', 'statement_id'), ('payments', 'account_no'), ('payments', 'amount'),
      ('payments', 'method'), ('payments', 'payment_type'), ('payments', 'status'),
      ('payments', 'payment_date'), ('payments', 'or_no'),
      ('payments', 'verified_at'),
      ('notices', 'notice_id'), ('notices', 'statement_id')
    ) AS required(table_name, column_name)
   WHERE NOT EXISTS (
     SELECT 1
       FROM information_schema.columns column_info
      WHERE column_info.table_schema = 'public'
        AND column_info.table_name = required.table_name
        AND column_info.column_name = required.column_name
   );

  IF missing_columns IS NOT NULL THEN
    RAISE EXCEPTION 'Cannot rebuild subscription history; missing columns: %', missing_columns;
  END IF;
  IF (SELECT COUNT(*) FROM clients) < 58 THEN
    RAISE EXCEPTION 'At least 58 clients are required for the 2024 cohort.';
  END IF;
  IF today < DATE '2025-01-01' THEN
    RAISE EXCEPTION 'The 2025-2026 cohort cannot be assigned without future installation dates.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM clients c
    LEFT JOIN plans p USING (plan_id)
    LEFT JOIN branches b USING (branch_code)
    WHERE p.plan_id IS NULL OR b.branch_code IS NULL
  ) THEN
    RAISE EXCEPTION 'Every client must have a valid plan and branch before rebuilding history.';
  END IF;
END $$;

CREATE TEMP TABLE revised_installations ON COMMIT DROP AS
WITH clock AS (
  SELECT (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Manila')::date AS today,
         ((EXTRACT(YEAR FROM (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Manila')::date)::int - 2025) * 12
           + EXTRACT(MONTH FROM (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Manila')::date)::int) AS later_month_count
),
branch_ranks AS (
  SELECT c.account_no, c.branch_code,
         ROW_NUMBER() OVER (PARTITION BY c.branch_code ORDER BY c.account_no) AS branch_rank
    FROM clients c
),
ordered_clients AS (
  SELECT account_no, branch_code,
         ROW_NUMBER() OVER (ORDER BY branch_rank, branch_code, account_no) AS cohort_rank
    FROM branch_ranks
),
cohort_dates AS (
  SELECT account_no, cohort_rank,
         CASE
           WHEN cohort_rank <= 10
             THEN make_date(2024, 1, (1 + ((cohort_rank * 3) % 28))::int)
           ELSE make_date(
             2024,
             (2 + ((cohort_rank - 11) % 11))::int,
             (1 + ((cohort_rank * 7) % 28))::int
           )
         END AS installed_date
    FROM ordered_clients
   WHERE cohort_rank <= 58
),
later_dates AS (
  SELECT ordered.account_no,
         (DATE '2025-01-01'
           + make_interval(months => ((ordered.cohort_rank - 59) % clock.later_month_count)::int))::date
           + LEAST(
               ((ordered.cohort_rank * 7 - 1) % 28 + 1)::int,
               CASE
                 WHEN (DATE '2025-01-01'
                        + make_interval(months => ((ordered.cohort_rank - 59) % clock.later_month_count)::int))::date
                      = date_trunc('month', clock.today)::date
                   THEN EXTRACT(DAY FROM clock.today)::int
                 ELSE 28
               END
             ) - 1 AS installed_date
    FROM ordered_clients ordered
    CROSS JOIN clock
   WHERE ordered.cohort_rank > 58
)
SELECT c.account_no, c.branch_code, c.cohort_rank, dates.installed_date,
       (original_client.status = 'Terminated'
         AND LOWER(BTRIM(COALESCE(original_client.termination_reason, '')))
             NOT IN ('non-payment', 'no admin decision within 3 days')) AS preserve_termination,
       original_client.termination_date AS original_termination_date,
       original_client.termination_reason AS original_termination_reason
  FROM ordered_clients c
  JOIN (
    SELECT account_no, installed_date FROM cohort_dates
    UNION ALL
    SELECT account_no, installed_date FROM later_dates
  ) dates USING (account_no)
  JOIN clients original_client USING (account_no);

DO $$
DECLARE
  jan_count INTEGER;
  cohort_count INTEGER;
  branch_count_difference BIGINT;
  today DATE := (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Manila')::date;
BEGIN
  SELECT COUNT(*) INTO cohort_count
    FROM revised_installations
   WHERE cohort_rank <= 58;
  SELECT COUNT(*) INTO jan_count
    FROM revised_installations
   WHERE cohort_rank <= 58
     AND installed_date >= DATE '2024-01-01'
     AND installed_date < DATE '2024-02-01';
  IF cohort_count <> 58 OR jan_count <> 10 THEN
    RAISE EXCEPTION 'The cohort schedule must contain 58 clients, including 10 January 2024 starters.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM revised_installations
     WHERE installed_date < DATE '2024-01-01' OR installed_date > today
  ) THEN
    RAISE EXCEPTION 'The installation schedule contains a date outside 2024 through Manila today.';
  END IF;

  SELECT MAX(branch_clients) - MIN(branch_clients)
    INTO branch_count_difference
    FROM (
      SELECT branch_code, COUNT(*) AS branch_clients
        FROM revised_installations
       WHERE cohort_rank <= 58
       GROUP BY branch_code
    ) branch_cohort;
  IF branch_count_difference > 1 THEN
    RAISE EXCEPTION 'The 2024 cohort is not evenly distributed across populated branches.';
  END IF;
END $$;

CREATE TEMP TABLE affected_terminations ON COMMIT DROP AS
SELECT account_no, installed_date, preserve_termination,
       CASE
         WHEN preserve_termination
           THEN GREATEST(installed_date, LEAST(COALESCE(original_termination_date,
                 (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Manila')::date),
                 (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Manila')::date))
         ELSE NULL
       END AS termination_date,
       CASE WHEN preserve_termination THEN original_termination_reason ELSE NULL END AS termination_reason
  FROM revised_installations;

UPDATE clients c
   SET installed_date = target.installed_date,
       due_day = EXTRACT(DAY FROM target.installed_date)::smallint,
       status = CASE WHEN target.preserve_termination THEN 'Terminated' ELSE 'Active' END,
       status_reason = CASE WHEN target.preserve_termination THEN c.status_reason ELSE NULL END,
       flagged_date = NULL,
       grace_end_date = NULL,
       termination_date = target.termination_date,
       termination_reason = target.termination_reason,
       current_balance = 0
  FROM affected_terminations target
 WHERE c.account_no = target.account_no;

UPDATE notices SET statement_id = NULL WHERE statement_id IS NOT NULL;
DELETE FROM payments;
DELETE FROM statements;

CREATE SEQUENCE IF NOT EXISTS statement_invoice_seq;
CREATE SEQUENCE IF NOT EXISTS official_receipt_seq;
CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_or_no
  ON payments(or_no) WHERE or_no IS NOT NULL;

CREATE TEMP TABLE rebuilt_cycles ON COMMIT DROP AS
WITH clock AS (
  SELECT (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Manila')::date AS today,
         date_trunc('month', (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Manila')::date)::date AS current_month
),
client_schedule AS (
  SELECT c.account_no, c.installed_date, c.due_day, c.termination_date,
         p.monthly_rate,
         LEAST(COALESCE(c.termination_date, clock.today + 7), clock.today + 7) AS cycle_end,
         clock.today, clock.current_month
    FROM clients c
    JOIN plans p USING (plan_id)
    CROSS JOIN clock
),
cycle_months AS (
  SELECT schedule.*,
         generated.month_start::date AS billing_month
    FROM client_schedule schedule
    CROSS JOIN LATERAL generate_series(
      date_trunc('month', schedule.installed_date)::date,
      date_trunc('month', schedule.cycle_end)::date,
      INTERVAL '1 month'
    ) AS generated(month_start)
   WHERE schedule.cycle_end >= schedule.installed_date
),
dated_cycles AS (
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
   AND issued_date <= today
   AND today >= due_date - INTERVAL '7 days'
   AND due_date <= today + INTERVAL '7 days';

INSERT INTO statements
  (invoice_no, account_no, billing_month, issued_date, due_date, amount, balance)
SELECT 'FT-' || nextval('statement_invoice_seq')::text,
       cycles.account_no, cycles.billing_month, cycles.issued_date, cycles.due_date,
       cycles.monthly_rate, cycles.monthly_rate
  FROM rebuilt_cycles cycles
 ORDER BY cycles.account_no, cycles.billing_month
ON CONFLICT (account_no, billing_month) DO NOTHING;

INSERT INTO payments
  (statement_id, account_no, amount, method, payment_type, or_no, status, payment_date, verified_at)
SELECT s.statement_id, s.account_no, s.amount, 'Cash', 'Full payment',
       'OR-' || EXTRACT(YEAR FROM s.due_date)::int || '-'
         || LPAD(nextval('official_receipt_seq'::regclass)::text, 6, '0'),
       'Verified', s.due_date,
       (s.due_date::timestamp + TIME '12:00') AT TIME ZONE 'Asia/Manila'
  FROM statements s
 WHERE s.billing_month < date_trunc(
         'month', (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Manila')::date
       )::date
 ORDER BY s.account_no, s.billing_month;

UPDATE statements s
   SET amount = p.monthly_rate,
       amount_paid = COALESCE((
         SELECT SUM(payment.amount)
           FROM payments payment
          WHERE payment.statement_id=s.statement_id
            AND payment.status='Verified'
       ), 0),
       balance = GREATEST(p.monthly_rate - COALESCE((
         SELECT SUM(payment.amount)
           FROM payments payment
          WHERE payment.statement_id=s.statement_id
            AND payment.status='Verified'
       ), 0), 0),
       payment_status = CASE
         WHEN COALESCE((
           SELECT SUM(payment.amount)
             FROM payments payment
            WHERE payment.statement_id=s.statement_id
              AND payment.status='Verified'
         ), 0) >= p.monthly_rate THEN 'Paid'
         WHEN COALESCE((
           SELECT SUM(payment.amount)
             FROM payments payment
            WHERE payment.statement_id=s.statement_id
              AND payment.status='Verified'
         ), 0) > 0 THEN 'Partially paid'
         ELSE 'Unpaid'
       END,
       send_status = CASE
         WHEN s.billing_month < date_trunc(
                'month', (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Manila')::date
              )::date
           THEN 'Delivered'
         ELSE 'Not Yet Sent'
       END
  FROM clients c
  JOIN plans p USING (plan_id)
 WHERE c.account_no=s.account_no;

WITH clock AS (
  SELECT date_trunc('month', (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Manila')::date)::date AS current_month,
         (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Manila')::date AS today
),
balances AS (
  SELECT s.account_no,
         SUM(GREATEST(s.amount - COALESCE(s.amount_paid, 0), 0)) AS total_balance,
         COALESCE(SUM(GREATEST(s.amount - COALESCE(s.amount_paid, 0), 0))
           FILTER (WHERE s.billing_month < clock.current_month), 0) AS previous_balance,
         COALESCE(SUM(GREATEST(s.amount - COALESCE(s.amount_paid, 0), 0))
           FILTER (WHERE s.billing_month = clock.current_month), 0) AS current_balance,
         MAX(s.due_date) FILTER (WHERE s.billing_month = clock.current_month) AS current_due_date
    FROM statements s
    CROSS JOIN clock
   WHERE s.billing_month <= clock.current_month
   GROUP BY s.account_no
)
UPDATE clients c
   SET current_balance = COALESCE(balances.total_balance, 0),
       status = CASE
         WHEN target.preserve_termination THEN 'Terminated'
         WHEN COALESCE(balances.previous_balance, 0) > 0 THEN 'Terminated'
         WHEN COALESCE(balances.total_balance, 0) = 0 THEN 'Active'
         WHEN balances.current_due_date IS NULL OR clock.today <= balances.current_due_date THEN 'Active'
         WHEN clock.today <= balances.current_due_date + 5 THEN 'Grace Period'
         WHEN clock.today <= balances.current_due_date + 8 THEN 'Under Review'
         ELSE 'Terminated'
       END,
       status_reason = CASE
         WHEN target.preserve_termination THEN c.status_reason
         WHEN COALESCE(balances.previous_balance, 0) > 0 THEN 'Previous billing month arrears'
         WHEN COALESCE(balances.total_balance, 0) = 0 THEN NULL
         WHEN balances.current_due_date IS NOT NULL
          AND clock.today > balances.current_due_date + 8 THEN 'Unpaid subscription'
         WHEN balances.current_due_date IS NOT NULL
          AND clock.today > balances.current_due_date + 5 THEN 'Grace period ended'
         ELSE NULL
       END,
       termination_date = CASE
         WHEN target.preserve_termination THEN target.termination_date
         WHEN COALESCE(balances.previous_balance, 0) > 0
           OR (balances.current_due_date IS NOT NULL AND clock.today > balances.current_due_date + 8)
           THEN clock.today
         ELSE NULL
       END,
       termination_reason = CASE
         WHEN target.preserve_termination THEN target.termination_reason
         WHEN COALESCE(balances.previous_balance, 0) > 0
           OR (balances.current_due_date IS NOT NULL AND clock.today > balances.current_due_date + 8)
           THEN 'Non-payment'
         ELSE NULL
       END,
       grace_end_date = CASE
         WHEN NOT target.preserve_termination
          AND balances.current_due_date IS NOT NULL
          AND COALESCE(balances.current_balance, 0) > 0
          THEN balances.current_due_date + 5
         ELSE NULL
       END,
       flagged_date = CASE
         WHEN NOT target.preserve_termination
          AND balances.current_due_date IS NOT NULL
          AND COALESCE(balances.current_balance, 0) > 0
          AND clock.today > balances.current_due_date + 5
          THEN balances.current_due_date + 6
         ELSE NULL
       END
  FROM affected_terminations target
  CROSS JOIN clock
  LEFT JOIN balances ON balances.account_no=target.account_no
 WHERE c.account_no=target.account_no;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid='public.statements'::regclass
       AND contype='u'
       AND pg_get_constraintdef(oid)='UNIQUE (account_no, billing_month)'
  ) THEN
    ALTER TABLE statements
      ADD CONSTRAINT uq_statements_account_billing_month UNIQUE (account_no, billing_month);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_statements_billing_account
  ON statements(billing_month, account_no);
CREATE INDEX IF NOT EXISTS idx_statements_account_payment_status
  ON statements(account_no, payment_status);
CREATE INDEX IF NOT EXISTS idx_payments_status_date
  ON payments(status, payment_date);
CREATE INDEX IF NOT EXISTS idx_payments_account_status
  ON payments(account_no, status);
CREATE INDEX IF NOT EXISTS idx_payments_statement_status
  ON payments(statement_id, status);
CREATE INDEX IF NOT EXISTS idx_clients_installed_status_branch_plan
  ON clients(installed_date, status, branch_code, plan_id);

COMMIT;
