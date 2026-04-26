-- Update idempotency_keys table to support tracking in-flight requests
ALTER TABLE idempotency_keys 
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'completed',
  ALTER COLUMN response_status DROP NOT NULL,
  ALTER COLUMN response_body DROP NOT NULL;

-- Ensure existing records are marked as completed
UPDATE idempotency_keys SET status = 'completed' WHERE response_status IS NOT NULL;

-- Add a comment to explain the status column
COMMENT ON COLUMN idempotency_keys.status IS 'Status of the request: started, completed';
