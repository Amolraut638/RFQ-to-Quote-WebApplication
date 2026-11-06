/**
 * config/db.ts
 *
 * Mongoose connection with lifecycle logging and graceful shutdown.
 * The server must not start accepting requests until this resolves.
 */

import mongoose from 'mongoose';
import { config } from './env';

export async function connectDB(): Promise<void> {
  mongoose.connection.on('connected', () => {
    console.log('[db] MongoDB connected');
  });

  mongoose.connection.on('error', (err) => {
    console.error('[db] MongoDB connection error:', err.message);
  });

  mongoose.connection.on('disconnected', () => {
    console.warn('[db] MongoDB disconnected');
  });

  // Graceful shutdown on SIGINT / SIGTERM
  process.on('SIGINT', async () => {
    await mongoose.connection.close();
    console.log('[db] MongoDB connection closed on app termination');
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    await mongoose.connection.close();
    console.log('[db] MongoDB connection closed on SIGTERM');
    process.exit(0);
  });

  await mongoose.connect(config.mongoUri, {
    serverSelectionTimeoutMS: 10_000,
  });
}

