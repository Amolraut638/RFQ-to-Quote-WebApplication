/**
 * app.ts
 *
 * Express application setup. No server listen here — that lives in index.ts.
 * This separation makes the app testable without binding a port.
 */

import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import morgan from 'morgan';
import cookieParser from 'cookie-parser';
import { config } from './config/env';
import authRoutes from './routes/auth.routes';
import rfqRoutes from './routes/rfq.routes';

const app = express();

// ---------------------------------------------------------------------------
// Security
// ---------------------------------------------------------------------------
app.use(helmet());

app.use(
  cors({
    origin: config.clientUrl,
    credentials: true, // Required for httpOnly cookie auth
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type'],
  })
);

// ---------------------------------------------------------------------------
// General middleware
// ---------------------------------------------------------------------------
app.use(morgan(config.isProduction ? 'combined' : 'dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use('/api/auth', authRoutes);
app.use('/api/rfqs', rfqRoutes);

// ---------------------------------------------------------------------------
// 404
// ---------------------------------------------------------------------------
app.use((_req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// ---------------------------------------------------------------------------
// Global error handler
// ---------------------------------------------------------------------------
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[error]', err.stack);
  res.status(500).json({
    error: config.isProduction ? 'Internal server error' : err.message,
  });
});

export default app;

