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
import approvalRoutes from './routes/approval.routes';
import intakeRoutes from './routes/intake.routes';
import partRoutes from './routes/part.routes';
import quoteRoutes from './routes/quote.routes';

const app = express();

// Trust reverse proxy (Render, AWS ALB, Cloudflare) for secure cookie handling and HTTPS protocol detection
app.set('trust proxy', 1);

// ---------------------------------------------------------------------------
// Security
// ---------------------------------------------------------------------------
app.use(helmet());

app.use(
  cors({
    origin: (requestOrigin, callback) => {
      // Allow requests with no origin (like mobile apps, curl, or server-to-server)
      if (!requestOrigin) return callback(null, true);

      const target = config.clientUrl.replace(/\/+$/, '');
      const current = requestOrigin.replace(/\/+$/, '');

      let isVercel = false;
      try {
        isVercel = new URL(requestOrigin).hostname.endsWith('.vercel.app');
      } catch {
        isVercel = false;
      }

      if (
        current === target ||
        current === 'http://localhost:5173' ||
        current === 'http://localhost:3000' ||
        isVercel
      ) {
        return callback(null, true);
      }

      return callback(new Error(`Origin ${requestOrigin} not allowed by CORS`));
    },
    credentials: true, // Required for httpOnly cookie auth
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Accept', 'Authorization'],
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
app.use('/api/approvals', approvalRoutes);
app.use('/api/intake', intakeRoutes);
app.use('/api/parts', partRoutes);
app.use('/api/quotes', quoteRoutes);
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

