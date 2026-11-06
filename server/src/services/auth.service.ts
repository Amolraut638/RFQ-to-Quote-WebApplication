/**
 * services/auth.service.ts
 *
 * Business logic for authentication.
 * Controllers stay thin; all DB operations live here.
 */

import jwt from 'jsonwebtoken';
import { User, IUser } from '../models/User';
import { config } from '../config/env';
import { LoginInput } from '../validators/auth.validator';
import { JwtPayload } from '../middleware/authenticate';

export class AuthError extends Error {
  constructor(
    message: string,
    public statusCode: number = 401
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

export async function login(input: LoginInput): Promise<{ token: string; user: Record<string, unknown> }> {
  const user = await User.findOne({ email: input.email }).select('+passwordHash');

  if (!user) {
    throw new AuthError('Invalid email or password');
  }

  if (!user.active) {
    throw new AuthError('Your account has been deactivated. Contact your administrator.');
  }

  const isMatch = await user.comparePassword(input.password);
  if (!isMatch) {
    throw new AuthError('Invalid email or password');
  }

  const payload: JwtPayload = {
    id: user._id.toString(),
    role: user.role,
    email: user.email,
  };

  const token = jwt.sign(payload, config.jwtSecret, {
    expiresIn: config.jwtExpiresIn as jwt.SignOptions['expiresIn'],
  });

  // toJSON() strips passwordHash automatically
  return { token, user: user.toJSON() };
}

export async function getUserById(id: string): Promise<IUser | null> {
  return User.findById(id).select('-passwordHash');
}

