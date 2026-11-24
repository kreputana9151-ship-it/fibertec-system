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

CREATE TEMP TABLE maybunga_bliss1_samples ON COMMIT DROP AS
WITH sample_data (
  sample_no, name, contact_no, email, address, plan_name, registered_date,
  due_day, status, status_reason, flagged_date, grace_end_date,
  termination_date, termination_reason, current_balance
) AS (
  VALUES
    (1, 'Amelia Santos', '09980000001', 'maybunga.bliss1.sample01@example.com', 'Block 1 Lot 4, Maybunga Bliss 1, Maybunga, Pasig City', 'LiteSpeed 50Mbps', DATE '2025-01-14', 5,  'Active',       NULL, NULL::date, NULL::date, NULL::date, NULL, 0::numeric),
    (2, 'Rafael Dizon',  '09980000002', 'maybunga.bliss1.sample02@example.com', 'Block 2 Lot 8, Maybunga Bliss 1, Maybunga, Pasig City', 'Turbo 110 Mbps', DATE '2025-04-22', 10, 'Active',       NULL, NULL::date, NULL::date, NULL::date, NULL, 0::numeric),
    (3, 'Isabel Navarro','09980000003', 'maybunga.bliss1.sample03@example.com', 'Block 3 Lot 2, Maybunga Bliss 1, Maybunga, Pasig City', 'Elite 150 Mbps', DATE '2025-08-09', 15, 'Grace Period', 'Unpaid after due date', NULL::date, DATE '2026-11-30', NULL::date, NULL, 1598::numeric),
    (4, 'Miguel Bautista','09980000004','maybunga.bliss1.sample04@example.com', 'Block 4 Lot 6, Maybunga Bliss 1, Maybunga, Pasig City', 'Premium 220 Mbps', DATE '2025-11-18', 20, 'Under Review', 'Flagged for account review', DATE '2026-11-10', NULL::date, NULL::date, NULL, 1450::numeric),
    (5, 'Clara Reyes',   '09980000005', 'maybunga.bliss1.sample05@example.com', 'Block 5 Lot 1, Maybunga Bliss 1, Maybunga, Pasig City', 'LiteSpeed 50Mbps', DATE '2025-12-03', 25, 'Terminated',   'Non-payment', NULL::date, NULL::date, DATE '2026-09-12', 'Non-payment', 799::numeric),
    (6, 'Mateo Cruz',    '09980000006', 'maybunga.bliss1.sample06@example.com', 'Block 6 Lot 9, Maybunga Bliss 1, Maybunga, Pasig City', 'Turbo 110 Mbps', DATE '2026-01-17', 30, 'Active',       NULL, NULL::date, NULL::date, NULL::date, NULL, 0::numeric),
    (7, 'Sofia Mendoza', '09980000007', 'maybunga.bliss1.sample07@example.com', 'Block 7 Lot 3, Maybunga Bliss 1, Maybunga, Pasig City', 'Elite 150 Mbps', DATE '2026-03-26', 7,  'Grace Period', 'Unpaid after due date', NULL::date, DATE '2026-11-28', NULL::date, NULL, 2598::numeric),
    (8, 'Lucas Torres',  '09980000008', 'maybunga.bliss1.sample08@example.com', 'Block 8 Lot 5, Maybunga Bliss 1, Maybunga, Pasig City', 'Premium 220 Mbps', DATE '2026-05-08', 12, 'Under Review', 'Flagged for account review', DATE '2026-11-15', NULL::date, NULL::date, NULL, 1450::numeric),
    (9, 'Nina Ramos',    '09980000009', 'maybunga.bliss1.sample09@example.com', 'Block 9 Lot 7, Maybunga Bliss 1, Maybunga, Pasig City', 'LiteSpeed 50Mbps', DATE '2026-06-19', 17, 'Terminated',   'Client cancellation', NULL::date, NULL::date, DATE '2026-10-21', 'Client cancellation', 0::numeric),
    (10,'Gabriel Flores','09980000010', 'maybunga.bliss1.sample10@example.com', 'Block 10 Lot 2, Maybunga Bliss 1, Maybunga, Pasig City', 'Turbo 110 Mbps', DATE '2026-08-24', 22, 'Active',       NULL, NULL::date, NULL::date, NULL::date, NULL, 0::numeric)
),
branch_seq AS (
  SELECT COALESCE(MAX(client_seq), 0) AS max_seq
    FROM clients WHERE branch_code = '05'
)
SELECT ('05' || TO_CHAR(s.registered_date, 'YY') || LPAD((b.max_seq + s.sample_no)::text, 4, '0')) AS account_no,
       (b.max_seq + s.sample_no)::smallint AS client_seq,
       s.*
  FROM sample_data s CROSS JOIN branch_seq b
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

COMMIT;
