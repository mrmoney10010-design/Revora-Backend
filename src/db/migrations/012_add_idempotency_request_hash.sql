-- Add request_hash column to idempotency_keys table
-- This allows validating that repeated requests with the same key have the same intent.

ALTER TABLE idempotency_keys 
  ADD COLUMN IF NOT EXISTS request_hash TEXT;

-- Add a comment to explain the request_hash column
COMMENT ON COLUMN idempotency_keys.request_hash IS 'Hash of the request (method, path, body) to detect collisions';

-- Create an index to help with lookups if we ever need to query by hash
CREATE INDEX IF NOT EXISTS idx_idempotency_keys_request_hash ON idempotency_keys (request_hash);
