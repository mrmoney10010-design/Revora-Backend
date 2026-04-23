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

function createRequest(method: string, key?: string, headers: Record<string, string> = {}): Partial<Request> {
  const allHeaders: Record<string, string> = { ...headers };
  if (key) {
    allHeaders['idempotency-key'] = key;
  }

  return {
    method,
    path: '/api/test',
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
      // Should not throw or crash
    });

    it('handles errors during checkAndReserve gracefully', async () => {
      const store = new InMemoryIdempotencyStore();
      jest.spyOn(store, 'checkAndReserve').mockRejectedValue(new Error('check failed'));
      const middleware = createIdempotencyMiddleware({ store });

      const req = createRequest('POST', 'key-err-check') as Request;
      const res = new MockResponse();
      const next = jest.fn();

      await middleware(req, res as unknown as Response, next);
      expect(next).toHaveBeenCalledWith(); // it should call next() without error on infra failure
    });

    it('handles malformed JSON in cached response', async () => {
      const store = new InMemoryIdempotencyStore();
      const middleware = createIdempotencyMiddleware({ store });

      // Manually inject bad record
      (store as any).records.set('bad-json', {
        record: {
          status: 200,
          body: '{ malformed }',
          contentType: 'application/json',
          createdAt: new Date(),
        }
      });

      const req = createRequest('POST', 'bad-json') as Request;
      const res = new MockResponse();
      const next = jest.fn();

      await middleware(req, res as unknown as Response, next);
      expect(res.body).toBe('{ malformed }'); // Fallback to raw send
    });

    it('handles array headers correctly', async () => {
      const store = new InMemoryIdempotencyStore();
      const middleware = createIdempotencyMiddleware({ store });

      const req = createRequest('POST', 'key-array-header') as Request;
      const res = new MockResponse();
      const next = jest.fn(() => {
        res.setHeader('X-Custom', ['val1', 'val2']);
        res.status(200).send('ok');
      });

      await middleware(req, res as unknown as Response, next);
      await new Promise(resolve => setTimeout(resolve, 10));
    });

    it('handles release failure gracefully', async () => {
      const store = new InMemoryIdempotencyStore();
      jest.spyOn(store, 'release').mockRejectedValue(new Error('release failed'));
      const middleware = createIdempotencyMiddleware({ store, shouldStoreResponse: () => false });

      const req = createRequest('POST', 'key-rel-err') as Request;
      const res = new MockResponse();
      const next = jest.fn(() => {
        res.status(200).send('ok');
      });

      await middleware(req, res as unknown as Response, next);
      await new Promise(resolve => setTimeout(resolve, 10));
    });

    it('handles undefined bodies in serializeBody', async () => {
      const store = new InMemoryIdempotencyStore();
      const middleware = createIdempotencyMiddleware({ store });

      const req = createRequest('POST', 'key-undef') as Request;
      const res = new MockResponse();
      const next = jest.fn(() => {
        res.status(200).send(undefined);
      });

      await middleware(req, res as unknown as Response, next);
      await new Promise(resolve => setTimeout(resolve, 10));
    });

    it('prunes expired records in memory store', async () => {
      const store = new InMemoryIdempotencyStore({ ttlMs: 1 });
      await store.save('expired', { status: 200, body: 'ok', createdAt: new Date() });
      await new Promise(resolve => setTimeout(resolve, 5));
      const result = await store.checkAndReserve('expired');
      expect(result.state).toBe('new');
    });

    it('does not prune unexpired records in memory store', async () => {
      const store = new InMemoryIdempotencyStore({ ttlMs: 1000 });
      await store.save('alive', { status: 200, body: 'ok', createdAt: new Date() });
      const result = await store.checkAndReserve('alive');
      expect(result.state).toBe('cached');
    });
  });

  describe('PostgresIdempotencyStore', () => {
    let mockRepo: jest.Mocked<IdempotencyRepository>;
    let store: PostgresIdempotencyStore;

    beforeEach(() => {
      mockRepo = {
        find: jest.fn(),
        reserve: jest.fn(),
        save: jest.fn(),
        delete: jest.fn(),
      } as any;
      store = new PostgresIdempotencyStore(mockRepo);
    });

    it('checks and reserves new keys', async () => {
      mockRepo.find.mockResolvedValue(null);
      mockRepo.reserve.mockResolvedValue(true);

      const result = await store.checkAndReserve('new-key');
      expect(result).toEqual({ state: 'new' });
      expect(mockRepo.reserve).toHaveBeenCalledWith('new-key');
    });

    it('recognizes in-flight keys from started status', async () => {
      mockRepo.find.mockResolvedValue({
        key: 'inflight-key',
        status: 'started',
        created_at: new Date(),
      });

      const result = await store.checkAndReserve('inflight-key');
      expect(result).toEqual({ state: 'inflight' });
    });

    it('recognizes in-flight keys from reservation failure', async () => {
        mockRepo.find.mockResolvedValue(null);
        mockRepo.reserve.mockResolvedValue(false);
  
        const result = await store.checkAndReserve('raced-key');
        expect(result).toEqual({ state: 'inflight' });
      });

    it('returns cached results for completed keys', async () => {
      const date = new Date();
      mockRepo.find.mockResolvedValue({
        key: 'cached-key',
        status: 'completed',
        response_status: 200,
        response_body: '{"ok":true}',
        response_content_type: 'application/json',
        created_at: date,
      });

      const result = await store.checkAndReserve('cached-key');
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
  });
});
