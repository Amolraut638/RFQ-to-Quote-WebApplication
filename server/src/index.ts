/**
 * index.ts
 *
 * Application entry point.
 * Validates config → connects DB → starts HTTP server.
 * The server does NOT accept requests until MongoDB is connected.
 */

import { config } from './config/env';   // validates env vars first
import { connectDB } from './config/db';
import app from './app';

async function bootstrap() {
  await connectDB();

  app.listen(config.port, () => {
    console.log(`[server] RFQ API running on http://localhost:${config.port}`);
    console.log(`[server] Environment: ${config.nodeEnv}`);
    console.log(`[server] CORS origin: ${config.clientUrl}`);
  });
}

bootstrap().catch((err) => {
  console.error('[server] Fatal startup error:', err.message);
  process.exit(1);
});

