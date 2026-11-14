-- Run ONCE in the Neon SQL Editor (safe to run again). Adds read/unread tracking and notice messages.
ALTER TABLE notices ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ;
ALTER TABLE notices ADD COLUMN IF NOT EXISTS message VARCHAR(400);
