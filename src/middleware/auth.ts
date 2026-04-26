import { Request, Response, NextFunction, RequestHandler } from 'express';
import { verifyToken, JwtPayload, getDefaultClaimValidationOptions, getJwtSecretsForVerification } from '../lib/jwt';
import crypto from 'crypto';
import { AuthContext, AuthenticatedRequest as LogoutAuthenticatedRequest } from '../auth/logout/types';
import { SessionRepository as DbSessionRepository } from '../db/repositories/sessionRepository';
import { hashSessionToken, isSessionExpired } from '../auth/session';
import { Errors, AppError, ErrorCode } from '../lib/errors';
import { globalLogger } from '../lib/logger';

// ── AuthenticatedRequest (JWT / sub-based) ────────────────────────────────────
export interface AuthenticatedRequest extends Request {
  user?: {
    sub?: string;
    id?: string;
    email?: string;
    role?: string;
    sessionToken?: string;
    [key: string]: unknown;
  };
}

// ── authMiddleware (Bearer JWT via lib/jwt) ───────────────────────────────────
export function authMiddleware(): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      next(Errors.unauthorized('Authorization header missing'));
      return;
    }

    const parts = authHeader.split(' ');
    if (parts.length !== 2 || parts[0] !== 'Bearer') {
      next(Errors.unauthorized('Invalid authorization header format. Expected: Bearer <token>'));
      return;
    }

    const token = parts[1];

    try {
      const claimOpts = getDefaultClaimValidationOptions();
      const payload = verifyToken(token, claimOpts);
      (req as AuthenticatedRequest).user = {
        ...payload,
        sub: payload.sub,
        email: payload.email,
      };
      next();
    } catch (error) {
      if (error instanceof Error && error.message.includes('JWT_SECRET')) {
        next(Errors.internal('Server configuration error'));
        return;
      }
      globalLogger.warn('JWT verification failed in authMiddleware', {
        error: error instanceof Error ? error.message : String(error),
      });
      next(Errors.unauthorized('Invalid or expired token'));
    }
  };
}

// ── optionalAuthMiddleware ────────────────────────────────────────────────────
export function optionalAuthMiddleware(): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      (req as AuthenticatedRequest).user = undefined;
      next();
      return;
    }

    const parts = authHeader.split(' ');
    if (parts.length !== 2 || parts[0] !== 'Bearer') {
      (req as AuthenticatedRequest).user = undefined;
      next();
      return;
    }

    try {
      const claimOpts = getDefaultClaimValidationOptions();
      const payload = verifyToken(parts[1], claimOpts);
      (req as AuthenticatedRequest).user = {
        ...payload,
        sub: payload.sub,
        email: payload.email,
      };
    } catch {
      (req as AuthenticatedRequest).user = undefined;
    }

    next();
  };
}

// ── verifyJwt (HS256 via crypto) ──────────────────────────────────────────────
interface JwtPayloadInternal {
  sub: string;
  role: string;
  sid?: string;
  iat?: number;
  exp?: number;
}

/**
 * @notice Verify a JWT using raw HMAC-SHA256 with key rotation support.
 * @dev Accepts a single secret or an array of secrets (current first, previous second).
 *      The first secret that produces a valid signature wins.
 * @param token JWT string to verify.
 * @param secretOrSecrets One or more HMAC secrets to try, in priority order.
 * @returns Decoded payload if signature and expiry are valid.
 * @throws {Error} If the token format, signature, or expiry is invalid.
 */
export function verifyJwt(token: string, secretOrSecrets: string | string[]): JwtPayloadInternal {
  const secrets = Array.isArray(secretOrSecrets) ? secretOrSecrets : [secretOrSecrets];
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Invalid token format');

  const [headerB64, payloadB64, signatureB64] = parts;

  let payload: JwtPayloadInternal | null = null;
  for (const secret of secrets) {
    const expectedSig = crypto
      .createHmac('sha256', secret)
      .update(`${headerB64}.${payloadB64}`)
      .digest('base64url');

    if (expectedSig === signatureB64) {
      try {
        payload = JSON.parse(
          Buffer.from(payloadB64, 'base64url').toString('utf8'),
        ) as JwtPayloadInternal;
        break;
      } catch {
        continue;
      }
    }
  }

  if (!payload) throw new Error('Invalid token signature');

  if (payload.exp !== undefined && payload.exp < Math.floor(Date.now() / 1000)) {
    throw new Error('Token expired');
  }

  return payload;
}

// ── requireInvestor ───────────────────────────────────────────────────────────
export function requireInvestor(req: Request, _res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    next(Errors.unauthorized('Missing or invalid Authorization header'));
    return;
  }

  const token = authHeader.slice(7);

  try {
    const secrets = getJwtSecretsForVerification();
    const payload = verifyJwt(token, secrets);
    if (payload.role !== 'investor') {
      next(Errors.forbidden('investor role required'));
      return;
    }
    (req as AuthenticatedRequest).user = { id: payload.sub, role: 'investor' };
    next();
  } catch (error) {
    if (error instanceof Error && error.message.includes('JWT_SECRET')) {
      next(Errors.internal('Server configuration error'));
      return;
    }
    next(Errors.unauthorized('Invalid or expired token'));
  }
}

// ── authMiddleware (mock — X-Issuer-Id header) ────────────────────────────────
// NOTE: named export collision with authMiddleware() above is intentional —
// this const shadows the factory fn for issuer-only routes.
export const requireIssuerAuth = (
  req: AuthenticatedRequest,
  _res: Response,
  next: NextFunction,
): void => {
  const issuerId = req.header('X-Issuer-Id');
  if (!issuerId) {
    next(Errors.unauthorized('Missing Issuer ID'));
    return;
  }
  req.user = { id: issuerId, role: 'issuer' };
  next();
};

// ── createRequireAuth (session-hardened)
export function createRequireAuth(sessionRepository: DbSessionRepository): RequestHandler {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      next(Errors.unauthorized('Missing or invalid Authorization header'));
      return;
    }

    const token = authHeader.slice(7);
    let payload: JwtPayload;

    try {
      const claimOpts = getDefaultClaimValidationOptions();
      payload = verifyToken(token, claimOpts);
    } catch (err) {
      if (err instanceof Error && err.message.includes('JWT_SECRET')) {
        next(Errors.internal('Server configuration error'));
        return;
      }
      globalLogger.warn('JWT verification failed in createRequireAuth', {
        error: err instanceof Error ? err.message : String(err),
      });
      next(Errors.unauthorized('Invalid or expired token'));
      return;
    }

    if (!payload.sub || !payload.sid) {
      next(Errors.unauthorized('Token missing subject or session'));
      return;
    }

    const session = await sessionRepository.findById(payload.sid);

    if (!session || session.user_id !== payload.sub) {
      next(Errors.unauthorized('Session not found or user mismatch'));
      return;
    }

    if (isSessionExpired(session.expires_at)) {
      next(Errors.unauthorized('Session expired'));
      return;
    }

    if (hashSessionToken(token) !== session.token_hash) {
      next(Errors.unauthorized('Token mismatch'));
      return;
    }

    (req as any).auth = {
      userId: payload.sub,
      sessionId: payload.sid,
      tokenId: token,
    } as AuthContext;

    (req as AuthenticatedRequest).user = {
      sub: payload.sub,
      id: payload.sub,
      role: payload.role as string,
    };

    next();
  };
}

export function requireAuth(sessionRepository: DbSessionRepository): RequestHandler {
  return createRequireAuth(sessionRepository);
}