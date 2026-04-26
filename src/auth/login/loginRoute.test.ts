import { createHash } from 'node:crypto';
import { Response, NextFunction } from 'express';
import { createLoginHandler } from './loginHandler';
import { LoginService } from './loginService';
import {
    JwtIssuer,
    SessionRepository,
    UserRecord,
    UserRepository,
    UserRole,
} from './types';

const hashPassword = (plain: string): string =>
    createHash('sha256').update(plain).digest('hex');

class InMemoryUserRepository implements UserRepository {
    private users: UserRecord[] = [];
    add(user: UserRecord): void { this.users.push(user); }
    async findByEmail(email: string): Promise<UserRecord | null> {
        return this.users.find((u) => u.email === email) ?? null;
    }
}

class InMemorySessionRepository implements SessionRepository {
    private sessions = new Map<string, string>();
    private counter = 0;
    async createSession(userId: string): Promise<string> {
        const id = `session-${++this.counter}`;
        this.sessions.set(id, userId);
        return id;
    }
    getSession(sessionId: string): string | undefined {
        return this.sessions.get(sessionId);
    }
}

class FakeJwtIssuer implements JwtIssuer {
    lastPayload: any = null;
    sign(payload: any): string {
        this.lastPayload = payload;
        return `fake-jwt-for-${payload.userId}-${payload.sessionId}`;
    }
}

class MockResponse {
    statusCode = 200;
    payload: any;
    status(code: number): this { this.statusCode = code; return this; }
    json(payload: any): this { this.payload = payload; return this; }
    send(payload?: any): this { this.payload = payload; return this; }
}

describe('Login Route Handler', () => {
    function createFixture() {
        const userRepo = new InMemoryUserRepository();
        const sessionRepo = new InMemorySessionRepository();
        const jwtIssuer = new FakeJwtIssuer();
        const service = new LoginService(userRepo, sessionRepo, jwtIssuer);
        const handler = createLoginHandler(service);
        return { userRepo, sessionRepo, jwtIssuer, service, handler };
    }

    it('returns 200 with token for successful login', async () => {
        const { userRepo, handler } = createFixture();
        userRepo.add({ id: 'u1', email: 'f@s.io', role: 'startup', passwordHash: hashPassword('pw') });
        
        const req = { body: { email: 'f@s.io', password: 'pw' } } as any;
        const res = new MockResponse();
        await handler(req, res as unknown as Response, (()=>{}) as any);
        
        expect(res.statusCode).toBe(200);
        expect(res.payload.token).toBeDefined();
        expect(res.payload.user.email).toBe('f@s.io');
    });

    it('returns 401 for wrong password', async () => {
        const { userRepo, handler } = createFixture();
        userRepo.add({ id: 'u1', email: 'f@s.io', role: 'startup', passwordHash: hashPassword('pw') });
        
        const req = { body: { email: 'f@s.io', password: 'wrong' } } as any;
        const res = new MockResponse();
        await handler(req, res as unknown as Response, (()=>{}) as any);
        
        expect(res.statusCode).toBe(401);
    });

    it('returns 400 for missing credentials', async () => {
        const { handler } = createFixture();
        const req = { body: {} } as any;
        const res = new MockResponse();
        await handler(req, res as unknown as Response, (()=>{}) as any);
        expect(res.statusCode).toBe(400);
    });
});
