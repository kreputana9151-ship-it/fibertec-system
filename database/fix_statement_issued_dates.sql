-- Rename the legacy issue-date column and align existing cycles to one month before due_date.
BEGIN;

DO $$
DECLARE
  has_issued_date BOOLEAN;
  has_bill_date BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'statements'
       AND column_name = 'issued_date'
  ) INTO has_issued_date;
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'statements'
       AND column_name = 'bill_date'
  ) INTO has_bill_date;

  IF NOT has_issued_date AND has_bill_date THEN
    ALTER TABLE statements RENAME COLUMN bill_date TO issued_date;
  ELSIF NOT has_issued_date THEN
    RAISE EXCEPTION 'Neither statements.issued_date nor legacy statements.bill_date exists.';
  END IF;
END $$;

UPDATE statements
   SET issued_date = (due_date - INTERVAL '1 month')::date;

ALTER TABLE statements ALTER COLUMN issued_date SET NOT NULL;

DROP VIEW IF EXISTS v_client_statements;
CREATE VIEW v_client_statements AS
  SELECT * FROM statements;

COMMIT;
