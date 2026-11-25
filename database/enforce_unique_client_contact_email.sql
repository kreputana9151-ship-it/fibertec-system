BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM clients
     GROUP BY BTRIM(contact_no)
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot enforce unique client contact numbers until duplicate normalized contact_no values are resolved.';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM clients
     GROUP BY LOWER(BTRIM(email))
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot enforce unique client emails until duplicate normalized email values are resolved.';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_clients_contact_no_normalized
  ON clients (BTRIM(contact_no));
CREATE UNIQUE INDEX IF NOT EXISTS uq_clients_email_normalized
  ON clients (LOWER(BTRIM(email)));

COMMIT;
