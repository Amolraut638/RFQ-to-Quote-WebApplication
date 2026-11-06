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
  const token = req.cookies?.token as string | undefined;

  if (!token) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  try {
    const payload = jwt.verify(token, config.jwtSecret) as JwtPayload;
    req.user = payload;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired session. Please log in again.' });
  }
}

