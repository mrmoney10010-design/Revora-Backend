import { Request, Response, NextFunction } from 'express';
import { SessionRepository } from '../db/repositories/sessionRepository';
import { createRequireAuthWithSession, AuthenticatedRequest } from './authWithSession';
import { verifyToken } from '../lib/jwt';
import { Errors } from '../lib/errors';
import { globalLogger } from '../lib/logger';

jest.mock('../lib/jwt');
jest.mock('../lib/logger');

describe('authWithSession Middleware', () => {
    let mockSessionRepository: jest.Mocked<SessionRepository>;
    let mockReq: Partial<AuthenticatedRequest>;
    let mockRes: Partial<Response>;
    let mockNext: jest.Mock;

    beforeEach(() => {
        mockSessionRepository = {
            findById: jest.fn(),
        } as unknown as jest.Mocked<SessionRepository>;
        mockReq = {
            headers: {},
            requestId: 'test-request-id',
        } as any;
        mockRes = {
            status: jest.fn().mockReturnThis(),
            json: jest.fn().mockReturnThis(),
        };
        mockNext = jest.fn();
        jest.clearAllMocks();
    });

    let middleware: any;

    beforeEach(() => {
        middleware = createRequireAuthWithSession(mockSessionRepository);
    });

    it('should fail if Authorization header is missing', async () => {
        await middleware(mockReq as Request, mockRes as Response, mockNext);

        expect(mockNext).toHaveBeenCalledWith(expect.objectContaining({
            message: 'Missing or invalid token',
            statusCode: 401
        }));
        expect(globalLogger.warn).toHaveBeenCalledWith(
            'Auth failure: Missing or invalid token',
            expect.objectContaining({ requestId: 'test-request-id' })
        );
    });

    it('should fail if Authorization header does not start with Bearer', async () => {
        mockReq.headers!.authorization = 'Basic token';
        await middleware(mockReq as Request, mockRes as Response, mockNext);

        expect(mockNext).toHaveBeenCalledWith(expect.objectContaining({
            message: 'Missing or invalid token',
            statusCode: 401
        }));
    });

    it('should fail if token verification fails', async () => {
        mockReq.headers!.authorization = 'Bearer invalid-token';
        (verifyToken as jest.Mock).mockImplementation(() => {
            throw new Error('Invalid signature');
        });

        await middleware(mockReq as Request, mockRes as Response, mockNext);

        expect(mockNext).toHaveBeenCalledWith(expect.objectContaining({
            message: 'Invalid or expired token',
            statusCode: 401
        }));
        expect(globalLogger.warn).toHaveBeenCalledWith(
            'Auth failure: Invalid or expired token',
            expect.objectContaining({ error: 'Invalid signature' })
        );
    });

    it('should fail if token is missing sid or sub', async () => {
        mockReq.headers!.authorization = 'Bearer token';
        (verifyToken as jest.Mock).mockReturnValue({ role: 'investor' }); // missing sid and sub

        await middleware(mockReq as Request, mockRes as Response, mockNext);

        expect(mockNext).toHaveBeenCalledWith(expect.objectContaining({
            message: 'Token missing identifiers',
            statusCode: 401
        }));
    });

    it('should fail if session is not found in database', async () => {
        mockReq.headers!.authorization = 'Bearer token';
        (verifyToken as jest.Mock).mockReturnValue({ sid: 'sess-123', sub: 'user-123', role: 'investor' });
        mockSessionRepository.findById.mockResolvedValue(null);

        await middleware(mockReq as Request, mockRes as Response, mockNext);

        expect(mockNext).toHaveBeenCalledWith(expect.objectContaining({
            message: 'Session not found',
            statusCode: 401
        }));
    });

    it('should fail if session is revoked', async () => {
        mockReq.headers!.authorization = 'Bearer token';
        (verifyToken as jest.Mock).mockReturnValue({ sid: 'sess-123', sub: 'user-123', role: 'investor' });
        mockSessionRepository.findById.mockResolvedValue({
            id: 'sess-123',
            user_id: 'user-123',
            revoked_at: new Date(),
            expires_at: new Date(Date.now() + 3600000),
        } as any);

        await middleware(mockReq as Request, mockRes as Response, mockNext);

        expect(mockNext).toHaveBeenCalledWith(expect.objectContaining({
            message: 'Session has been revoked',
            statusCode: 401
        }));
    });

    it('should fail if session is expired', async () => {
        mockReq.headers!.authorization = 'Bearer token';
        (verifyToken as jest.Mock).mockReturnValue({ sid: 'sess-123', sub: 'user-123', role: 'investor' });
        mockSessionRepository.findById.mockResolvedValue({
            id: 'sess-123',
            user_id: 'user-123',
            revoked_at: null,
            expires_at: new Date(Date.now() - 3600000), // 1 hour ago
        } as any);

        await middleware(mockReq as Request, mockRes as Response, mockNext);

        expect(mockNext).toHaveBeenCalledWith(expect.objectContaining({
            message: 'Session has expired',
            statusCode: 401
        }));
    });

    it('should succeed with valid token and active session', async () => {
        mockReq.headers!.authorization = 'Bearer token';
        (verifyToken as jest.Mock).mockReturnValue({ sid: 'sess-123', sub: 'user-123', role: 'investor' });
        mockSessionRepository.findById.mockResolvedValue({
            id: 'sess-123',
            user_id: 'user-123',
            revoked_at: null,
            expires_at: new Date(Date.now() + 3600000),
        } as any);

        await middleware(mockReq as Request, mockRes as Response, mockNext);

        expect(mockNext).toHaveBeenCalledWith();
        expect((mockReq as AuthenticatedRequest).auth).toEqual({
            userId: 'user-123',
            sessionId: 'sess-123',
            role: 'investor',
        });
        expect(globalLogger.info).toHaveBeenCalledWith('Auth success', expect.any(Object));
    });
});
