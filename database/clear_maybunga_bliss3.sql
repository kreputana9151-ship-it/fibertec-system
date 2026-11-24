-- Permanently removes all clients and dependent records for Maybunga Bliss 3 (branch 04).
-- Review this target before running; the transaction rolls back if any branch-04 clients remain.
BEGIN;

LOCK TABLE clients, statements, payments, notices, cancellation_requests,
           account_status_log, activity_log, password_resets, users
  IN SHARE ROW EXCLUSIVE MODE;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM branches WHERE branch_code = '04') THEN
    RAISE EXCEPTION 'Branch 04 does not exist.';
  END IF;
END $$;

CREATE TEMP TABLE maybunga_bliss3_accounts ON COMMIT DROP AS
SELECT account_no, user_id
  FROM clients
 WHERE branch_code = '04';

DELETE FROM payments p
 USING maybunga_bliss3_accounts a
 WHERE p.account_no = a.account_no;

DELETE FROM notices n
 USING maybunga_bliss3_accounts a
 WHERE n.account_no = a.account_no;

DELETE FROM cancellation_requests r
 USING maybunga_bliss3_accounts a
 WHERE r.account_no = a.account_no;

DELETE FROM account_status_log h
 USING maybunga_bliss3_accounts a
 WHERE h.account_no = a.account_no;

DELETE FROM statements s
 USING maybunga_bliss3_accounts a
 WHERE s.account_no = a.account_no;

DELETE FROM clients c
 USING maybunga_bliss3_accounts a
 WHERE c.account_no = a.account_no;

DELETE FROM activity_log
 WHERE user_id IN (SELECT user_id FROM maybunga_bliss3_accounts);

DELETE FROM password_resets
 WHERE user_id IN (SELECT user_id FROM maybunga_bliss3_accounts);

DELETE FROM users
 WHERE user_id IN (SELECT user_id FROM maybunga_bliss3_accounts);

DO $$
DECLARE
  remaining_clients BIGINT;
BEGIN
  SELECT COUNT(*) INTO remaining_clients
    FROM clients
   WHERE branch_code = '04';

  IF remaining_clients <> 0 THEN
    RAISE EXCEPTION 'Branch 04 still has % clients; rolling back cleanup.', remaining_clients;
  END IF;

  RAISE NOTICE 'Branch 04 client count after cleanup: %', remaining_clients;
END $$;

SELECT COUNT(*) AS remaining_branch_04_clients
  FROM clients
 WHERE branch_code = '04';

COMMIT;
