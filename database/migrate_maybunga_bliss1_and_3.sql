-- Consolidate the standalone Maybunga / Bliss branches into the six official branches.
-- Branch-07 clients and any Bliss 2 clients must be reviewed before this migration can run.
-- Sample registrations use registered_date and created_at; the schema has no created_month column.
BEGIN;

DO $$
DECLARE
  bliss3_user_id INT;
  bliss1_user_id INT;
  old_maybunga_user_id INT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM branches WHERE branch_code = '04')
     OR NOT EXISTS (SELECT 1 FROM branches WHERE branch_code = '05') THEN
    RAISE EXCEPTION 'Expected branch codes 04 and 05 before migration.';
  END IF;

  IF EXISTS (SELECT 1 FROM users WHERE login_id = 'bliss3')
     AND EXISTS (SELECT 1 FROM users WHERE login_id = 'maybungabliss3') THEN
    RAISE EXCEPTION 'Both bliss3 and maybungabliss3 logins exist; resolve the duplicate before migration.';
  END IF;
  IF EXISTS (SELECT 1 FROM users WHERE login_id = 'bliss1')
     AND EXISTS (SELECT 1 FROM users WHERE login_id = 'maybungabliss1') THEN
    RAISE EXCEPTION 'Both bliss1 and maybungabliss1 logins exist; resolve the duplicate before migration.';
  END IF;
  IF EXISTS (SELECT 1 FROM users WHERE user_id = 349)
     AND NOT EXISTS (
       SELECT 1 FROM users
        WHERE user_id = 349 AND login_id = 'maybunga' AND role = 'staff'
     ) THEN
    RAISE EXCEPTION 'User 349 is not the expected standalone maybunga staff account.';
  END IF;

  UPDATE users SET login_id = 'maybungabliss3' WHERE login_id = 'bliss3';
  UPDATE users SET login_id = 'maybungabliss1' WHERE login_id = 'bliss1';

  SELECT user_id INTO bliss3_user_id
    FROM users WHERE login_id = 'maybungabliss3' AND role = 'staff';
  SELECT user_id INTO bliss1_user_id
    FROM users WHERE login_id = 'maybungabliss1' AND role = 'staff';
  IF bliss3_user_id IS NULL OR bliss1_user_id IS NULL THEN
    RAISE EXCEPTION 'Expected Maybunga Bliss 3 and Maybunga Bliss 1 staff logins.';
  END IF;

  UPDATE branches
     SET name = 'Maybunga Bliss 3', short_name = 'B3', barangay = 'Maybunga'
   WHERE branch_code = '04';
  UPDATE branches
     SET name = 'Maybunga Bliss 1', short_name = 'B1', barangay = 'Maybunga'
   WHERE branch_code = '05';

  UPDATE staff SET branch_code = '04', full_name = 'Staff - Maybunga Bliss 3'
   WHERE user_id = bliss3_user_id;
  UPDATE staff SET branch_code = '05', full_name = 'Staff - Maybunga Bliss 1'
   WHERE user_id = bliss1_user_id;

  IF EXISTS (SELECT 1 FROM users WHERE login_id = 'maybunga' AND user_id <> 349) THEN
    RAISE EXCEPTION 'A standalone maybunga login exists outside user_id 349; resolve it before migration.';
  END IF;

  SELECT user_id INTO old_maybunga_user_id
    FROM users WHERE user_id = 349 AND login_id = 'maybunga' AND role = 'staff';

  IF old_maybunga_user_id IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM clients WHERE user_id = old_maybunga_user_id) THEN
      RAISE EXCEPTION 'User 349 owns a client account; review it before deleting the standalone staff user.';
    END IF;

    UPDATE account_status_log SET changed_by = bliss3_user_id
     WHERE changed_by = old_maybunga_user_id;
    UPDATE activity_log
       SET user_id = bliss3_user_id,
           branch_code = '04'
     WHERE user_id = old_maybunga_user_id;
    UPDATE payments SET verified_by_staff = bliss3_user_id
     WHERE verified_by_staff = old_maybunga_user_id;
    UPDATE cancellation_requests SET decided_by_staff = bliss3_user_id
     WHERE decided_by_staff = old_maybunga_user_id;
    DELETE FROM password_resets WHERE user_id = old_maybunga_user_id;
    DELETE FROM staff WHERE user_id = old_maybunga_user_id;
    DELETE FROM users WHERE user_id = old_maybunga_user_id;
  END IF;

  IF EXISTS (SELECT 1 FROM clients WHERE branch_code = '07')
     OR EXISTS (
       SELECT 1 FROM clients c JOIN branches b USING (branch_code)
        WHERE b.name = 'Bliss 2'
     ) THEN
    RAISE EXCEPTION 'Branch 07 or Bliss 2 still has clients; migrate their account numbers and records before deleting the branch.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM staff s JOIN branches b USING (branch_code)
     WHERE s.branch_code = '07' OR b.name = 'Bliss 2'
  ) THEN
    RAISE EXCEPTION 'Branch 07 or Bliss 2 still has a staff assignment; review it before deleting the branch.';
  END IF;

  UPDATE activity_log
     SET branch_code = '04'
   WHERE branch_code = '07'
      OR branch_code IN (SELECT branch_code FROM branches WHERE name = 'Bliss 2');
  DELETE FROM branches
   WHERE branch_code = '07' OR name = 'Bliss 2';
END $$;

DO $$
BEGIN
  IF (SELECT COALESCE(MAX(client_seq), 0) FROM clients WHERE branch_code = '05') > 9989 THEN
    RAISE EXCEPTION 'Maybunga Bliss 1 does not have room for 10 more client sequence numbers.';
  END IF;
END $$;

CREATE TEMP TABLE maybunga_bliss1_sample_data ON COMMIT DROP AS
WITH sample_data (
  sample_no, name, contact_no, email, address, plan_name, registered_date,
  due_day, status, status_reason, flagged_date, grace_end_date,
  termination_date, termination_reason, current_balance
) AS (
  VALUES
    (1, 'Daniel Radcliffe', '09980000001', 'fibertec.demo.dradcliffe@gmail.com', 'Block 1 Lot 4, Maybunga Bliss 1, Maybunga, Pasig City', 'LiteSpeed 50Mbps', DATE '2025-01-14', 25, 'Active',       NULL, NULL::date, NULL::date, NULL::date, NULL, 499::numeric),
    (2, 'Emma Watson',      '09980000002', 'fibertec.demo.ewatson@gmail.com',    'Block 2 Lot 8, Maybunga Bliss 1, Maybunga, Pasig City', 'Turbo 110 Mbps', DATE '2025-04-22', 10, 'Active',       NULL, NULL::date, NULL::date, NULL::date, NULL, 0::numeric),
    (3, 'Rupert Grint',     '09980000003', 'fibertec.demo.rgrint@gmail.com',     'Block 3 Lot 2, Maybunga Bliss 1, Maybunga, Pasig City', 'Elite 150 Mbps', DATE '2025-08-09', 20, 'Grace Period', 'Unpaid after due date', NULL::date, DATE '2026-11-25', NULL::date, NULL, 1299::numeric),
    (4, 'Tom Felton',       '09980000004', 'fibertec.demo.tfelton@gmail.com',    'Block 4 Lot 6, Maybunga Bliss 1, Maybunga, Pasig City', 'Premium 220 Mbps', DATE '2025-11-18', 12, 'Under Review', 'Flagged for account review', DATE '2026-11-23', NULL::date, NULL::date, NULL, 1450::numeric),
    (5, 'Bonnie Wright',    '09980000005', 'fibertec.demo.bwright@gmail.com',    'Block 5 Lot 1, Maybunga Bliss 1, Maybunga, Pasig City', 'LiteSpeed 50Mbps', DATE '2025-12-03', 25, 'Terminated',   'Non-payment', NULL::date, NULL::date, DATE '2026-09-12', 'Non-payment', 799::numeric),
    (6, 'Matthew Lewis',    '09980000006', 'fibertec.demo.mlewis@gmail.com',     'Block 6 Lot 9, Maybunga Bliss 1, Maybunga, Pasig City', 'Turbo 110 Mbps', DATE '2026-01-17', 30, 'Active',       NULL, NULL::date, NULL::date, NULL::date, NULL, 0::numeric),
    (7, 'Evanna Lynch',     '09980000007', 'fibertec.demo.elynch@gmail.com',     'Block 7 Lot 3, Maybunga Bliss 1, Maybunga, Pasig City', 'Elite 150 Mbps', DATE '2026-03-26', 20, 'Grace Period', 'Unpaid after due date', NULL::date, DATE '2026-11-25', NULL::date, NULL, 1299::numeric),
    (8, 'Alan Rickman',     '09980000008', 'fibertec.demo.arickman@gmail.com',   'Block 8 Lot 5, Maybunga Bliss 1, Maybunga, Pasig City', 'Premium 220 Mbps', DATE '2026-05-08', 12, 'Under Review', 'Flagged for account review', DATE '2026-11-23', NULL::date, NULL::date, NULL, 1450::numeric),
    (9, 'Maggie Smith',     '09980000009', 'fibertec.demo.msmith@gmail.com',    'Block 9 Lot 7, Maybunga Bliss 1, Maybunga, Pasig City', 'LiteSpeed 50Mbps', DATE '2026-06-19', 17, 'Terminated',   'Client cancellation', NULL::date, NULL::date, DATE '2026-10-21', 'Client cancellation', 0::numeric),
    (10,'Robbie Coltrane',  '09980000010', 'fibertec.demo.rcoltrane@gmail.com',  'Block 10 Lot 2, Maybunga Bliss 1, Maybunga, Pasig City', 'Turbo 110 Mbps', DATE '2026-08-24', 22, 'Active',       NULL, NULL::date, NULL::date, NULL::date, NULL, 0::numeric)
),
branch_seq AS (
  SELECT COALESCE(MAX(c.client_seq), 0) AS max_seq
    FROM clients c
   WHERE c.branch_code = '05'
     AND NOT EXISTS (SELECT 1 FROM sample_data d WHERE d.email = c.email)
)
SELECT ('05' || TO_CHAR(s.registered_date, 'YY') || LPAD((b.max_seq + s.sample_no)::text, 4, '0')) AS account_no,
       (b.max_seq + s.sample_no)::smallint AS client_seq,
       s.*
  FROM sample_data s CROSS JOIN branch_seq b
;

CREATE TEMP TABLE maybunga_bliss1_samples ON COMMIT DROP AS
SELECT s.*
  FROM maybunga_bliss1_sample_data s
 WHERE NOT EXISTS (SELECT 1 FROM clients c WHERE c.email = s.email);

-- Run `npm run seed` after this migration to replace the standard bcrypt placeholders.
INSERT INTO users (login_id, password_hash, role, is_active, must_change_password)
SELECT account_no, '$2b$10$REPLACE_WITH_BCRYPT_HASH',
       'client', TRUE, TRUE
  FROM maybunga_bliss1_samples;

INSERT INTO clients (
  account_no, user_id, branch_code, client_seq, plan_id, name, contact_no, email,
  address, registered_date, due_day, status, status_reason, flagged_date,
  grace_end_date, termination_date, termination_reason, current_balance, created_at
)
SELECT s.account_no, u.user_id, '05', s.client_seq, p.plan_id, s.name, s.contact_no, s.email,
       s.address, s.registered_date, s.due_day, s.status, s.status_reason, s.flagged_date,
       s.grace_end_date, s.termination_date, s.termination_reason, s.current_balance,
       s.registered_date::timestamp AT TIME ZONE 'Asia/Manila'
  FROM maybunga_bliss1_samples s
  JOIN users u ON u.login_id = s.account_no AND u.role = 'client'
  JOIN plans p ON p.plan_name = s.plan_name;

UPDATE clients c
   SET plan_id = p.plan_id,
       name = s.name,
       contact_no = s.contact_no,
       address = s.address,
       registered_date = s.registered_date,
       due_day = s.due_day,
       status = s.status,
       status_reason = s.status_reason,
       flagged_date = s.flagged_date,
       grace_end_date = s.grace_end_date,
       termination_date = s.termination_date,
       termination_reason = s.termination_reason,
       current_balance = s.current_balance
  FROM maybunga_bliss1_sample_data s
  JOIN plans p ON p.plan_name = s.plan_name
 WHERE c.email = s.email AND c.branch_code = '05';

CREATE TEMP TABLE maybunga_bliss1_billing ON COMMIT DROP AS
WITH billing_seed (
  sample_no, billing_month, due_date, amount, amount_paid, balance,
  payment_status, payment_amount, method, payment_type, reference_no, or_no, payment_date
) AS (
  VALUES
    (1, DATE '2026-11-01', DATE '2026-11-25',  799::numeric, 300::numeric,  499::numeric, 'Partially paid', 300::numeric, 'GCash', 'Partial payment', '9000000000001', NULL::text, DATE '2026-11-20'),
    (2, DATE '2026-11-01', DATE '2026-11-10',  999::numeric, 999::numeric,    0::numeric, 'Paid',          999::numeric, 'Cash',  'Full payment',    NULL::text,       'OR-2026-050002', DATE '2026-11-09'),
    (3, DATE '2026-11-01', DATE '2026-11-20', 1299::numeric,   0::numeric, 1299::numeric, 'Unpaid',           0::numeric, NULL::text, NULL::text, NULL::text, NULL::text, NULL::date),
    (4, DATE '2026-11-01', DATE '2026-11-12', 1450::numeric,   0::numeric, 1450::numeric, 'Unpaid',           0::numeric, NULL::text, NULL::text, NULL::text, NULL::text, NULL::date),
    (5, DATE '2026-08-01', DATE '2026-08-25',  799::numeric,   0::numeric,  799::numeric, 'Unpaid',           0::numeric, NULL::text, NULL::text, NULL::text, NULL::text, NULL::date),
    (6, DATE '2026-11-01', DATE '2026-11-30',  999::numeric, 999::numeric,    0::numeric, 'Paid',          999::numeric, 'GCash', 'Full payment',    '9000000000006', NULL::text, DATE '2026-11-24'),
    (7, DATE '2026-11-01', DATE '2026-11-20', 1299::numeric,   0::numeric, 1299::numeric, 'Unpaid',           0::numeric, NULL::text, NULL::text, NULL::text, NULL::text, NULL::date),
    (8, DATE '2026-11-01', DATE '2026-11-12', 1450::numeric,   0::numeric, 1450::numeric, 'Unpaid',           0::numeric, NULL::text, NULL::text, NULL::text, NULL::text, NULL::date),
    (9, DATE '2026-10-01', DATE '2026-10-17',  799::numeric, 799::numeric,    0::numeric, 'Paid',          799::numeric, 'Cash',  'Full payment',    NULL::text,       'OR-2026-050009', DATE '2026-10-19'),
    (10,DATE '2026-11-01', DATE '2026-11-22',  999::numeric, 999::numeric,    0::numeric, 'Paid',          999::numeric, 'GCash', 'Full payment',    '9000000000010', NULL::text, DATE '2026-11-20')
)
SELECT c.account_no, c.client_seq, b.*,
       (b.due_date - INTERVAL '1 month')::date AS issued_date
  FROM maybunga_bliss1_sample_data s
  JOIN clients c ON c.email = s.email AND c.branch_code = '05'
  JOIN billing_seed b ON b.sample_no = s.sample_no;

DELETE FROM payments p
 USING statements old, maybunga_bliss1_billing seed
 WHERE p.statement_id = old.statement_id
   AND old.account_no = seed.account_no
   AND old.billing_month = seed.billing_month;

DELETE FROM statements old
 USING maybunga_bliss1_billing seed
 WHERE old.account_no = seed.account_no
   AND old.billing_month = seed.billing_month;

INSERT INTO statements (
  invoice_no, account_no, billing_month, issued_date, due_date,
  amount, amount_paid, balance, payment_status
)
SELECT 'B1 - ' || TO_CHAR(seed.billing_month, 'YYMM') || ' - ' || LPAD(seed.client_seq::text, 4, '0'),
       seed.account_no, seed.billing_month, seed.issued_date, seed.due_date,
       seed.amount, seed.amount_paid, seed.balance, seed.payment_status
  FROM maybunga_bliss1_billing seed
ON CONFLICT (account_no, billing_month) DO NOTHING;

INSERT INTO payments (
  statement_id, account_no, amount, method, payment_type, reference_no, or_no,
  status, verified_by_staff, verified_at, payment_date, created_at
)
SELECT st.statement_id, seed.account_no, seed.payment_amount, seed.method, seed.payment_type,
       seed.reference_no, seed.or_no, 'Verified', staff.user_id,
       (seed.payment_date::timestamp + INTERVAL '12 hours') AT TIME ZONE 'Asia/Manila',
       seed.payment_date,
       (seed.payment_date::timestamp + INTERVAL '12 hours') AT TIME ZONE 'Asia/Manila'
  FROM maybunga_bliss1_billing seed
  JOIN statements st ON st.account_no = seed.account_no AND st.billing_month = seed.billing_month
  JOIN users staff_user ON staff_user.login_id = 'maybungabliss1' AND staff_user.role = 'staff'
  JOIN staff ON staff.user_id = staff_user.user_id
 WHERE seed.payment_amount > 0;

WITH verified_payments AS (
   SELECT statement_id, SUM(amount) AS amount_paid
     FROM payments
    WHERE status = 'Verified'
    GROUP BY statement_id
), corrected_statements AS (
   SELECT st.statement_id, p.monthly_rate, COALESCE(v.amount_paid, 0) AS amount_paid
     FROM statements st
     JOIN clients c ON c.account_no = st.account_no
     JOIN plans p ON p.plan_id = c.plan_id
     LEFT JOIN verified_payments v ON v.statement_id = st.statement_id
    WHERE c.branch_code = '05'
)
UPDATE statements st
    SET amount = corrected.monthly_rate,
        amount_paid = LEAST(corrected.monthly_rate, corrected.amount_paid),
        balance = GREATEST(corrected.monthly_rate - corrected.amount_paid, 0),
        payment_status = CASE
          WHEN corrected.amount_paid >= corrected.monthly_rate THEN 'Paid'
          WHEN corrected.amount_paid > 0 THEN 'Partially paid'
          ELSE 'Unpaid'
        END
   FROM corrected_statements corrected
  WHERE st.statement_id = corrected.statement_id;

UPDATE clients c
    SET current_balance = COALESCE((
      SELECT SUM(GREATEST(st.amount - st.amount_paid, 0))
        FROM statements st
       WHERE st.account_no = c.account_no
    ), 0)
  WHERE c.branch_code = '05'
    AND c.email IN (SELECT email FROM maybunga_bliss1_sample_data);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM clients WHERE branch_code = '04') THEN
    RAISE EXCEPTION 'Branch 04 must be empty; run database/clear_maybunga_bliss3.sql before this seed migration.';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM maybunga_bliss1_billing seed
      JOIN clients c USING (account_no)
      JOIN statements s ON s.account_no = seed.account_no AND s.billing_month = seed.billing_month
      LEFT JOIN LATERAL (
        SELECT COALESCE(SUM(p.amount), 0) AS verified_paid
          FROM payments p
         WHERE p.statement_id=s.statement_id AND p.status='Verified'
      ) v ON TRUE
     WHERE s.amount_paid <> v.verified_paid
        OR s.balance <> GREATEST(s.amount - v.verified_paid, 0)
        OR c.current_balance <> seed.balance
        OR s.payment_status <> CASE WHEN v.verified_paid >= s.amount THEN 'Paid'
                                    WHEN v.verified_paid > 0 THEN 'Partially paid'
                                    ELSE 'Unpaid' END
  ) THEN
    RAISE EXCEPTION 'Maybunga Bliss 1 sample statements, payments, and balances do not reconcile.';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM clients c
     WHERE c.email LIKE 'fibertec.demo.%@gmail.com'
       AND c.status = 'Terminated'
       AND c.current_balance > 0
       AND NOT EXISTS (
         SELECT 1
           FROM statements s
          WHERE s.account_no = c.account_no
            AND s.payment_status = 'Unpaid'
            AND s.balance > 0
            AND s.due_date < c.termination_date
            AND s.amount > COALESCE((
              SELECT SUM(p.amount) FROM payments p
               WHERE p.statement_id = s.statement_id AND p.status = 'Verified'
            ), 0)
       )
  ) THEN
    RAISE EXCEPTION 'A terminated Maybunga Bliss 1 sample with a balance lacks an overdue unpaid statement.';
  END IF;
END $$;

COMMIT;
