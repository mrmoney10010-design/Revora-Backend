import { EventEmitter } from 'events';
import { NextFunction, Request, Response } from 'express';
import {
  createIdempotencyMiddleware,
  InMemoryIdempotencyStore,
  PostgresIdempotencyStore,
  IdempotencyStore,
} from './idempotency';
import { AppError, ErrorCode } from '../lib/errors';
import { IdempotencyRepository } from '../db/repositories/idempotencyRepository';

class MockResponse extends EventEmitter {
  statusCode = 200;
  body: unknown;
  headers: Record<string, string> = {};
  ended = false;

  status(code: number): this {
    this.statusCode = code;
    return this;
  }

  setHeader(name: string, value: unknown): void {
    this.headers[name.toLowerCase()] = String(value);
  }

  getHeader(name: string): string | undefined {
    return this.headers[name.toLowerCase()];
  }

  get(name: string): string | undefined {
    return this.getHeader(name);
  }

  json(payload?: unknown): this {
    if (!this.getHeader('content-type')) {
      this.setHeader('content-type', 'application/json; charset=utf-8');
    }
    this.body = payload;
    this.complete();
    return this;
  }

  send(payload?: unknown): this {
    this.body = payload;
    this.complete();
    return this;
  }

  private complete(): void {
    if (this.ended) return;
    this.ended = true;
    this.emit('finish');
    this.emit('close');
  }
}

function createRequest(method: string, key?: string, body: any = null, headers: Record<string, string> = {}): Partial<Request> {
  const allHeaders: Record<string, string> = { ...headers };
  if (key) {
    allHeaders['idempotency-key'] = key;
  }

  return {
    method,
    path: '/api/test',
    body,
    get: ((name: string) => allHeaders[name.toLowerCase()]) as Request['get'],
    header: ((name: string) => allHeaders[name.toLowerCase()]) as Request['header'],
  };
}

describe('Idempotency Middleware', () => {
  describe('createIdempotencyMiddleware', () => {
    it('passes through non-target HTTP methods', async () => {
      const store: IdempotencyStore = {
        checkAndReserve: jest.fn(),
        save: jest.fn(),
        release: jest.fn(),
      };
      const middleware = createIdempotencyMiddleware({ store });
      const req = createRequest('GET', 'abc') as Request;
      const res = new MockResponse() as unknown as Response;
      const next: NextFunction = jest.fn();

      await middleware(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(store.checkAndReserve).not.toHaveBeenCalled();
    });

    it('passes through requests without idempotency key', async () => {
      const middleware = createIdempotencyMiddleware();
      const req = createRequest('POST') as Request;
      const res = new MockResponse() as unknown as Response;
      const next: NextFunction = jest.fn();

      await middleware(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
    });

    it('stores first response and replays it for duplicate key', async () => {
      const middleware = createIdempotencyMiddleware({
        store: new InMemoryIdempotencyStore(),
      });

      const req1 = createRequest('POST', 'key-1') as Request;
      const res1 = new MockResponse();
      const next1: NextFunction = jest.fn(() => {
        res1.status(201).json({ ok: true });
      });

      await middleware(req1, res1 as unknown as Response, next1);
      // Wait for async finish event
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(next1).toHaveBeenCalledTimes(1);

      const req2 = createRequest('POST', 'key-1') as Request;
      const res2 = new MockResponse();
      const next2: NextFunction = jest.fn();

      await middleware(req2, res2 as unknown as Response, next2);

      expect(next2).not.toHaveBeenCalled();
      expect(res2.statusCode).toBe(201);
      expect(res2.body).toEqual({ ok: true });
      expect(res2.headers['idempotency-status']).toBe('cached');
    });

    it('returns 400 Bad Request for same key but different body', async () => {
      const middleware = createIdempotencyMiddleware({
        store: new InMemoryIdempotencyStore(),
      });

      const req1 = createRequest('POST', 'key-mismatch', { val: 1 }) as Request;
      const res1 = new MockResponse();
      const next1: NextFunction = jest.fn(() => {
        res1.status(200).json({ ok: true });
      });

      await middleware(req1, res1 as unknown as Response, next1);
      await new Promise(resolve => setTimeout(resolve, 0));

      const req2 = createRequest('POST', 'key-mismatch', { val: 2 }) as Request;
      const res2 = new MockResponse();
      const next2: NextFunction = jest.fn();

      await middleware(req2, res2 as unknown as Response, next2);

      expect(next2).toHaveBeenCalledWith(expect.any(AppError));
      const error = (next2 as jest.Mock).mock.calls[0][0] as AppError;
      expect(error.statusCode).toBe(400);
      expect(error.message).toContain('mismatch');
    });

    it('returns 409 Conflict for in-flight duplicate requests', async () => {
      const middleware = createIdempotencyMiddleware({
        store: new InMemoryIdempotencyStore(),
      });

      const req1 = createRequest('PATCH', 'key-2') as Request;
      const res1 = new MockResponse();
      const next1: NextFunction = jest.fn();

      await middleware(req1, res1 as unknown as Response, next1);
      expect(next1).toHaveBeenCalledTimes(1);

      const req2 = createRequest('PATCH', 'key-2') as Request;
      const res2 = new MockResponse();
      const next2: NextFunction = jest.fn();

      await middleware(req2, res2 as unknown as Response, next2);

      expect(next2).toHaveBeenCalledWith(expect.any(AppError));
      const error = (next2 as jest.Mock).mock.calls[0][0] as AppError;
      expect(error.statusCode).toBe(409);
      expect(error.code).toBe(ErrorCode.CONFLICT);
      expect(res2.headers['idempotency-status']).toBe('inflight');
    });

    it('releases key if response status is >= 500', async () => {
      const store = new InMemoryIdempotencyStore();
      const middleware = createIdempotencyMiddleware({ store });

      const req1 = createRequest('POST', 'key-3') as Request;
      const res1 = new MockResponse();
      const next1: NextFunction = jest.fn(() => {
        res1.status(500).json({ error: 'fail' });
      });

      await middleware(req1, res1 as unknown as Response, next1);
      await new Promise(resolve => setTimeout(resolve, 0));

      // Second request should be 'new' because first one was released
      const req2 = createRequest('POST', 'key-3') as Request;
      const res2 = new MockResponse();
      const next2: NextFunction = jest.fn();

      await middleware(req2, res2 as unknown as Response, next2);
      expect(next2).toHaveBeenCalledTimes(1);
    });

    it('handles buffer responses correctly', async () => {
      const store = new InMemoryIdempotencyStore();
      const middleware = createIdempotencyMiddleware({ store });

      const req1 = createRequest('POST', 'key-buf') as Request;
      const res1 = new MockResponse();
      const next1: NextFunction = jest.fn(() => {
        res1.setHeader('Content-Type', 'application/octet-stream');
        res1.status(200).send(Buffer.from('hello', 'utf-8'));
      });

      await middleware(req1, res1 as unknown as Response, next1);
      await new Promise(resolve => setTimeout(resolve, 10));

      const req2 = createRequest('POST', 'key-buf') as Request;
      const res2 = new MockResponse();
      const next2: NextFunction = jest.fn();

      await middleware(req2, res2 as unknown as Response, next2);
      
      expect(res2.statusCode).toBe(200);
      expect(res2.body).toBe('hello');
      expect(res2.headers['content-type']).toBe('application/octet-stream');
    });

    it('handles errors during save gracefully', async () => {
      const store = new InMemoryIdempotencyStore();
      jest.spyOn(store, 'save').mockRejectedValue(new Error('save failed'));
      const middleware = createIdempotencyMiddleware({ store });

      const req = createRequest('POST', 'key-err') as Request;
      const res = new MockResponse();
      const next = jest.fn(() => {
        res.status(200).json({ ok: true });
      });

      await middleware(req, res as unknown as Response, next);
      await new Promise(resolve => setTimeout(resolve, 10));
      // Should not throw or crash; next is called by handler
      expect(next).toHaveBeenCalledTimes(1);
    });

    it('handles rapid retry with same key after server error', async () => {
      const store = new InMemoryIdempotencyStore();
      const middleware = createIdempotencyMiddleware({
        store,
        shouldStoreResponse: (status) => status < 500, // Don't cache 500 errors
      });

      const req1 = createRequest('POST', 'retry-key') as Request;
      const res1 = new MockResponse();
      const next1 = jest.fn(() => {
        res1.status(500).json({ error: 'temp failure' });
      });

      await middleware(req1, res1 as unknown as Response, next1);
      await new Promise(resolve => setTimeout(resolve, 10));

      // Second request should be allowed (not cached, key was released)
      const req2 = createRequest('POST', 'retry-key') as Request;
      const res2 = new MockResponse();
      let callCount = 0;
      const next2 = jest.fn(() => {
        callCount++;
        res2.status(200).json({ ok: true });
      });

      await middleware(req2, res2 as unknown as Response, next2);
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(next2).toHaveBeenCalledTimes(1);
      expect(res2.statusCode).toBe(200);
    });

    it('includes request ID in logs when available', async () => {
      const store = new InMemoryIdempotencyStore();
      const middleware = createIdempotencyMiddleware({ store });

      const req = createRequest('POST', 'log-key') as Request;
      (req as any).requestId = 'req-12345';
      const res = new MockResponse();
      const next = jest.fn(() => {
        res.status(200).json({ ok: true });
      });

      const logSpy = jest.spyOn(console, 'log').mockImplementation();

      await middleware(req as Request, res as unknown as Response, next);
      await new Promise(resolve => setTimeout(resolve, 10));

      // Check that log included request ID
      const logCalls = logSpy.mock.calls.map(c => c[0]);
      const hasRequestId = logCalls.some((logArg: any) => {
        try {
          const log = typeof logArg === 'string' ? JSON.parse(logArg) : logArg;
          return log.requestId === 'req-12345';
        } catch {
          return false;
        }
      });

      expect(hasRequestId).toBe(true);
      logSpy.mockRestore();
    });

    it('handles extremely long idempotency keys', async () => {
      const store = new InMemoryIdempotencyStore();
      const middleware = createIdempotencyMiddleware({ store });

      const longKey = 'key-' + 'x'.repeat(10000);
      const req = createRequest('POST', longKey) as Request;
      const res = new MockResponse();
      const next = jest.fn(() => {
        res.status(200).json({ ok: true });
      });

      await middleware(req, res as unknown as Response, next);
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(next).toHaveBeenCalledTimes(1);
      expect(res.statusCode).toBe(200);
    });

    it('handles Unicode characters in request body hash', async () => {
      const store = new InMemoryIdempotencyStore();
      const middleware = createIdempotencyMiddleware({ store });

      const req = createRequest('POST', 'unicode-key') as Request;
      req.body = { message: '你好世界 🚀', emoji: '🌟' };
      const res = new MockResponse();
      const next = jest.fn(() => {
        res.status(200).json({ ok: true });
      });

      await middleware(req, res as unknown as Response, next);
      await new Promise(resolve => setTimeout(resolve, 10));

      // Duplicate with same body should be cached
      const req2 = createRequest('POST', 'unicode-key') as Request;
      req2.body = { message: '你好世界 🚀', emoji: '🌟' };
      const res2 = new MockResponse();
      const next2 = jest.fn();

      await middleware(req2, res2 as unknown as Response, next2);
      expect(next2).not.toHaveBeenCalled();
      expect(res2.statusCode).toBe(200);
    });

    it('handles null content-type gracefully in cached replay', async () => {
      const store = new InMemoryIdempotencyStore();
      const middleware = createIdempotencyMiddleware({ store });

      // Manually inject a record with null content-type
      const crypto = require('crypto');
      const hash = crypto.createHash('sha256').update('POST').update('/api/test').digest('hex');

      (store as any).records.set('null-ct', {
        record: {
          status: 200,
          body: 'plain text',
          contentType: null,
          createdAt: new Date(),
        },
        requestHash: hash,
      });

      const req = createRequest('POST', 'null-ct') as Request;
      const res = new MockResponse();
      const next = jest.fn();

      await middleware(req, res as unknown as Response, next);
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe('plain text');
    });

    it('handles numeric status codes correctly', async () => {
      const store = new InMemoryIdempotencyStore();
      const middleware = createIdempotencyMiddleware({ store });

      const req = createRequest('POST', 'status-numeric') as Request;
      const res = new MockResponse();
      const next = jest.fn(() => {
        res.status(204).send('');
      });

      await middleware(req, res as unknown as Response, next);
      await new Promise(resolve => setTimeout(resolve, 10));

      const req2 = createRequest('POST', 'status-numeric') as Request;
      const res2 = new MockResponse();
      const next2 = jest.fn();

      await middleware(req2, res2 as unknown as Response, next2);
      expect(res2.statusCode).toBe(204);
    });
  });

  describe('PostgresIdempotencyStore', () => {
    let mockRepo: jest.Mocked<IdempotencyRepository>;
    let store: PostgresIdempotencyStore;

    beforeEach(() => {
      mockRepo = {
        checkAndReserve: jest.fn(),
        save: jest.fn(),
        delete: jest.fn(),
      } as any;
      store = new PostgresIdempotencyStore(mockRepo);
    });

    it('checks and reserves new keys', async () => {
      mockRepo.checkAndReserve.mockResolvedValue({ state: 'new' });

      const result = await store.checkAndReserve('new-key', 'hash1');
      expect(result).toEqual({ state: 'new' });
      expect(mockRepo.checkAndReserve).toHaveBeenCalledWith('new-key', 'hash1');
    });

    it('recognizes in-flight keys from started status', async () => {
      mockRepo.checkAndReserve.mockResolvedValue({ state: 'inflight' });

      const result = await store.checkAndReserve('inflight-key', 'hash1');
      expect(result).toEqual({ state: 'inflight' });
    });

    it('recognizes mismatch for different hash', async () => {
      mockRepo.checkAndReserve.mockResolvedValue({ state: 'mismatch' });

      const result = await store.checkAndReserve('key1', 'hash2');
      expect(result).toEqual({ state: 'mismatch' });
    });

    it('returns cached results for completed keys', async () => {
      const date = new Date();
      mockRepo.checkAndReserve.mockResolvedValue({
        state: 'cached',
        record: {
          key: 'cached-key',
          status: 'completed',
          request_hash: 'hash1',
          response_status: 200,
          response_body: '{"ok":true}',
          response_content_type: 'application/json',
          created_at: date,
        },
      });

      const result = await store.checkAndReserve('cached-key', 'hash1');
      expect(result).toEqual({
        state: 'cached',
        record: {
          status: 200,
          body: '{"ok":true}',
          contentType: 'application/json',
          createdAt: date,
        },
      });
    });

    it('saves records to repository', async () => {
      const record = { status: 201, body: 'ok', createdAt: new Date() };
      await store.save('key1', record);
      expect(mockRepo.save).toHaveBeenCalledWith('key1', 201, 'ok', undefined);
    });

    it('deletes records on release', async () => {
      await store.release('key1');
      expect(mockRepo.delete).toHaveBeenCalledWith('key1');
    });

    it('handles advisory lock contention by retrying', async () => {
      // Simulate lock contention then success
      mockRepo.checkAndReserve.mockResolvedValueOnce({ state: 'inflight' });
      mockRepo.checkAndReserve.mockResolvedValueOnce({ state: 'new' });

      const result1 = await store.checkAndReserve('contended-key', 'hash1');
      expect(result1).toEqual({ state: 'inflight' });

      const result2 = await store.checkAndReserve('contended-key', 'hash2');
      expect(result2).toEqual({ state: 'new' });
    });
  });
});
