/**
 * controllers/auth.controller.ts
 *
 * Thin HTTP layer: validate → delegate to service → set cookie → respond.
 * No business logic here.
 */

import { Request, Response, NextFunction } from 'express';
import { LoginSchema } from '../validators/auth.validator';
import * as AuthService from '../services/auth.service';
import { config } from '../config/env';

function cookieMaxAge(expiresIn: string): number {
  if (expiresIn.endsWith('d')) return parseInt(expiresIn) * 86_400_000;
  if (expiresIn.endsWith('h')) return parseInt(expiresIn) * 3_600_000;
  return 7 * 86_400_000; // default 7 days
}

export async function login(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = LoginSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
      return;
    }

    const { token, user } = await AuthService.login(parsed.data);

    res.cookie('token', token, {
      httpOnly: true,
      secure: config.isProduction,
      // 'none' required for cross-origin Vercel (frontend) → Render (API) cookie delivery.
      // Browsers block SameSite=strict/lax cookies on cross-site requests.
      // 'none' is only valid with secure:true (enforced by isProduction check above).
      sameSite: config.isProduction ? 'none' : 'lax',
      maxAge: cookieMaxAge(config.jwtExpiresIn),
    });

    res.json({ success: true, user });
  } catch (err) {
    if (err instanceof AuthService.AuthError) {
      res.status(err.statusCode).json({ error: err.message });
      return;
    }
    next(err);
  }
}

export function logout(_req: Request, res: Response): void {
  res.clearCookie('token', {
    httpOnly: true,
    secure: config.isProduction,
    sameSite: config.isProduction ? 'none' : 'lax',
  });
  res.json({ success: true, message: 'Logged out' });
}

export async function me(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }
    const user = await AuthService.getUserById(req.user.id);
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    res.json({ user });
  } catch (err) {
    next(err);
  }
}

