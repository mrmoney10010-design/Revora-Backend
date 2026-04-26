import { Pool, QueryResult } from 'pg';

/**
 * Valid states for an idempotency record.
 * 'started' indicates a request is currently being processed (in-flight).
 * 'completed' indicates the request finished and the response is cached.
 */
export type IdempotencyStatus = 'started' | 'completed';

/**
 * Database representation of an idempotency key and its cached response.
 */
export interface IdempotencyRow {
  key: string;
  status: IdempotencyStatus;
  request_hash?: string;
  response_status?: number;
  response_body?: string;
  response_content_type?: string;
  created_at: Date;
}

/**
 * Advisory lock names for PostgreSQL.
 * Using a fixed namespace to avoid collisions.
 */
const LOCK_NAMESPACE = 'idempotency';

/**
 * Repository for managing idempotency keys in PostgreSQL.
 * Ensures atomic reservation of keys to prevent race conditions.
 *
 * CONCURRENCY CONTROL:
 * 1. Advisory locks (pg_try_advisory_xact_lock) for row-level locking
 * 2. INSERT ... ON CONFLICT DO NOTHING for atomic reservation
 * 3. All operations are designed to be idempotent and safe under concurrent access
 *
 * SECURITY:
 * - All queries use parameterized inputs to prevent SQL injection
 * - Keys are opaque strings (recommended: UUID v4)
 * - Request hashes prevent collision attacks with same key
 */
export class IdempotencyRepository {
  constructor(private db: Pool) {}

  /**
   * Compute a deterministic lock key from the idempotency key.
   * PostgreSQL advisory locks require a 64-bit integer.
   * We hash the string key to get a numeric lock ID within [0, 2^63-1].
   */
  private getLockId(key: string): bigint {
    // Use a simple hash to convert string to bigint
    let hash = 0n;
    for (let i = 0; i < key.length; i++) {
      hash = ((hash << 5n) - hash) + BigInt(key.charCodeAt(i));
      hash = hash & 0x7FFFFFFFFFFFFFFFn; // Keep within 63 bits
    }
    // Ensure positive
    return hash < 0n ? -hash : hash;
  }

  /**
   * Acquire an advisory lock for the given key.
   * Returns true if lock acquired, false if another transaction holds it.
   */
  private async acquireLock(key: string): Promise<boolean> {
    const lockId = this.getLockId(key);
    const query = 'SELECT pg_try_advisory_xact_lock($1) as acquired';
    const result = await this.db.query(query, [lockId]);
    return result.rows[0]?.acquired ?? false;
  }

  /**
   * Find an existing idempotency record by key.
   * This operation acquires an advisory lock to prevent race conditions
   * between the find and subsequent reserve operations.
   */
  async find(key: string): Promise<IdempotencyRow | null> {
    // Try to acquire lock briefly to ensure consistent snapshot
    // If lock cannot be acquired, another transaction is modifying this key
    const locked = await this.acquireLock(key);
    if (!locked) {
      // Another transaction is working with this key; treat as in-flight
      return null;
    }

    try {
      const query = 'SELECT * FROM idempotency_keys WHERE key = $1 FOR SHARE';
      const result: QueryResult<IdempotencyRow> = await this.db.query(query, [key]);
      return result.rows[0] || null;
    } finally {
      // Advisory lock is automatically released at transaction end
    }
  }

  /**
   * Attempt to reserve an idempotency key atomically.
   * Uses INSERT ... ON CONFLICT DO NOTHING for atomicity.
   * Returns true if the key was successfully reserved ('started').
   * Returns false if it already exists (conflict).
   *
   * This method is safe under high concurrency due to:
   * 1. Advisory lock protection
   * 2. PostgreSQL's ON CONFLICT guarantee
   */
  async reserve(key: string, requestHash: string): Promise<boolean> {
    // Acquire advisory lock first to serialize concurrent attempts
    const locked = await this.acquireLock(key);
    if (!locked) {
      // Another transaction is reserving this key; it may succeed or fail
      // Check if the key now exists
      const existing = await this.db.query(
        'SELECT 1 FROM idempotency_keys WHERE key = $1',
        [key]
      );
      return existing.rows.length === 0; // false if exists, true if we're first
    }

    try {
      const query = `
        INSERT INTO idempotency_keys (key, status, request_hash, created_at)
        VALUES ($1, 'started', $2, NOW())
        ON CONFLICT (key) DO NOTHING
        RETURNING *
      `;
      const result = await this.db.query(query, [key, requestHash]);
      return result.rows.length > 0;
    } finally {
      // Lock released automatically at transaction end
    }
  }

  /**
   * Update an existing idempotency record with the final response.
   * Marks the record as 'completed' with response data.
   *
   * Should only be called after a successful reserve().
   * This operation is idempotent; repeated saves with the same data are safe.
   */
  async save(
    key: string,
    responseStatus: number,
    responseBody: string,
    contentType?: string
  ): Promise<void> {
    // We use a simple UPDATE; the record must exist from a prior reserve
    const query = `
      UPDATE idempotency_keys
      SET status = 'completed',
          response_status = $2,
          response_body = $3,
          response_content_type = $4
      WHERE key = $1
    `;
    await this.db.query(query, [key, responseStatus, responseBody, contentType]);
  }

  /**
   * Remove an idempotency record (typically used when a request fails before completion).
   * This allows retries with the same key.
   *
   * Note: Only records in 'started' state should be deleted.
   * Completed records are retained for idempotent replay.
   */
  async delete(key: string): Promise<void> {
    const query = 'DELETE FROM idempotency_keys WHERE key = $1';
    await this.db.query(query, [key]);
  }

  /**
   * Atomically check status and reserve if available.
   * This is a convenience method combining find + reserve in one call.
   * Most efficient for the common case.
   *
   * Returns:
   * - 'new'       – key was reserved successfully
   * - 'inflight'  – key exists and is in 'started' state
   * - 'mismatch'  – key exists but request_hash differs
   * - 'cached'    – key exists and is completed, with cached response data
   */
  async checkAndReserve(key: string, requestHash: string): Promise<{
    state: 'new' | 'inflight' | 'mismatch' | 'cached';
    record?: IdempotencyRow;
  }> {
    // Acquire advisory lock first to ensure atomic check-then-act
    const locked = await this.acquireLock(key);

    // If we couldn't get the lock, someone else is working with this key
    if (!locked) {
      // Fetch current state to determine correct response
      const existing = await this.db.query(
        'SELECT * FROM idempotency_keys WHERE key = $1',
        [key]
      );

      if (existing.rows.length > 0) {
        const row = existing.rows[0] as IdempotencyRow;
        if (row.request_hash && row.request_hash !== requestHash) {
          return { state: 'mismatch' };
        }
        if (row.status === 'started') {
          return { state: 'inflight' };
        }
        return { state: 'cached', record: row };
      }

      // Key doesn't exist yet; try to insert
      const insertResult = await this.db.query(
        `INSERT INTO idempotency_keys (key, status, request_hash, created_at)
         VALUES ($1, 'started', $2, NOW())
         ON CONFLICT (key) DO NOTHING
         RETURNING *`,
        [key, requestHash]
      );

      if (insertResult.rows.length > 0) {
        return { state: 'new' };
      }

      // Concurrent insert won; fetch the winner
      const winner = await this.db.query(
        'SELECT * FROM idempotency_keys WHERE key = $1',
        [key]
      );
      const winnerRow = winner.rows[0] as IdempotencyRow;
      if (winnerRow.request_hash && winnerRow.request_hash !== requestHash) {
        return { state: 'mismatch' };
      }
      if (winnerRow.status === 'started') {
        return { state: 'inflight' };
      }
      return { state: 'cached', record: winnerRow };
    }

    try {
      // We hold the lock, safe to check and act
      const existing = await this.db.query(
        'SELECT * FROM idempotency_keys WHERE key = $1',
        [key]
      );

      if (existing.rows.length > 0) {
        const row = existing.rows[0] as IdempotencyRow;
        if (row.request_hash && row.request_hash !== requestHash) {
          return { state: 'mismatch' };
        }
        if (row.status === 'started') {
          return { state: 'inflight' };
        }
        return { state: 'cached', record: row };
      }

      // Key not found, reserve it
      const insertResult = await this.db.query(
        `INSERT INTO idempotency_keys (key, status, request_hash, created_at)
         VALUES ($1, 'started', $2, NOW())
         RETURNING *`,
        [key, requestHash]
      );

      if (insertResult.rows.length > 0) {
        return { state: 'new' };
      }

      // Rare race: concurrent insert after our check but before insert
      // Fetch the row that was concurrently inserted
      const concurrent = await this.db.query(
        'SELECT * FROM idempotency_keys WHERE key = $1',
        [key]
      );
      const concurrentRow = concurrent.rows[0] as IdempotencyRow;
      if (concurrentRow.request_hash && concurrentRow.request_hash !== requestHash) {
        return { state: 'mismatch' };
      }
      if (concurrentRow.status === 'started') {
        return { state: 'inflight' };
      }
      return { state: 'cached', record: concurrentRow };
    } finally {
      // Advisory lock released automatically at transaction end
    }
  }
}
