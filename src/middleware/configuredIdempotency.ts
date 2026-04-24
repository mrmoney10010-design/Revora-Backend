import { createIdempotencyMiddleware, PostgresIdempotencyStore } from './idempotency';
import { IdempotencyRepository } from '../db/repositories/idempotencyRepository';
import { pool } from '../db/pool';

/**
 * Pre-configured idempotency middleware using the central PostgreSQL pool.
 * 
 * Interacts safely with Stellar RPC responses:
 * - `< 500`: Resolves or permanent failures (4xx) are cached.
 * - `>= 500`: Transient network/Horizon failures are NOT cached, allowing immediate retries.
 */
export const requireIdempotency = createIdempotencyMiddleware({
  store: new PostgresIdempotencyStore(new IdempotencyRepository(pool)),
  shouldStoreResponse: (statusCode) => statusCode < 500
});
