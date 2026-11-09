/**
 * middleware/authenticate.ts
 *
 * Reads the JWT from the httpOnly cookie, verifies it,
 * and attaches the decoded payload to req.user.
 * Returns 401 if the token is missing, invalid, or expired.
 */

import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config/env';
import { UserRole } from '../models/User';

export interface JwtPayload {
  id: string;
  role: UserRole;
  email: string;
}

// Extend Express Request so downstream handlers can access req.user
declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}

export function authenticate(req: Request, res: Response, next: NextFunction): void {
  const hasCookies = Boolean(req.cookies);
  const cookieKeys = req.cookies ? Object.keys(req.cookies) : [];
  const hasTokenCookie = Boolean(req.cookies?.token);
  const authHeader = req.headers?.authorization;
  const hasAuthHeader = Boolean(authHeader?.startsWith('Bearer '));

  // Safe diagnostic logging (NEVER logs token strings, secrets, passwords, or payload credentials)
  console.log(`[auth-diag] ${req.method} ${req.originalUrl}`);
  console.log(
    `[auth-diag] cookies parsed: ${hasCookies}, cookie keys: [${cookieKeys.join(', ')}], token cookie: ${hasTokenCookie}, bearer header: ${hasAuthHeader}`
  );

  let token: string | undefined = req.cookies?.token as string | undefined;

  // Fallback to Bearer token header if cross-site cookie is blocked by browser policy
  if (!token && hasAuthHeader) {
    token = authHeader!.slice(7).trim();
  }

  if (!token) {
    console.warn(`[auth-diag] 401 Unauthorized: token missing in request (no 'token' cookie or Bearer header)`);
    res.status(401).json({
      error: 'Authentication required',
      code: 'TOKEN_MISSING',
    });
    return;
  }

  try {
    const payload = jwt.verify(token, config.jwtSecret) as JwtPayload;
    console.log(`[auth-diag] JWT verification SUCCESS for user ID: ${payload.id}, role: ${payload.role}`);
    req.user = payload;
    next();
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      console.warn(`[auth-diag] JWT verification FAILED: TokenExpiredError (expired at ${err.expiredAt?.toISOString()})`);
      res.status(401).json({
        error: 'Session expired. Please log in again.',
        code: 'TOKEN_EXPIRED',
      });
      return;
    }
    if (err instanceof jwt.JsonWebTokenError) {
      console.warn(`[auth-diag] JWT verification FAILED: JsonWebTokenError (${err.message})`);
      res.status(401).json({
        error: 'Invalid session token. Please log in again.',
        code: 'TOKEN_INVALID',
      });
      return;
    }
    console.warn(`[auth-diag] JWT verification FAILED: unexpected verification error`);
    res.status(401).json({
      error: 'Invalid or expired session. Please log in again.',
      code: 'AUTH_FAILED',
    });
  }
}

