-- Run ONCE in pgAdmin (Query Tool on the "fibertec" database) if you already ran the old schema.sql.
-- Keeps all your data; only renames the staff/admin logins and adds the new password-reset pieces.
ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS password_resets (
  reset_id   INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    INT NOT NULL REFERENCES users(user_id),
  token_hash CHAR(64) NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at    TIMESTAMPTZ
);

UPDATE users SET login_id = CASE login_id
    WHEN 'admin01' THEN 'rguerrero'
    WHEN 'staff01' THEN 'bagongilog'
    WHEN 'staff02' THEN 'caniogan'
    WHEN 'staff03' THEN 'palatiw'
    WHEN 'staff04' THEN 'maybunga'
    WHEN 'staff05' THEN 'bliss1'
    WHEN 'staff06' THEN 'nagpayong' END
 WHERE login_id IN ('admin01','staff01','staff02','staff03','staff04','staff05','staff06');

UPDATE admins SET full_name = 'Ramon Guerrero'
 WHERE user_id = (SELECT user_id FROM users WHERE login_id = 'rguerrero');

-- FIFO payments queue
CREATE INDEX IF NOT EXISTS idx_payments_queue ON payments(status, created_at, payment_id) WHERE status = 'Pending';
