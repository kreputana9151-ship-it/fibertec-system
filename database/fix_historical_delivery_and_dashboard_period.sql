BEGIN;

SET LOCAL search_path = public, pg_temp;
LOCK TABLE branches, clients, plans, statements, payments, notices
  IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
  missing_columns TEXT;
BEGIN
  SELECT string_agg(required.table_name || '.' || required.column_name, ', ')
    INTO missing_columns
    FROM (VALUES
      ('branches', 'branch_code'),
      ('clients', 'account_no'), ('clients', 'branch_code'), ('clients', 'plan_id'),
      ('clients', 'installed_date'), ('clients', 'due_day'), ('clients', 'status'),
      ('clients', 'termination_date'), ('clients', 'current_balance'),
      ('plans', 'plan_id'), ('plans', 'monthly_rate'),
      ('statements', 'statement_id'), ('statements', 'invoice_no'),
      ('statements', 'account_no'), ('statements', 'billing_month'),
      ('statements', 'issued_date'), ('statements', 'due_date'),
      ('statements', 'amount'), ('statements', 'amount_paid'),
      ('statements', 'balance'), ('statements', 'payment_status'),
      ('statements', 'send_status'),
      ('payments', 'statement_id'), ('payments', 'account_no'), ('payments', 'amount'),
      ('payments', 'method'), ('payments', 'payment_type'), ('payments', 'status'),
      ('payments', 'payment_date'), ('payments', 'or_no'), ('payments', 'verified_at'),
      ('notices', 'notice_id'), ('notices', 'statement_id'), ('notices', 'account_no')
    ) AS required(table_name, column_name)
   WHERE NOT EXISTS (
     SELECT 1
       FROM information_schema.columns column_info
      WHERE column_info.table_schema = 'public'
        AND column_info.table_name = required.table_name
        AND column_info.column_name = required.column_name
   );

  IF missing_columns IS NOT NULL THEN
    RAISE EXCEPTION 'Cannot reconcile historical billing; missing columns: %', missing_columns;
  END IF;
END $$;

DO $$
BEGIN
  IF (SELECT COUNT(*) FROM clients) < 58 THEN
    RAISE EXCEPTION 'At least 58 clients are required for the requested 2020 cohort.';
  END IF;
END $$;

CREATE TEMP TABLE balanced_client_order ON COMMIT DROP AS
WITH branch_ranks AS (
  SELECT c.account_no, c.branch_code,
         ROW_NUMBER() OVER (
           PARTITION BY c.branch_code
           ORDER BY c.account_no
         ) AS branch_rank
    FROM clients c
)
SELECT account_no, branch_code,
       ROW_NUMBER() OVER (
         ORDER BY branch_rank, branch_code, account_no
       ) AS cohort_rank
  FROM branch_ranks;

CREATE TEMP TABLE revised_installation_dates ON COMMIT DROP AS
WITH clock AS (
  SELECT (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Manila')::date AS today,
         GREATEST(
           1,
           (EXTRACT(YEAR FROM (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Manila')::date)::int - 2021) * 12
             + EXTRACT(MONTH FROM (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Manila')::date)::int
         ) AS later_month_count
),
selected_cohort AS (
  SELECT ordered.account_no, ordered.cohort_rank,
         CASE
           WHEN ordered.cohort_rank <= 10
             THEN make_date(2020, 1, ((ordered.cohort_rank - 1) * 3 + 1)::int)
           ELSE make_date(
             2020,
             (2 + ((ordered.cohort_rank - 11) % 11))::int,
             ((ordered.cohort_rank * 7 - 1) % 28 + 1)::int
           )
         END AS installed_date
    FROM balanced_client_order ordered
   WHERE ordered.cohort_rank <= 58
),
displaced_cohort AS (
  SELECT c.account_no,
         ROW_NUMBER() OVER (ORDER BY c.branch_code, c.account_no) AS displaced_rank
    FROM clients c
   WHERE c.installed_date >= DATE '2020-01-01'
     AND c.installed_date < DATE '2021-01-01'
     AND NOT EXISTS (
       SELECT 1
         FROM selected_cohort selected
        WHERE selected.account_no = c.account_no
     )
),
later_dates AS (
  SELECT displaced.account_no,
         (DATE '2021-01-01'
           + make_interval(months => ((displaced.displaced_rank - 1) % clock.later_month_count)::int))::date
           + LEAST(
               ((displaced.displaced_rank * 7 - 1) % 28 + 1)::int,
               CASE
                 WHEN (DATE '2021-01-01'
                        + make_interval(months => ((displaced.displaced_rank - 1) % clock.later_month_count)::int))::date
                      = date_trunc('month', clock.today)::date
                   THEN EXTRACT(DAY FROM clock.today)::int
                 ELSE 28
               END
             ) - 1 AS installed_date
    FROM displaced_cohort displaced
    CROSS JOIN clock
)
SELECT account_no, installed_date FROM selected_cohort
UNION ALL
SELECT account_no, installed_date FROM later_dates;

CREATE TEMP TABLE accounts_to_rebuild ON COMMIT DROP AS
SELECT c.account_no, target.installed_date
  FROM clients c
  JOIN revised_installation_dates target USING (account_no)
 WHERE c.installed_date IS DISTINCT FROM target.installed_date;

DO $$
DECLARE
  january_count INTEGER;
  cohort_count INTEGER;
  branch_count_difference BIGINT;
BEGIN
  SELECT COUNT(*) INTO cohort_count
    FROM balanced_client_order
   WHERE cohort_rank <= 58;
  SELECT COUNT(*) INTO january_count
    FROM revised_installation_dates
   WHERE installed_date >= DATE '2020-01-01'
     AND installed_date < DATE '2020-02-01';

  IF cohort_count <> 58 OR january_count <> 10 THEN
    RAISE EXCEPTION 'The balanced cohort schedule must contain 58 clients, including 10 January 2020 starters.';
  END IF;

  SELECT COALESCE(MAX(branch_clients), 0) - COALESCE(MIN(branch_clients), 0)
    INTO branch_count_difference
    FROM (
      SELECT branch.branch_code, COUNT(ordered.account_no) AS branch_clients
        FROM (SELECT DISTINCT branch_code FROM clients) branch_list
        LEFT JOIN balanced_client_order ordered
          ON ordered.branch_code = branch_list.branch_code
         AND ordered.cohort_rank <= 58
       GROUP BY branch_list.branch_code
    ) cohort_branch_counts;

  IF branch_count_difference > 1 THEN
    RAISE EXCEPTION 'The 58-client cohort cannot be evenly distributed across the populated branches.';
  END IF;
END $$;

CREATE TEMP TABLE rebuilt_notice_links ON COMMIT DROP AS
SELECT n.notice_id, n.account_no, s.billing_month
  FROM notices n
  JOIN statements s ON s.statement_id = n.statement_id
  JOIN accounts_to_rebuild affected USING (account_no);

UPDATE notices n
   SET statement_id = NULL
  FROM rebuilt_notice_links old_link
 WHERE n.notice_id = old_link.notice_id;

UPDATE clients c
   SET installed_date = target.installed_date,
       due_day = EXTRACT(DAY FROM target.installed_date)::smallint
  FROM accounts_to_rebuild target
 WHERE c.account_no = target.account_no;

DELETE FROM payments p
 USING accounts_to_rebuild affected
 WHERE p.account_no = affected.account_no;

DELETE FROM statements s
 USING accounts_to_rebuild affected
 WHERE s.account_no = affected.account_no;

CREATE TEMP TABLE rebuilt_cycles ON COMMIT DROP AS
WITH client_schedule AS (
  SELECT c.account_no, c.installed_date, c.due_day, c.status, c.termination_date,
         p.monthly_rate,
         (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Manila')::date AS today,
         CASE WHEN c.status = 'Terminated'
              THEN LEAST(
                (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Manila')::date,
                COALESCE(c.termination_date, (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Manila')::date)
              )
              ELSE (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Manila')::date
          END AS cycle_end
    FROM clients c
    JOIN plans p USING (plan_id)
    JOIN accounts_to_rebuild affected USING (account_no)
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

CREATE SEQUENCE IF NOT EXISTS statement_invoice_seq;
SELECT setval(
  'statement_invoice_seq',
  COALESCE(MAX(substring(invoice_no FROM '^FT-([0-9]+)$')::BIGINT), 1),
  MAX(substring(invoice_no FROM '^FT-([0-9]+)$')::BIGINT) IS NOT NULL
)
  FROM statements
 WHERE invoice_no ~ '^FT-[0-9]+$';

INSERT INTO statements
  (invoice_no, account_no, billing_month, issued_date, due_date, amount, balance)
SELECT 'FT-' || nextval('statement_invoice_seq')::text,
       cycles.account_no, cycles.billing_month, cycles.issued_date, cycles.due_date,
       cycles.monthly_rate, cycles.monthly_rate
  FROM rebuilt_cycles cycles
 ORDER BY cycles.account_no, cycles.billing_month
ON CONFLICT (account_no, billing_month) DO NOTHING;

UPDATE notices n
   SET statement_id = s.statement_id
  FROM rebuilt_notice_links old_link
  JOIN statements s
    ON s.account_no = old_link.account_no
   AND s.billing_month = old_link.billing_month
 WHERE n.notice_id = old_link.notice_id;

INSERT INTO payments
  (statement_id, account_no, amount, method, payment_type, status, payment_date, verified_at)
SELECT s.statement_id, s.account_no, s.amount, 'Cash', 'Full payment',
       'Verified', s.due_date,
       (s.due_date::timestamp + TIME '12:00') AT TIME ZONE 'Asia/Manila'
  FROM statements s
  JOIN accounts_to_rebuild affected USING (account_no)
 WHERE s.billing_month < date_trunc(
         'month', (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Manila')::date
       )::date;

CREATE SEQUENCE IF NOT EXISTS official_receipt_seq;
CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_or_no
  ON payments(or_no) WHERE or_no IS NOT NULL;

DO $$
DECLARE
  payment_row RECORD;
  receipt_number TEXT;
  receipt_year INTEGER;
BEGIN
  FOR payment_row IN
    SELECT p.payment_id, p.payment_date
      FROM payments p
      JOIN accounts_to_rebuild affected USING (account_no)
     WHERE p.status = 'Verified'
       AND p.or_no IS NULL
     ORDER BY p.payment_date, p.payment_id
  LOOP
    receipt_year := EXTRACT(YEAR FROM payment_row.payment_date)::int;
    LOOP
      receipt_number := 'OR-' || receipt_year || '-'
                        || LPAD(nextval('official_receipt_seq'::regclass)::text, 6, '0');
      EXIT WHEN NOT EXISTS (SELECT 1 FROM payments WHERE or_no = receipt_number);
    END LOOP;

    UPDATE payments
       SET or_no = receipt_number
     WHERE payment_id = payment_row.payment_id;
  END LOOP;
END $$;

UPDATE statements s
   SET amount_paid = COALESCE(paid.verified_paid, 0),
       balance = GREATEST(s.amount - COALESCE(paid.verified_paid, 0), 0),
       payment_status = CASE
         WHEN COALESCE(paid.verified_paid, 0) >= s.amount THEN 'Paid'
         WHEN COALESCE(paid.verified_paid, 0) > 0 THEN 'Partially paid'
         ELSE 'Unpaid'
       END
  FROM (
    SELECT p.statement_id, SUM(p.amount) AS verified_paid
      FROM payments p
     WHERE p.status = 'Verified'
     GROUP BY p.statement_id
  ) paid
 WHERE s.statement_id = paid.statement_id
   AND EXISTS (
     SELECT 1 FROM accounts_to_rebuild affected
      WHERE affected.account_no = s.account_no
   );

UPDATE statements s
   SET amount_paid = 0,
       balance = s.amount,
       payment_status = 'Unpaid'
  FROM accounts_to_rebuild affected
 WHERE s.account_no = affected.account_no
   AND NOT EXISTS (
     SELECT 1 FROM payments p
      WHERE p.statement_id = s.statement_id
        AND p.status = 'Verified'
   );

UPDATE clients c
   SET current_balance = COALESCE((
     SELECT SUM(GREATEST(s.amount - COALESCE(s.amount_paid, 0), 0))
       FROM statements s
      WHERE s.account_no = c.account_no
        AND s.billing_month <= date_trunc(
          'month', (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Manila')::date
        )::date
   ), 0)
  FROM accounts_to_rebuild affected
 WHERE c.account_no = affected.account_no;

UPDATE statements s
   SET send_status = 'Delivered'
 WHERE s.billing_month < date_trunc(
         'month', (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Manila')::date
       )::date
   AND s.send_status = 'Not Yet Sent'
   AND (
     s.amount_paid > 0
     OR EXISTS (
       SELECT 1 FROM payments p
        WHERE p.statement_id = s.statement_id
          AND p.status = 'Verified'
     )
   );

DO $$
DECLARE
  final_cohort_count INTEGER;
  final_january_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO final_cohort_count
    FROM clients
   WHERE installed_date >= DATE '2020-01-01'
     AND installed_date < DATE '2021-01-01';
  SELECT COUNT(*) INTO final_january_count
    FROM clients
   WHERE installed_date >= DATE '2020-01-01'
     AND installed_date < DATE '2020-02-01';

  IF final_cohort_count <> 58 OR final_january_count <> 10 THEN
    RAISE EXCEPTION 'Historical cohort reconciliation failed: expected 58 clients, including 10 January 2020 starters.';
  END IF;
END $$;

COMMIT;
