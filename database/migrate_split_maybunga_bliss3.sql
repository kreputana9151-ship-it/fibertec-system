-- Run after migrate_login_update.sql on databases seeded with the combined branch.
-- Existing branch-04 clients remain assigned to Bliss 3; new Maybunga clients use branch 07.
BEGIN;

UPDATE branches
   SET name = 'Bliss 3', short_name = 'B3', barangay = 'Maybunga'
 WHERE branch_code = '04' AND name = 'Maybunga Bliss 3';

INSERT INTO branches (branch_code, name, short_name, barangay)
VALUES ('07', 'Maybunga', 'MB', 'Maybunga')
ON CONFLICT (branch_code) DO UPDATE
  SET name = EXCLUDED.name, short_name = EXCLUDED.short_name, barangay = EXCLUDED.barangay;

DO $$
DECLARE
  maybunga_user_id INT;
  bliss3_user_id INT;
  staff_password_hash TEXT;
BEGIN
  IF EXISTS (SELECT 1 FROM users WHERE login_id = 'maybungabliss3')
     AND EXISTS (SELECT 1 FROM users WHERE login_id = 'bliss3') THEN
    RAISE EXCEPTION 'Both maybungabliss3 and bliss3 logins exist; resolve the staff account before splitting branches.';
  END IF;

  UPDATE users SET login_id = 'bliss3' WHERE login_id = 'maybungabliss3';

  SELECT user_id, password_hash
    INTO bliss3_user_id, staff_password_hash
    FROM users WHERE login_id = 'bliss3' AND role = 'staff';
  IF bliss3_user_id IS NULL THEN
    RAISE EXCEPTION 'The Bliss 3 staff login was not found.';
  END IF;

  INSERT INTO users (login_id, password_hash, role, is_active, must_change_password)
  VALUES ('maybunga', staff_password_hash, 'staff', TRUE, TRUE)
  ON CONFLICT (login_id) DO NOTHING;

  SELECT user_id INTO maybunga_user_id
    FROM users WHERE login_id = 'maybunga' AND role = 'staff';
  IF maybunga_user_id IS NULL THEN
    RAISE EXCEPTION 'The Maybunga login already exists with a non-staff role.';
  END IF;

  INSERT INTO staff (user_id, branch_code, full_name)
  VALUES (bliss3_user_id, '04', 'Staff - Bliss 3')
  ON CONFLICT (user_id) DO UPDATE
    SET branch_code = EXCLUDED.branch_code, full_name = EXCLUDED.full_name;

  INSERT INTO staff (user_id, branch_code, full_name)
  VALUES (maybunga_user_id, '07', 'Staff - Maybunga')
  ON CONFLICT (user_id) DO UPDATE
    SET branch_code = EXCLUDED.branch_code, full_name = EXCLUDED.full_name;
END $$;

COMMIT;
