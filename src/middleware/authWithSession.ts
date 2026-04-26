import { Request, Response, NextFunction, RequestHandler } from 'express';
import { verifyToken } from '../lib/jwt';
import { SessionRepository } from '../db/repositories/sessionRepository';
import { UserRole } from '../auth/login/types';
import { Errors } from '../lib/errors';
import { globalLogger } from '../lib/logger';

export interface AuthContext {
    userId: string;
    sessionId: string;
    role: UserRole;
}

export interface AuthenticatedRequest extends Request {
    auth?: AuthContext;
}

/**
 * Middleware that verifies the JWT AND checks the session in the database.
 * If the session is revoked or expired, it returns 401.
 */
export const createRequireAuthWithSession = (
    sessionRepository: SessionRepository,
): RequestHandler => {
    if (!sessionRepository) {
        throw new Error('SessionRepository is required');
    }
    return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const authHeader = req.headers.authorization;
            const requestId = (req as any).requestId;

            if (!authHeader || !authHeader.startsWith('Bearer ')) {
                globalLogger.warn('Auth failure: Missing or invalid token', { requestId });
                next(Errors.unauthorized('Missing or invalid token'));
                return;
            }

            const token = authHeader.slice(7);

            let payload;
            try {
                payload = verifyToken(token);
            } catch (error) {
                globalLogger.warn('Auth failure: Invalid or expired token', { 
                    requestId, 
                    error: error instanceof Error ? error.message : String(error) 
                });
                next(Errors.unauthorized('Invalid or expired token'));
                return;
            }

            const sessionId = payload.sid as string;
            const userId = payload.sub;
            const role = payload.role as UserRole;

            if (!sessionId || !userId) {
                globalLogger.warn('Auth failure: Token missing identifiers', { requestId, userId });
                next(Errors.unauthorized('Token missing identifiers'));
                return;
            }

            // Check session in DB
            const session = await sessionRepository.findById(sessionId);

            if (!session) {
                globalLogger.warn('Auth failure: Session not found', { requestId, userId, sessionId });
                next(Errors.unauthorized('Session not found'));
                return;
            }

            if (session.revoked_at) {
                globalLogger.warn('Auth failure: Session revoked', { requestId, userId, sessionId });
                next(Errors.unauthorized('Session has been revoked'));
                return;
            }

            if (new Date(session.expires_at) < new Date()) {
                globalLogger.warn('Auth failure: Session expired', { requestId, userId, sessionId });
                next(Errors.unauthorized('Session has expired'));
                return;
            }

            (req as AuthenticatedRequest).auth = {
                userId,
                sessionId,
                role,
            };

            globalLogger.info('Auth success', { requestId, userId, role, sessionId });
            next();
        } catch (error) {
            next(error);
        }
    };
};
