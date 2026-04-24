import { NextFunction, Request, RequestHandler, Response } from 'express';
import { createHash } from 'crypto';
import { Errors } from '../lib/errors';
import { IdempotencyRepository } from '../db/repositories/idempotencyRepository';

/**
 * Cached response data.
 */
export interface IdempotencyRecord {
  status: number;
  body: string;
  contentType?: string;
  createdAt: Date;
}

export type IdempotencyCheckResult =
  | { state: 'new' }
  | { state: 'inflight' }
  | { state: 'mismatch' }
  | { state: 'cached'; record: IdempotencyRecord };

/**
 * Interface for idempotency storage backends.
 */
export interface IdempotencyStore {
  checkAndReserve(key: string, requestHash: string): Promise<IdempotencyCheckResult>;
  save(key: string, record: IdempotencyRecord): Promise<void>;
  release(key: string): Promise<void>;
}

/**
 * PostgreSQL-backed idempotency store.
 */
export class PostgresIdempotencyStore implements IdempotencyStore {
  constructor(private readonly repository: IdempotencyRepository) {}

  async checkAndReserve(key: string, requestHash: string): Promise<IdempotencyCheckResult> {
    const existing = await this.repository.find(key);

    if (!existing) {
      const reserved = await this.repository.reserve(key, requestHash);
      return reserved ? { state: 'new' } : { state: 'inflight' };
    }

    // Check for request mismatch
    if (existing.request_hash && existing.request_hash !== requestHash) {
      return { state: 'mismatch' };
    }

    if (existing.status === 'started') {
      return { state: 'inflight' };
    }

    return {
      state: 'cached',
      record: {
        status: existing.response_status!,
        body: existing.response_body!,
        contentType: existing.response_content_type,
        createdAt: existing.created_at,
      },
    };
  }

  async save(key: string, record: IdempotencyRecord): Promise<void> {
    await this.repository.save(
      key,
      record.status,
      record.body,
      record.contentType
    );
  }

  async release(key: string): Promise<void> {
    await this.repository.delete(key);
  }
}

/**
 * Simple in-memory store for development or testing.
 */
export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly records = new Map<
    string,
    { record: IdempotencyRecord; expiresAt?: number }
  >();
  private readonly inFlight = new Set<string>();
  private readonly ttlMs?: number;

  constructor(options: { ttlMs?: number } = {}) {
    this.ttlMs = options.ttlMs;
  }

  async checkAndReserve(key: string, requestHash: string): Promise<IdempotencyCheckResult> {
    this.pruneExpired(key);

    const cached = this.records.get(key);
    if (cached) {
      if ((cached as any).requestHash !== requestHash) return { state: 'mismatch' };
      return { state: 'cached', record: cached.record };
    }

    if (this.inFlight.has(key)) {
      const inFlightHash = (this as any).inFlightHashes?.get(key);
      if (inFlightHash && inFlightHash !== requestHash) return { state: 'mismatch' };
      return { state: 'inflight' };
    }

    this.inFlight.add(key);
    if (!(this as any).inFlightHashes) (this as any).inFlightHashes = new Map<string, string>();
    (this as any).inFlightHashes.set(key, requestHash);
    return { state: 'new' };
  }

  async save(key: string, record: IdempotencyRecord): Promise<void> {
    const hash = (this as any).inFlightHashes?.get(key);
    this.inFlight.delete(key);
    (this as any).inFlightHashes?.delete(key);
    const expiresAt = this.ttlMs ? Date.now() + this.ttlMs : undefined;
    this.records.set(key, { record, expiresAt, requestHash: hash } as any);
  }

  async release(key: string): Promise<void> {
    this.inFlight.delete(key);
    (this as any).inFlightHashes?.delete(key);
  }

  private pruneExpired(key: string): void {
    const entry = this.records.get(key);
    if (!entry?.expiresAt) return;
    if (Date.now() >= entry.expiresAt) this.records.delete(key);
  }
}

export interface IdempotencyMiddlewareOptions {
  store?: IdempotencyStore;
  headerName?: string;
  methods?: string[];
  shouldStoreResponse?: (statusCode: number) => boolean;
}

const DEFAULT_METHODS = ['POST', 'PATCH'];
const DEFAULT_HEADER = 'idempotency-key';

function logIdempotency(data: Record<string, unknown>) {
  console.log(
    JSON.stringify({
      type: 'idempotency',
      timestamp: new Date().toISOString(),
      ...data,
    })
  );
}

function toHeaderString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.length > 0) return String(value[0]);
  return undefined;
}

function serializeBody(payload: unknown): string {
  if (Buffer.isBuffer(payload)) return payload.toString('utf-8');
  if (typeof payload === 'string') return payload;
  if (payload === undefined || payload === null) return '';
  return JSON.stringify(payload);
}

/**
 * Generates a stable SHA-256 hash of the request.
 */
function generateRequestHash(req: Request): string {
  const hash = createHash('sha256');
  hash.update(req.method.toUpperCase());
  hash.update(req.path);
  
  // Hash the body if present
  if (req.body) {
    const bodyStr = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    hash.update(bodyStr);
  }
  
  return hash.digest('hex');
}

function replayResponse(res: Response, record: IdempotencyRecord): void {
  res.setHeader('Idempotency-Status', 'cached');
  if (record.contentType) res.setHeader('Content-Type', record.contentType);

  const contentType = (record.contentType ?? '').toLowerCase();
  if (contentType.includes('application/json')) {
    try {
      const parsed = record.body === '' ? null : JSON.parse(record.body);
      res.status(record.status).json(parsed);
      return;
    } catch {
      // Fallback if parsing fails
    }
  }

  res.status(record.status).send(record.body);
}

/**
 * Creates middleware to handle idempotency for mutation requests.
 */
export function createIdempotencyMiddleware(
  options: IdempotencyMiddlewareOptions = {}
): RequestHandler {
  const store = options.store ?? new InMemoryIdempotencyStore();
  const headerName = (options.headerName ?? DEFAULT_HEADER).toLowerCase();
  const methods = new Set(
    (options.methods ?? DEFAULT_METHODS).map((m) => m.toUpperCase())
  );
  const shouldStoreResponse =
    options.shouldStoreResponse ?? ((status) => status < 500);

  return async (req: Request, res: Response, next: NextFunction) => {
    if (!methods.has(req.method.toUpperCase())) {
      return next();
    }

    const key = req.get(headerName)?.trim();
    if (!key) {
      return next();
    }

    try {
      const requestHash = generateRequestHash(req);
      const checkResult = await store.checkAndReserve(key, requestHash);

      if (checkResult.state === 'mismatch') {
        logIdempotency({ key, state: 'mismatch', path: req.path, method: req.method });
        return next(
          Errors.badRequest('Idempotency key mismatch: this key was previously used for a different request.')
        );
      }

      if (checkResult.state === 'cached') {
        logIdempotency({ key, state: 'cached', path: req.path, method: req.method });
        replayResponse(res, checkResult.record);
        return;
      }

      if (checkResult.state === 'inflight') {
        logIdempotency({ key, state: 'inflight', path: req.path, method: req.method });
        res.setHeader('Idempotency-Status', 'inflight');
        return next(
          Errors.conflict('A request with this idempotency key is already in progress.')
        );
      }

      logIdempotency({ key, state: 'new', path: req.path, method: req.method, hash: requestHash });

      // Hijack response methods to capture the body
      let responseBody = '';
      const originalJson = res.json.bind(res);
      const originalSend = res.send.bind(res);

      res.json = (payload: unknown) => {
        responseBody = JSON.stringify(payload ?? null);
        return originalJson(payload);
      };

      res.send = (payload: unknown) => {
        responseBody = serializeBody(payload);
        return originalSend(payload as any);
      };

      let completed = false;
      const cleanup = async () => {
        if (completed) return;
        completed = true;
        
        if (shouldStoreResponse(res.statusCode)) {
          const record: IdempotencyRecord = {
            status: res.statusCode,
            body: responseBody,
            contentType: toHeaderString(res.getHeader('content-type')),
            createdAt: new Date(),
          };
          await store.save(key, record).catch((err) => {
             console.error('Failed to save idempotency record:', err);
          });
          logIdempotency({ key, state: 'saved', status: res.statusCode });
        } else {
          await store.release(key).catch((err) => {
             console.error('Failed to release idempotency key:', err);
          });
          logIdempotency({ key, state: 'released', status: res.statusCode });
        }
      };

      res.once('finish', cleanup);
      res.once('close', cleanup);

      next();
    } catch (err) {
      console.error('Idempotency middleware error:', err);
      // On internal error, we allow the request to proceed without idempotency
      // to avoid blocking clients due to infra issues.
      next();
    }
  };
}
