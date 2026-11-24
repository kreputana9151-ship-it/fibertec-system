BEGIN;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS failed_login_attempts SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS login_locked_until TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname='chk_users_failed_login_attempts'
       AND conrelid='users'::regclass
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT chk_users_failed_login_attempts
      CHECK (failed_login_attempts BETWEEN 0 AND 5);
  END IF;
END;
$$;

CREATE SEQUENCE IF NOT EXISTS official_receipt_seq;

WITH ranked AS (
  SELECT payment_id,
         ROW_NUMBER() OVER (PARTITION BY account_no ORDER BY created_at, payment_id) AS position
    FROM payments
   WHERE status='Pending'
)
UPDATE payments p
   SET status='Rejected',
       verified_at=COALESCE(p.verified_at, now())
  FROM ranked r
 WHERE p.payment_id=r.payment_id AND r.position > 1;

WITH ranked AS (
  SELECT request_id,
         ROW_NUMBER() OVER (PARTITION BY account_no ORDER BY created_at, request_id) AS position
    FROM cancellation_requests
   WHERE status='Pending'
)
UPDATE cancellation_requests r
   SET status='Rejected',
       decided_at=COALESCE(r.decided_at, now())
  FROM ranked d
 WHERE r.request_id=d.request_id AND d.position > 1;

WITH ranked AS (
  SELECT payment_id,
         ROW_NUMBER() OVER (
           PARTITION BY reference_no
           ORDER BY CASE status WHEN 'Verified' THEN 0 ELSE 1 END, created_at, payment_id
         ) AS position
    FROM payments
   WHERE method='GCash'
     AND status IN ('Pending','Verified')
     AND reference_no IS NOT NULL
)
UPDATE payments p
   SET status=CASE WHEN p.status='Pending' THEN 'Rejected' ELSE p.status END,
       verified_at=CASE WHEN p.status='Pending' THEN COALESCE(p.verified_at, now()) ELSE p.verified_at END,
       reference_no=CASE WHEN p.status='Pending' THEN p.reference_no ELSE NULL END
  FROM ranked r
 WHERE p.payment_id=r.payment_id AND r.position > 1;

WITH ranked AS (
  SELECT payment_id,
         ROW_NUMBER() OVER (
           PARTITION BY or_no
           ORDER BY CASE status WHEN 'Verified' THEN 0 ELSE 1 END,
                    verified_at NULLS LAST, payment_id
         ) AS position
    FROM payments
   WHERE or_no IS NOT NULL
)
UPDATE payments p
   SET or_no=NULL
  FROM ranked r
 WHERE p.payment_id=r.payment_id AND r.position > 1;

SELECT setval(
  'official_receipt_seq',
  GREATEST(
    1,
    COALESCE((
      SELECT MAX(substring(or_no FROM '^OR-[0-9]{4}-([0-9]+)$')::BIGINT)
        FROM payments
       WHERE or_no ~ '^OR-[0-9]{4}-[0-9]+$'
    ), 0),
    (SELECT last_value FROM official_receipt_seq)
  ),
  TRUE
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_or_no
  ON payments(or_no) WHERE or_no IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_gcash_reference_active
  ON payments(reference_no)
  WHERE method='GCash' AND status IN ('Pending','Verified') AND reference_no IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_one_pending_per_account
  ON payments(account_no) WHERE status='Pending';
CREATE UNIQUE INDEX IF NOT EXISTS uq_cancellations_one_pending_per_account
  ON cancellation_requests(account_no) WHERE status='Pending';

COMMIT;
