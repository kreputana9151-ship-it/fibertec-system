BEGIN;

CREATE TABLE IF NOT EXISTS password_reset_requests (
  id           INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_no   CHAR(8) NOT NULL REFERENCES clients(account_no),
  client_name  VARCHAR(100) NOT NULL,
  status       VARCHAR(10) NOT NULL DEFAULT 'Pending'
               CHECK (status IN ('Pending','Resolved')),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at  TIMESTAMPTZ,
  resolved_by  INT REFERENCES users(user_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_password_reset_requests_one_pending_per_account
  ON password_reset_requests(account_no) WHERE status='Pending';

COMMIT;
