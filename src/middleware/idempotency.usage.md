# Idempotency Middleware Usage

Use `createIdempotencyMiddleware` on POST/PATCH routes where duplicate submissions must return the same result (payments, transfers, order placement).

## Quick start

```ts
import { Router } from 'express';
import { createIdempotencyMiddleware } from './middleware/idempotency';

const router = Router();
const idempotency = createIdempotencyMiddleware();

router.post('/payments', idempotency, async (req, res) => {
  // Business logic that should run once per key
  res.status(201).json({ paymentId: 'pmt_123', status: 'created' });
});
```

## Request contract

- Clients send a unique `Idempotency-Key` header per logical action.
- If the same key is reused for the same endpoint and body, middleware replays the first stored response.
- If a request with the same key is still running, middleware returns `409 Conflict` with `Idempotency-Status: inflight`.
- If the same key is used for a different request (different method, path, or body), middleware returns `400 Bad Request` to prevent accidental collision.

## Stellar RPC Interaction

- **Retryable Errors**: If a transaction fails due to transient issues (network timeout, 5xx from Horizon), the middleware will *not* cache the response and will release the idempotency key, allowing the client to retry immediately.
- **Permanent Failures**: If a transaction is rejected due to invalid parameters or operational failure (e.g., `op_underfunded`, `tx_bad_auth`), the resulting 4xx error response is cached. Subsequent requests with the same key will receive the same error, preventing redundant calls to the Stellar network.

## Options

- `headerName` (default: `idempotency-key`)
- `methods` (default: `['POST', 'PATCH']`)
- `store` (default: in-memory store)
- `shouldStoreResponse` (default: cache status codes `< 500`)

## Notes for production

- The default store is process-local memory, so it does not deduplicate across instances.
- For multi-instance deployments, implement `IdempotencyStore` using shared storage (Postgres/Redis).
- `src/db/migrations/002_create_idempotency_keys.sql` is included as a table baseline if you want a DB-backed store.
