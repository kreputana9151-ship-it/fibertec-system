-- Finalize the current billing-month collection and account-status distribution.
-- Replaces current-month payments and creates synthetic verified collection records.
-- Run after align_2024_2026_lightweight.sql against the intended database.
BEGIN;

SET LOCAL search_path = public, pg_temp;
LOCK TABLE clients, plans, statements, payments
  IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
  missing_columns TEXT;
  today DATE := (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Manila')::date;
  cohort_2024 INTEGER;
  january_2024 INTEGER;
BEGIN
  SELECT string_agg(required.table_name || '.' || required.column_name, ', ')
    INTO missing_columns
    FROM (VALUES
      ('clients', 'account_no'), ('clients', 'plan_id'), ('clients', 'installed_date'),
      ('clients', 'due_day'), ('clients', 'status'), ('clients', 'status_reason'),
      ('clients', 'termination_date'), ('clients', 'termination_reason'),
      ('clients', 'grace_end_date'), ('clients', 'flagged_date'),
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
      ('payments', 'payment_date'), ('payments', 'verified_at'), ('payments', 'or_no')
    ) AS required(table_name, column_name)
   WHERE NOT EXISTS (
     SELECT 1
       FROM information_schema.columns column_info
      WHERE column_info.table_schema = 'public'
        AND column_info.table_name = required.table_name
        AND column_info.column_name = required.column_name
   );

  IF missing_columns IS NOT NULL THEN
    RAISE EXCEPTION 'Cannot finalize billing synchronization; missing columns: %', missing_columns;
  END IF;
  IF (SELECT COUNT(*) FROM clients) < 58 THEN
    RAISE EXCEPTION 'At least 58 clients are required for the 2024 cohort.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM clients
     WHERE installed_date < DATE '2024-01-01'
        OR installed_date > today
  ) THEN
    RAISE EXCEPTION 'Client installation dates must remain within 2024 and Manila today.';
  END IF;

  SELECT COUNT(*) INTO cohort_2024
    FROM clients
   WHERE installed_date >= DATE '2024-01-01'
     AND installed_date < DATE '2025-01-01';
  SELECT COUNT(*) INTO january_2024
    FROM clients
   WHERE installed_date >= DATE '2024-01-01'
     AND installed_date < DATE '2024-02-01';
  IF cohort_2024 <> 58 OR january_2024 <> 10 THEN
    RAISE EXCEPTION 'Expected 58 clients in 2024, including 10 January 2024 starters; found % and %.',
      cohort_2024, january_2024;
  END IF;
END $$;

CREATE TEMP TABLE sync_clock ON COMMIT DROP AS
SELECT dates.today,
       date_trunc('month', dates.today)::date AS current_month,
       (date_trunc('month', dates.today) - INTERVAL '1 month')::date AS previous_month,
       LEAST(25, EXTRACT(DAY FROM dates.today)::int) AS last_payment_day
  FROM (SELECT (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Manila')::date AS today) dates;

CREATE TEMP TABLE sync_cohort ON COMMIT DROP AS
WITH population AS (
  SELECT c.account_no, c.installed_date, c.due_day, p.monthly_rate,
         ROW_NUMBER() OVER (ORDER BY c.account_no) AS client_order,
         COUNT(*) OVER ()::int AS client_count,
         clock.today, clock.current_month,
         GREATEST(
           clock.current_month
             + LEAST(
                 c.due_day::int,
                 EXTRACT(DAY FROM (clock.current_month + INTERVAL '1 month - 1 day'))::int
               ) - 1,
           CASE
             WHEN date_trunc('month', c.installed_date)::date=clock.current_month
               THEN c.installed_date
             ELSE clock.current_month
           END
         )::date AS current_due_date
    FROM clients c
    JOIN plans p USING (plan_id)
    CROSS JOIN sync_clock clock
),
targets AS (
  SELECT MAX(client_count) AS client_count,
         LEAST(35, GREATEST(25, ROUND(MAX(client_count)::numeric * 0.10)::int)) AS terminated_target,
         ROUND(MAX(client_count)::numeric * 0.15)::int AS unpaid_target
    FROM population
),
termination_candidates AS (
  SELECT population.account_no,
         ROW_NUMBER() OVER (ORDER BY population.account_no) AS termination_order
    FROM population
   WHERE population.installed_date < population.current_month
),
unpaid_candidates AS (
  SELECT population.account_no,
         ROW_NUMBER() OVER (ORDER BY population.account_no) AS unpaid_order
    FROM population
    CROSS JOIN targets
    CROSS JOIN sync_clock clock
    LEFT JOIN termination_candidates termination
      ON termination.account_no=population.account_no
     AND termination.termination_order <= targets.terminated_target
   WHERE clock.today >= population.current_due_date - 7
     AND population.current_due_date <= clock.today + 7
     AND population.current_due_date >= clock.today - 5
     AND termination.account_no IS NULL
)
SELECT population.account_no, population.installed_date, population.due_day,
       population.monthly_rate, population.current_due_date,
       population.today, population.current_month,
       targets.client_count, targets.terminated_target, targets.unpaid_target,
       CASE
         WHEN termination.termination_order <= targets.terminated_target THEN 'Terminated'
         WHEN unpaid.unpaid_order <= targets.unpaid_target THEN 'Unpaid'
         WHEN population.today >= population.current_due_date - 7
          AND population.current_due_date <= population.today + 7 THEN 'Paid'
         ELSE 'Not Due'
       END AS cohort_status
  FROM population
  CROSS JOIN targets
  LEFT JOIN termination_candidates termination USING (account_no)
  LEFT JOIN unpaid_candidates unpaid USING (account_no);

DO $$
DECLARE
  expected_terminated INTEGER;
  expected_unpaid INTEGER;
  actual_terminated INTEGER;
  actual_unpaid INTEGER;
  eligible_unpaid INTEGER;
BEGIN
  SELECT MAX(terminated_target), MAX(unpaid_target),
         COUNT(*) FILTER (WHERE cohort_status='Terminated'),
         COUNT(*) FILTER (WHERE cohort_status='Unpaid')
    INTO expected_terminated, expected_unpaid, actual_terminated, actual_unpaid
    FROM sync_cohort;
  SELECT COUNT(*) INTO eligible_unpaid
    FROM sync_cohort
   WHERE cohort_status IN ('Unpaid', 'Paid')
     AND today >= current_due_date - 7
     AND current_due_date <= today + 7
     AND current_due_date >= today - 5;

  IF actual_terminated <> expected_terminated OR actual_terminated NOT BETWEEN 25 AND 35 THEN
    RAISE EXCEPTION 'Could not assign the requested 25-35 clients to prior-month arrears.';
  END IF;
  IF actual_unpaid <> expected_unpaid OR eligible_unpaid < expected_unpaid THEN
    RAISE EXCEPTION 'Not enough clients are within the Active/Grace due-date window for the unpaid cohort.';
  END IF;
END $$;

CREATE SEQUENCE IF NOT EXISTS statement_invoice_seq;
CREATE SEQUENCE IF NOT EXISTS official_receipt_seq;
CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_or_no
  ON payments(or_no) WHERE or_no IS NOT NULL;

DELETE FROM payments payment
 USING statements statement, clients client, sync_clock clock
 WHERE payment.statement_id=statement.statement_id
   AND client.account_no=statement.account_no
   AND (
     statement.billing_month < DATE '2024-01-01'
     OR statement.billing_month > clock.current_month
     OR statement.billing_month < date_trunc('month', client.installed_date)::date
     OR statement.issued_date < DATE '2024-01-01'
     OR statement.issued_date > clock.today
     OR statement.due_date < DATE '2024-01-01'
     OR statement.due_date > clock.today + 7
     OR payment.payment_date < statement.issued_date
     OR payment.payment_date < GREATEST(DATE '2024-01-01', client.installed_date)
     OR payment.payment_date > clock.today
   );

DELETE FROM statements statement
 USING clients client, sync_clock clock
 WHERE client.account_no=statement.account_no
   AND (
     statement.billing_month < DATE '2024-01-01'
     OR statement.billing_month > clock.current_month
     OR statement.billing_month < date_trunc('month', client.installed_date)::date
     OR statement.issued_date < DATE '2024-01-01'
     OR statement.issued_date > clock.today
     OR statement.due_date < DATE '2024-01-01'
     OR statement.due_date > clock.today + 7
   );

UPDATE statements statement
   SET amount = plan.monthly_rate
  FROM clients client
  JOIN plans plan USING (plan_id)
 WHERE client.account_no=statement.account_no;

UPDATE statements statement
   SET issued_date = client.installed_date,
       due_date = GREATEST(statement.due_date, client.installed_date)
  FROM clients client
 WHERE client.account_no=statement.account_no
   AND statement.billing_month=date_trunc('month', client.installed_date)::date;

DO $$
DECLARE
  max_invoice BIGINT;
BEGIN
  SELECT MAX(substring(invoice_no FROM '^FT-([0-9]+)$')::bigint)
    INTO max_invoice
    FROM statements
   WHERE invoice_no ~ '^FT-[0-9]+$';
  IF max_invoice IS NULL THEN
    PERFORM setval('statement_invoice_seq', 1, FALSE);
  ELSE
    PERFORM setval('statement_invoice_seq', max_invoice, TRUE);
  END IF;
END $$;

CREATE TEMP TABLE sync_cycles ON COMMIT DROP AS
SELECT cohort.account_no, cohort.installed_date, cohort.due_day, cohort.monthly_rate,
       months.month_start::date AS billing_month,
       GREATEST(
         months.month_start::date
           + LEAST(
               cohort.due_day::int,
               EXTRACT(DAY FROM (months.month_start + INTERVAL '1 month - 1 day'))::int
             ) - 1,
         CASE
           WHEN date_trunc('month', cohort.installed_date)::date=months.month_start::date
             THEN cohort.installed_date
           ELSE months.month_start::date
         END
       )::date AS due_date,
       CASE
         WHEN date_trunc('month', cohort.installed_date)::date=months.month_start::date
           THEN cohort.installed_date
         ELSE GREATEST(
           (months.month_start::date - INTERVAL '1 month')::date
             + LEAST(
                 cohort.due_day::int,
                 EXTRACT(DAY FROM (months.month_start::date - INTERVAL '1 day'))::int
               ) - 1,
           CASE
             WHEN date_trunc('month', cohort.installed_date)::date
                    = (months.month_start::date - INTERVAL '1 month')::date
               THEN cohort.installed_date
             ELSE (months.month_start::date - INTERVAL '1 month')::date
           END
         )::date
       END AS issued_date
  FROM sync_cohort cohort
  CROSS JOIN sync_clock clock
  CROSS JOIN LATERAL generate_series(
    (clock.current_month - INTERVAL '1 month')::timestamp,
    clock.current_month::timestamp,
    INTERVAL '1 month'
  ) AS months(month_start)
 WHERE months.month_start::date >= date_trunc('month', cohort.installed_date)::date;

INSERT INTO statements
  (invoice_no, account_no, billing_month, issued_date, due_date, amount, balance)
SELECT 'FT-' || nextval('statement_invoice_seq')::text,
       cycle.account_no, cycle.billing_month, cycle.issued_date, cycle.due_date,
       cycle.monthly_rate, cycle.monthly_rate
  FROM sync_cycles cycle
  CROSS JOIN sync_clock clock
 WHERE cycle.billing_month < clock.current_month
    OR (
      clock.today >= cycle.due_date - 7
      AND cycle.due_date <= clock.today + 7
    )
 ORDER BY cycle.account_no, cycle.billing_month
ON CONFLICT (account_no, billing_month) DO NOTHING;

UPDATE statements statement
   SET amount = cycle.monthly_rate,
       issued_date = cycle.issued_date,
       due_date = cycle.due_date
  FROM sync_cycles cycle
 WHERE statement.account_no=cycle.account_no
   AND statement.billing_month=cycle.billing_month;

DELETE FROM payments payment
 USING statements statement, sync_clock clock
 WHERE payment.statement_id=statement.statement_id
   AND statement.billing_month=clock.current_month;

DELETE FROM payments payment
 USING statements statement, sync_cohort cohort, sync_clock clock
 WHERE payment.statement_id=statement.statement_id
   AND cohort.account_no=statement.account_no
   AND cohort.cohort_status='Terminated'
   AND statement.billing_month=clock.previous_month;

DELETE FROM payments payment
 USING statements statement, sync_clock clock
 WHERE payment.statement_id=statement.statement_id
   AND statement.billing_month < clock.current_month
   AND payment.status <> 'Verified';

DELETE FROM statements statement
 USING sync_cohort cohort, sync_clock clock
 WHERE cohort.account_no=statement.account_no
   AND cohort.cohort_status='Terminated'
   AND statement.billing_month=clock.current_month;

CREATE TEMP TABLE overpaid_history ON COMMIT DROP AS
SELECT statement.statement_id
  FROM statements statement
  JOIN clients client USING (account_no)
  JOIN plans plan USING (plan_id)
  CROSS JOIN sync_clock clock
  LEFT JOIN sync_cohort cohort USING (account_no)
  JOIN payments payment ON payment.statement_id=statement.statement_id
 WHERE statement.billing_month < clock.current_month
   AND NOT (
     cohort.cohort_status='Terminated'
     AND statement.billing_month=clock.previous_month
   )
   AND payment.status='Verified'
 GROUP BY statement.statement_id, plan.monthly_rate
HAVING SUM(payment.amount) > plan.monthly_rate;

DELETE FROM payments payment
 USING overpaid_history overpaid
 WHERE payment.statement_id=overpaid.statement_id;

CREATE TEMP TABLE payment_repairs ON COMMIT DROP AS
SELECT statement.statement_id, statement.account_no,
       GREATEST(plan.monthly_rate - COALESCE(
         SUM(payment.amount) FILTER (WHERE payment.status='Verified'), 0
       ), 0) AS amount,
       GREATEST(statement.due_date, client.installed_date) AS payment_date
  FROM statements statement
  JOIN clients client USING (account_no)
  JOIN plans plan USING (plan_id)
  CROSS JOIN sync_clock clock
  LEFT JOIN sync_cohort cohort USING (account_no)
  LEFT JOIN payments payment ON payment.statement_id=statement.statement_id
 WHERE statement.billing_month < clock.current_month
   AND NOT (
     cohort.cohort_status='Terminated'
     AND statement.billing_month=clock.previous_month
   )
 GROUP BY statement.statement_id, statement.account_no, plan.monthly_rate,
          statement.due_date, client.installed_date
HAVING COALESCE(SUM(payment.amount) FILTER (WHERE payment.status='Verified'), 0)
       < plan.monthly_rate;

CREATE TEMP TABLE current_payments_to_create ON COMMIT DROP AS
WITH paid_clients AS (
  SELECT cohort.account_no, cohort.installed_date,
         ROW_NUMBER() OVER (ORDER BY cohort.account_no) AS paid_order,
         clock.current_month,
         CASE
           WHEN cohort.installed_date >= clock.current_month
             THEN GREATEST(
               clock.last_payment_day,
               EXTRACT(DAY FROM cohort.installed_date)::int
             )
           ELSE clock.last_payment_day
         END AS last_payment_day,
         CASE WHEN cohort.installed_date >= clock.current_month
              THEN EXTRACT(DAY FROM cohort.installed_date)::int
              ELSE 1
          END AS first_payment_day
    FROM sync_cohort cohort
    CROSS JOIN sync_clock clock
   WHERE cohort.cohort_status='Paid'
)
SELECT statement.statement_id, statement.account_no, statement.amount,
       (paid.current_month
         + (
           paid.first_payment_day - 1
           + ((paid.paid_order - 1)
             % (paid.last_payment_day - paid.first_payment_day + 1))::int
         ))::date AS payment_date
  FROM paid_clients paid
  JOIN statements statement
    ON statement.account_no=paid.account_no
   AND statement.billing_month=paid.current_month;

CREATE TEMP TABLE payments_to_create ON COMMIT DROP AS
SELECT statement_id, account_no, amount, payment_date
  FROM payment_repairs
 WHERE amount > 0
UNION ALL
SELECT statement_id, account_no, amount, payment_date
  FROM current_payments_to_create;

DO $$
DECLARE
  max_receipt BIGINT;
BEGIN
  SELECT MAX(substring(or_no FROM '^OR-[0-9]{4}-([0-9]+)$')::bigint)
    INTO max_receipt
    FROM payments
   WHERE or_no ~ '^OR-[0-9]{4}-[0-9]+$';
  IF max_receipt IS NULL THEN
    PERFORM setval('official_receipt_seq', 1, FALSE);
  ELSE
    PERFORM setval('official_receipt_seq', max_receipt, TRUE);
  END IF;
END $$;

INSERT INTO payments
  (statement_id, account_no, amount, method, payment_type, or_no, status, payment_date, verified_at)
SELECT payment.statement_id, payment.account_no, payment.amount, 'Cash', 'Full payment',
       'OR-' || TO_CHAR(payment.payment_date, 'YYYY') || '-'
         || LPAD(nextval('official_receipt_seq'::regclass)::text, 6, '0'),
       'Verified', payment.payment_date,
       (payment.payment_date::timestamp + TIME '12:00') AT TIME ZONE 'Asia/Manila'
  FROM payments_to_create payment
 ORDER BY payment.payment_date, payment.account_no, payment.statement_id;

WITH statement_totals AS (
  SELECT statement.statement_id, statement.account_no, statement.billing_month,
         statement.send_status AS previous_send_status,
         plan.monthly_rate,
         COALESCE(SUM(payment.amount) FILTER (WHERE payment.status='Verified'), 0) AS verified_paid,
         COALESCE(cohort.cohort_status, 'Paid') AS cohort_status,
         clock.current_month, clock.previous_month
    FROM statements statement
    JOIN clients client USING (account_no)
    JOIN plans plan USING (plan_id)
    CROSS JOIN sync_clock clock
    LEFT JOIN sync_cohort cohort USING (account_no)
    LEFT JOIN payments payment ON payment.statement_id=statement.statement_id
   GROUP BY statement.statement_id, statement.account_no, statement.billing_month,
            statement.send_status, plan.monthly_rate, cohort.cohort_status,
            clock.current_month, clock.previous_month
)
UPDATE statements statement
   SET amount = totals.monthly_rate,
       amount_paid = totals.verified_paid,
       balance = GREATEST(totals.monthly_rate - totals.verified_paid, 0),
       payment_status = CASE
         WHEN totals.verified_paid >= totals.monthly_rate THEN 'Paid'
         WHEN totals.verified_paid > 0 THEN 'Partially paid'
         ELSE 'Unpaid'
       END,
       send_status = CASE
         WHEN totals.billing_month=totals.current_month
          AND totals.cohort_status='Paid' THEN 'Delivered'
         WHEN totals.billing_month=totals.current_month THEN 'Not Yet Sent'
         WHEN totals.billing_month=totals.previous_month
          AND totals.cohort_status='Terminated' THEN 'Delivered'
         WHEN totals.verified_paid >= totals.monthly_rate THEN 'Delivered'
         ELSE totals.previous_send_status
       END
  FROM statement_totals totals
 WHERE statement.statement_id=totals.statement_id;

UPDATE clients client
   SET current_balance = COALESCE((
         SELECT SUM(GREATEST(statement.amount - COALESCE(statement.amount_paid, 0), 0))
           FROM statements statement
          WHERE statement.account_no=client.account_no
       ), 0),
       status = CASE cohort.cohort_status
         WHEN 'Terminated' THEN 'Terminated'
         WHEN 'Unpaid' THEN CASE
           WHEN cohort.current_due_date >= cohort.today THEN 'Active'
           ELSE 'Grace Period'
         END
         ELSE 'Active'
       END,
       status_reason = CASE
         WHEN cohort.cohort_status='Terminated' THEN 'Previous billing month arrears'
         WHEN cohort.cohort_status='Unpaid'
          AND cohort.current_due_date < cohort.today THEN 'Grace period'
         ELSE NULL
       END,
       termination_date = CASE
         WHEN cohort.cohort_status='Terminated' THEN cohort.today
         ELSE NULL
       END,
       termination_reason = CASE
         WHEN cohort.cohort_status='Terminated' THEN 'Non-payment'
         ELSE NULL
       END,
       grace_end_date = CASE
         WHEN cohort.cohort_status='Unpaid' THEN cohort.current_due_date + 5
         ELSE NULL
       END,
       flagged_date = NULL
  FROM sync_cohort cohort
 WHERE client.account_no=cohort.account_no;

DO $$
DECLARE
  bad_balance BOOLEAN;
  bad_paid_cycle BOOLEAN;
  bad_unpaid_cycle BOOLEAN;
  bad_terminated_cycle BOOLEAN;
  bad_arrears BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1
      FROM clients client
     WHERE client.current_balance IS DISTINCT FROM COALESCE((
       SELECT SUM(GREATEST(statement.amount - COALESCE(statement.amount_paid, 0), 0))
         FROM statements statement
        WHERE statement.account_no=client.account_no
     ), 0)
  ) INTO bad_balance;

  SELECT EXISTS (
    SELECT 1
      FROM sync_cohort cohort
      CROSS JOIN sync_clock clock
      LEFT JOIN statements statement
        ON statement.account_no=cohort.account_no
       AND statement.billing_month=clock.current_month
      LEFT JOIN LATERAL (
        SELECT COALESCE(SUM(payment.amount), 0) AS verified_paid
          FROM payments payment
         WHERE payment.statement_id=statement.statement_id
           AND payment.status='Verified'
      ) paid ON TRUE
     WHERE cohort.cohort_status='Paid'
       AND (
         statement.statement_id IS NULL
         OR paid.verified_paid <> cohort.monthly_rate
         OR statement.send_status <> 'Delivered'
         OR statement.amount <> cohort.monthly_rate
       )
  ) INTO bad_paid_cycle;

  SELECT EXISTS (
    SELECT 1
      FROM sync_cohort cohort
      CROSS JOIN sync_clock clock
      LEFT JOIN statements statement
        ON statement.account_no=cohort.account_no
       AND statement.billing_month=clock.current_month
     WHERE cohort.cohort_status='Unpaid'
       AND (
         statement.statement_id IS NULL
         OR statement.amount_paid <> 0
         OR statement.balance <> cohort.monthly_rate
         OR EXISTS (
           SELECT 1 FROM statements previous
            WHERE previous.account_no=cohort.account_no
              AND previous.billing_month < clock.current_month
              AND previous.amount > COALESCE(previous.amount_paid, 0)
         )
       )
  ) INTO bad_unpaid_cycle;

  SELECT EXISTS (
    SELECT 1
      FROM sync_cohort cohort
      CROSS JOIN sync_clock clock
     WHERE cohort.cohort_status='Terminated'
       AND (
         EXISTS (
           SELECT 1 FROM statements current_statement
            WHERE current_statement.account_no=cohort.account_no
              AND current_statement.billing_month=clock.current_month
         )
         OR NOT EXISTS (
           SELECT 1 FROM statements previous
            WHERE previous.account_no=cohort.account_no
              AND previous.billing_month=clock.previous_month
              AND previous.amount > COALESCE(previous.amount_paid, 0)
         )
       )
  ) INTO bad_terminated_cycle;

  SELECT EXISTS (
    SELECT 1
      FROM payments payment
      JOIN clients client USING (account_no)
      JOIN statements statement USING (statement_id)
      CROSS JOIN sync_clock clock
     WHERE payment.payment_date < DATE '2024-01-01'
        OR payment.payment_date < client.installed_date
        OR payment.payment_date < statement.issued_date
        OR payment.payment_date > clock.today
        OR (
          payment.payment_date >= clock.current_month
          AND payment.payment_date > clock.current_month
            + CASE
                WHEN client.installed_date >= clock.current_month
                  THEN GREATEST(
                    clock.last_payment_day,
                    EXTRACT(DAY FROM client.installed_date)::int
                  )
                ELSE clock.last_payment_day
              END - 1
        )
  ) INTO bad_arrears;

  IF bad_balance THEN
    RAISE EXCEPTION 'Client current_balance does not equal the sum of statement balances.';
  END IF;
  IF bad_paid_cycle THEN
    RAISE EXCEPTION 'A paid current-month account is missing its exact verified payment or Delivered statement.';
  END IF;
  IF bad_unpaid_cycle THEN
    RAISE EXCEPTION 'An unpaid current-month account has an invalid balance or prior-month arrears.';
  END IF;
  IF bad_terminated_cycle THEN
    RAISE EXCEPTION 'A terminated account is missing prior-month arrears or still has a current-month statement.';
  END IF;
  IF bad_arrears THEN
    RAISE EXCEPTION 'A payment date is outside the valid historical/current billing range.';
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
