import { NextFunction, Request, Response } from 'express';
import { createRegisterHandler } from './registerHandler';
import { DuplicateEmailError, RegisterService } from './registerService';
import { RegisteredUser } from './types';
import { ErrorCode } from '../../lib/errors';

class MockRegisterService {
  result: RegisteredUser | null = null;
  shouldThrow: unknown = null;
  async register(_email: string, _password: string): Promise<RegisteredUser> {
    if (this.shouldThrow) throw this.shouldThrow;
    return this.result!;
  }
}

function makeReq(body: unknown = {}): Request {
  return { body } as unknown as Request;
}

function makeRes() {
  let statusCode = 200;
  let body: unknown = null;
  const res = {
    status(code: number) { statusCode = code; return res; },
    json(obj: unknown) { body = obj; return res; },
    _status: () => statusCode,
    _body: () => body,
  };
  return res as unknown as Response & { _status(): number; _body(): unknown };
}

function makeUser(overrides: Partial<RegisteredUser> = {}): RegisteredUser {
  return { id: 'user-1', email: 'investor@example.com', role: 'investor', created_at: new Date('2024-01-01'), ...overrides };
}

const noop: NextFunction = jest.fn();

describe('createRegisterHandler', () => {
  let infoSpy: jest.SpyInstance;

  beforeEach(() => {
    infoSpy = jest.spyOn(console, 'info').mockImplementation(() => undefined);
  });

  afterEach(() => {
    infoSpy.mockRestore();
  });

  it('returns 201 with user payload on success', async () => {
    const svc = new MockRegisterService();
    svc.result = makeUser();
    const handler = createRegisterHandler(svc as unknown as RegisterService);
    const res = makeRes();
    await handler(makeReq({ email: 'investor@example.com', password: 'secret123' }), res, noop);
    expect(res._status()).toBe(201);
    expect(res._body()).toEqual({ user: { id: 'user-1', email: 'investor@example.com', role: 'investor' } });
  });

  it('accepts optional name field and ignores it', async () => {
    const svc = new MockRegisterService();
    svc.result = makeUser({ email: 'alice@example.com' });
    const handler = createRegisterHandler(svc as unknown as RegisterService);
    const res = makeRes();
    await handler(makeReq({ email: 'alice@example.com', password: 'password1', name: 'Alice' }), res, noop);
    expect(res._status()).toBe(201);
  });

  it('emits a structured info log on success without PII', async () => {
    const svc = new MockRegisterService();
    svc.result = makeUser();
    const handler = createRegisterHandler(svc as unknown as RegisterService);
    await handler(makeReq({ email: 'investor@example.com', password: 'secret123' }), makeRes(), noop);
    expect(infoSpy).toHaveBeenCalledTimes(1);
    const log = JSON.parse(infoSpy.mock.calls[0][0] as string);
    expect(log.type).toBe('auth');
    expect(log.event).toBe('STARTUP_REGISTER_SUCCESS');
    expect(log.userId).toBe('user-1');
    expect(JSON.stringify(log)).not.toContain('investor@example.com');
  });

  it('returns 400 VALIDATION_ERROR when email is missing', async () => {
    const svc = new MockRegisterService();
    const handler = createRegisterHandler(svc as unknown as RegisterService);
    const res = makeRes();
    await handler(makeReq({ password: 'password1' }), res, noop);
    expect(res._status()).toBe(400);
    expect((res._body() as any).code).toBe(ErrorCode.VALIDATION_ERROR);
  });

  it('returns 400 VALIDATION_ERROR when password is missing', async () => {
    const svc = new MockRegisterService();
    const handler = createRegisterHandler(svc as unknown as RegisterService);
    const res = makeRes();
    await handler(makeReq({ email: 'investor@example.com' }), res, noop);
    expect(res._status()).toBe(400);
    expect((res._body() as any).code).toBe(ErrorCode.VALIDATION_ERROR);
  });

  it('returns 400 VALIDATION_ERROR when body is absent', async () => {
    const svc = new MockRegisterService();
    const handler = createRegisterHandler(svc as unknown as RegisterService);
    const res = makeRes();
    await handler(makeReq(undefined), res, noop);
    expect(res._status()).toBe(400);
    expect((res._body() as any).code).toBe(ErrorCode.VALIDATION_ERROR);
  });

  it('returns 400 VALIDATION_ERROR when email is not a string', async () => {
    const svc = new MockRegisterService();
    const handler = createRegisterHandler(svc as unknown as RegisterService);
    const res = makeRes();
    await handler(makeReq({ email: 123, password: 'password1' }), res, noop);
    expect(res._status()).toBe(400);
    expect((res._body() as any).code).toBe(ErrorCode.VALIDATION_ERROR);
  });

  it('returns 400 VALIDATION_ERROR for invalid email format', async () => {
    const svc = new MockRegisterService();
    const handler = createRegisterHandler(svc as unknown as RegisterService);
    const res = makeRes();
    await handler(makeReq({ email: 'notanemail', password: 'password1' }), res, noop);
    expect(res._status()).toBe(400);
    expect((res._body() as any).code).toBe(ErrorCode.VALIDATION_ERROR);
    expect((res._body() as any).message).toMatch(/email/i);
  });

  it('returns 400 VALIDATION_ERROR when password is too short', async () => {
    const svc = new MockRegisterService();
    const handler = createRegisterHandler(svc as unknown as RegisterService);
    const res = makeRes();
    await handler(makeReq({ email: 'investor@example.com', password: 'short' }), res, noop);
    expect(res._status()).toBe(400);
    expect((res._body() as any).code).toBe(ErrorCode.VALIDATION_ERROR);
    expect((res._body() as any).message).toMatch(/password/i);
  });

  it('returns 409 CONFLICT when service throws DuplicateEmailError', async () => {
    const svc = new MockRegisterService();
    svc.shouldThrow = new DuplicateEmailError();
    const handler = createRegisterHandler(svc as unknown as RegisterService);
    const res = makeRes();
    await handler(makeReq({ email: 'taken@example.com', password: 'password1' }), res, noop);
    expect(res._status()).toBe(409);
    expect((res._body() as any).code).toBe(ErrorCode.CONFLICT);
    expect((res._body() as any).message).not.toMatch(/sql|pg|database|query/i);
  });

  it('409 response body does not expose stack or internal details', async () => {
    const svc = new MockRegisterService();
    svc.shouldThrow = new DuplicateEmailError();
    const handler = createRegisterHandler(svc as unknown as RegisterService);
    const res = makeRes();
    await handler(makeReq({ email: 'taken@example.com', password: 'password1' }), res, noop);
    const body = res._body() as any;
    expect(body).not.toHaveProperty('stack');
    expect(body).not.toHaveProperty('details');
  });

  it('forwards unexpected errors to next() without sending a response', async () => {
    const svc = new MockRegisterService();
    svc.shouldThrow = new Error('unexpected DB failure');
    const handler = createRegisterHandler(svc as unknown as RegisterService);
    const next = jest.fn() as NextFunction;
    const res = makeRes();
    await handler(makeReq({ email: 'investor@example.com', password: 'password1' }), res, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: 'unexpected DB failure' }));
    expect(res._status()).toBe(200);
  });
});
