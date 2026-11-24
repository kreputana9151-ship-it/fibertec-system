-- =====================================================================
-- FiberTec Billing Management System - PostgreSQL schema
-- 1) In pgAdmin: right-click Databases > Create > Database > name it "fibertec"
-- 2) Open Query Tool on that database and run this whole file
--    (or psql:  psql -U postgres -d fibertec -f fibertec_schema_postgres.sql)
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Reference tables
-- ---------------------------------------------------------------------
CREATE TABLE branches (
  branch_code CHAR(2)     PRIMARY KEY CHECK (branch_code ~ '^[0-9]{2}$'),
  name        VARCHAR(40) NOT NULL UNIQUE,
  short_name  CHAR(2)     NOT NULL UNIQUE,
  barangay    VARCHAR(40) NOT NULL
);

CREATE TABLE plans (
  plan_id      SMALLINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  plan_name    VARCHAR(40)   NOT NULL UNIQUE,
  monthly_rate NUMERIC(10,2) NOT NULL
);

-- ---------------------------------------------------------------------
-- 2. Login accounts (client / staff / admin)
--    login_id: client = 8-digit account no. (clients can also log in with their email),
--              staff = branch name in lowercase (bagongilog, caniogan, ...), admin = rguerrero
-- ---------------------------------------------------------------------
CREATE TABLE users (
  user_id       INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  login_id      VARCHAR(20)  NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,                -- bcrypt hash, never plain text
  role          VARCHAR(10)  NOT NULL CHECK (role IN ('client','staff','admin')),
  is_active     BOOLEAN      NOT NULL DEFAULT TRUE,
  must_change_password BOOLEAN NOT NULL DEFAULT FALSE,   -- TRUE after the owner resets a password
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- "Forgot password" links for clients (only a hash of the token is stored)
CREATE TABLE password_resets (
  reset_id   INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    INT NOT NULL REFERENCES users(user_id),
  token_hash CHAR(64) NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at    TIMESTAMPTZ
);

CREATE TABLE admins (
  user_id   INT PRIMARY KEY REFERENCES users(user_id),
  full_name VARCHAR(80) NOT NULL
);

-- one staff per branch (UNIQUE on branch_code)
CREATE TABLE staff (
  user_id     INT PRIMARY KEY REFERENCES users(user_id),
  branch_code CHAR(2) NOT NULL UNIQUE REFERENCES branches(branch_code),
  full_name   VARCHAR(80) NOT NULL
);

-- ---------------------------------------------------------------------
-- 3. Clients
--    account_no = branch code (2) + year registered YY (2) + client no. (4)
--    e.g. 04260042 = Maybunga Bliss 3, registered 2026, client #42
--         05260042 = Maybunga Bliss 1, registered 2026, client #42
-- ---------------------------------------------------------------------
CREATE TABLE clients (
  account_no         CHAR(8)  PRIMARY KEY,
  user_id            INT      NOT NULL UNIQUE REFERENCES users(user_id),
  branch_code        CHAR(2)  NOT NULL REFERENCES branches(branch_code),
  client_seq         SMALLINT NOT NULL CHECK (client_seq BETWEEN 1 AND 9999),
  plan_id            SMALLINT NOT NULL REFERENCES plans(plan_id),
  name               VARCHAR(100) NOT NULL,
  contact_no         VARCHAR(15)  NOT NULL,
  email              VARCHAR(100) NOT NULL,
  address            VARCHAR(255) NOT NULL,
  facebook           VARCHAR(100),
  router_location    VARCHAR(150),
  registered_date    DATE     NOT NULL,
  due_day            SMALLINT NOT NULL CHECK (due_day BETWEEN 1 AND 31),
  status             VARCHAR(15) NOT NULL DEFAULT 'Active'
                     CHECK (status IN ('Active','Grace Period','Under Review','Terminated')),
  status_reason      VARCHAR(60),
  flagged_date       DATE,
  grace_end_date     DATE,
  termination_date   DATE,
  termination_reason VARCHAR(60),
  current_balance    NUMERIC(10,2) NOT NULL DEFAULT 0,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (branch_code, client_seq),
  CONSTRAINT chk_account_format CHECK (
    account_no ~ '^[0-9]{8}$'
    AND substring(account_no, 1, 2) = branch_code
    AND substring(account_no, 3, 2) = lpad((EXTRACT(YEAR FROM registered_date)::int % 100)::text, 2, '0')
    AND substring(account_no, 5, 4) = lpad(client_seq::text, 4, '0')
  )
);

-- every status change (Active -> Grace Period -> Under Review -> Terminated)
CREATE TABLE account_status_log (
  log_id     INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_no CHAR(8) NOT NULL REFERENCES clients(account_no),
  old_status VARCHAR(20),
  new_status VARCHAR(20) NOT NULL,
  reason     VARCHAR(100),
  changed_by INT REFERENCES users(user_id),          -- NULL = system
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- 4. Billing statements (stored, one per client per month)
-- ---------------------------------------------------------------------
CREATE TABLE statements (
  statement_id   INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  invoice_no     VARCHAR(20)   NOT NULL UNIQUE,      -- e.g. B1 - 2610 - 1001
  account_no     CHAR(8)       NOT NULL REFERENCES clients(account_no),
  billing_month  DATE          NOT NULL,             -- first day of month, e.g. 2026-10-01
  bill_date      DATE          NOT NULL,             -- due date minus 7 days
  due_date       DATE          NOT NULL,
  amount         NUMERIC(10,2) NOT NULL,
  amount_paid    NUMERIC(10,2) NOT NULL DEFAULT 0,
  balance        NUMERIC(10,2) NOT NULL,
  payment_status VARCHAR(15)   NOT NULL DEFAULT 'Unpaid'
                 CHECK (payment_status IN ('Unpaid','Partially paid','Paid')),
  send_status    VARCHAR(15)   NOT NULL DEFAULT 'Not Yet Sent'
                 CHECK (send_status IN ('Not Yet Sent','Delivered','Failed')),
  sent_by_admin  INT REFERENCES admins(user_id),
  sent_at        TIMESTAMPTZ,
  created_at     TIMESTAMPTZ   NOT NULL DEFAULT now(),
  UNIQUE (account_no, billing_month)
);

-- ---------------------------------------------------------------------
-- 5. Payments / receipts (GCash-PayMongo and Cash)
-- ---------------------------------------------------------------------
CREATE TABLE payments (
  payment_id          INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  statement_id        INT           NOT NULL REFERENCES statements(statement_id),
  account_no          CHAR(8)       NOT NULL REFERENCES clients(account_no),
  amount              NUMERIC(10,2) NOT NULL,
  method              VARCHAR(5)    NOT NULL CHECK (method IN ('GCash','Cash')),
  payment_type        VARCHAR(15)   NOT NULL DEFAULT 'Full payment'
                      CHECK (payment_type IN ('Full payment','Partial payment')),
  reference_no        VARCHAR(20),                   -- 13-digit GCash reference
  or_no               VARCHAR(20),                   -- official receipt, issued once verified
  status              VARCHAR(10)   NOT NULL DEFAULT 'Pending'
                      CHECK (status IN ('Pending','Verified','Rejected')),
  verified_by_staff   INT REFERENCES staff(user_id),
  verified_at         TIMESTAMPTZ,
  paymongo_payment_id VARCHAR(60),                   -- filled later when PayMongo is connected
  paymongo_status     VARCHAR(30),
  payment_date        DATE          NOT NULL,
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- 6. Notices (email + bell notifications)
-- ---------------------------------------------------------------------
CREATE TABLE notices (
  notice_id       INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_no      CHAR(8)      NOT NULL REFERENCES clients(account_no),
  statement_id    INT REFERENCES statements(statement_id),
  notice_date     DATE         NOT NULL,
  channel         VARCHAR(20)  NOT NULL CHECK (channel IN ('Email','Portal Notification')),
  recipient       VARCHAR(100) NOT NULL,
  notice_type     VARCHAR(25)  NOT NULL
                  CHECK (notice_type IN ('7-Day Billing Notice','Disconnection Warning','System Notice','Payment Receipt')),
  delivery_status VARCHAR(10)  NOT NULL DEFAULT 'Pending' CHECK (delivery_status IN ('Pending','Sent','Failed')),
  resent_by_admin INT REFERENCES admins(user_id),
  message         VARCHAR(400),                -- text shown in the portal bell / email
  read_at         TIMESTAMPTZ,                 -- NULL = client has not read it yet
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- 7. Cancellation requests (client -> staff -> admin review)
-- ---------------------------------------------------------------------
CREATE TABLE cancellation_requests (
  request_id       INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_no       CHAR(8)      NOT NULL REFERENCES clients(account_no),
  request_date     DATE         NOT NULL,
  reason           VARCHAR(150) NOT NULL,
  status           VARCHAR(10)  NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending','Approved','Rejected')),
  decided_by_staff INT REFERENCES staff(user_id),
  decided_at       TIMESTAMPTZ,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- 8. Activity / audit log (staff and admin actions)
-- ---------------------------------------------------------------------
CREATE TABLE activity_log (
  log_id      INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     INT NOT NULL REFERENCES users(user_id),
  branch_code CHAR(2) REFERENCES branches(branch_code),   -- NULL for non-branch admin actions
  description VARCHAR(255) NOT NULL,
  logged_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- helpful indexes for the common lookups
CREATE INDEX idx_clients_branch    ON clients(branch_code);
CREATE INDEX idx_payments_account  ON payments(account_no, payment_date);
CREATE INDEX idx_payments_status   ON payments(status);
CREATE INDEX idx_payments_queue    ON payments(status, created_at, payment_id) WHERE status = 'Pending';   -- FIFO queue lookup
CREATE INDEX idx_statements_acct   ON statements(account_no, billing_month);
CREATE INDEX idx_notices_account   ON notices(account_no, notice_date);

-- ---------------------------------------------------------------------
-- 9. History retention
--    Client portal : shows only the last 3 months of receipts/statements/notices
--    Admin portal  : keeps and shows the last 6 months
--    Anything older than 6 months is deleted by purge_old_records()
-- ---------------------------------------------------------------------

-- what the CLIENT is allowed to see (API: SELECT ... WHERE account_no = <logged-in client>)
CREATE VIEW v_client_payments AS
  SELECT * FROM payments
  WHERE payment_date >= (date_trunc('month', current_date) - interval '3 months')::date;

CREATE VIEW v_client_statements AS
  SELECT * FROM statements
  WHERE billing_month >= (date_trunc('month', current_date) - interval '3 months')::date;

CREATE VIEW v_client_notices AS
  SELECT * FROM notices
  WHERE notice_date >= (date_trunc('month', current_date) - interval '3 months')::date;

-- real deletion (run daily, e.g. node-cron in the API, or pg_cron if available)
CREATE OR REPLACE FUNCTION purge_old_records() RETURNS void AS $$
DECLARE
  cutoff DATE := (date_trunc('month', current_date) - interval '6 months')::date;
BEGIN
  DELETE FROM notices  WHERE notice_date  < cutoff;
  DELETE FROM payments WHERE payment_date < cutoff;
  -- statements last, and only when no remaining payment/notice still points to them
  DELETE FROM statements s
   WHERE s.billing_month < cutoff
     AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.statement_id = s.statement_id)
     AND NOT EXISTS (SELECT 1 FROM notices  n WHERE n.statement_id = s.statement_id);
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------
-- 10. Starter data
-- ---------------------------------------------------------------------
INSERT INTO branches (branch_code, name, short_name, barangay) VALUES
  ('01', 'Bagong Ilog',      'BI', 'Bagong Ilog'),
  ('02', 'Caniogan',         'CN', 'Caniogan'),
  ('03', 'Palatiw',          'PT', 'Palatiw'),
  ('04', 'Maybunga Bliss 3', 'B3', 'Maybunga'),
  ('05', 'Maybunga Bliss 1', 'B1', 'Maybunga'),
  ('06', 'Nagpayong',        'NP', 'Nagpayong');

INSERT INTO plans (plan_name, monthly_rate) VALUES
  ('LiteSpeed 50Mbps',  799.00),
  ('Turbo 110 Mbps',    999.00),
  ('Elite 150 Mbps',   1299.00),
  ('Premium 220 Mbps', 1450.00);

-- NOTE: replace the placeholder hash with a real bcrypt hash made by the backend
-- (the API seed script will do this). Never store plain-text passwords.
INSERT INTO users (login_id, password_hash, role) VALUES
  ('rguerrero',      '$2b$10$REPLACE_WITH_BCRYPT_HASH', 'admin'),
  ('bagongilog',     '$2b$10$REPLACE_WITH_BCRYPT_HASH', 'staff'),
  ('caniogan',       '$2b$10$REPLACE_WITH_BCRYPT_HASH', 'staff'),
  ('palatiw',        '$2b$10$REPLACE_WITH_BCRYPT_HASH', 'staff'),
  ('maybungabliss3', '$2b$10$REPLACE_WITH_BCRYPT_HASH', 'staff'),
  ('maybungabliss1', '$2b$10$REPLACE_WITH_BCRYPT_HASH', 'staff'),
  ('nagpayong',      '$2b$10$REPLACE_WITH_BCRYPT_HASH', 'staff');

INSERT INTO admins (user_id, full_name)
  SELECT user_id, 'Ramon Guerrero' FROM users WHERE login_id = 'rguerrero';

-- one staff login per branch, named after the branch
INSERT INTO staff (user_id, branch_code, full_name)
  SELECT u.user_id, b.branch_code, 'Staff - ' || b.name
    FROM (VALUES ('bagongilog','01'),('caniogan','02'),('palatiw','03'),
                 ('maybungabliss3','04'),('maybungabliss1','05'),('nagpayong','06')) m(login_id, branch_code)
    JOIN users u ON u.login_id = m.login_id
    JOIN branches b ON b.branch_code = m.branch_code;
