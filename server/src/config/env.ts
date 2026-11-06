/**
 * config/env.ts
 *
 * Validates required environment variables at startup.
 * The application will refuse to start if any required variable is missing.
 */

import 'dotenv/config';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `[config] Missing required environment variable: ${name}\n` +
        `  Copy server/.env.example to server/.env and set all required values.`
    );
  }
  return value;
}

export const config = {
  port: parseInt(process.env.PORT ?? '4000', 10),
  mongoUri: requireEnv('MONGODB_URI'),
  jwtSecret: requireEnv('JWT_SECRET'),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '7d',
  clientUrl: process.env.CLIENT_URL ?? 'http://localhost:5173',
  nodeEnv: process.env.NODE_ENV ?? 'development',
  bcryptRounds: parseInt(process.env.BCRYPT_ROUNDS ?? '12', 10),
  isProduction: process.env.NODE_ENV === 'production',
} as const;

