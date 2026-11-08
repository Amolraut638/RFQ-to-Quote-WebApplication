/**
 * routes/quote.routes.ts
 *
 * Quote-level endpoints (e.g., side-by-side revision comparison).
 */

import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { authorizeRoles } from '../middleware/authorizeRoles';
import { compareQuoteRevisionsHandler } from '../controllers/quoteRevisionComparison.controller';

const router = Router();

router.use(authenticate);

/**
 * GET /api/quotes/:quoteId/compare?versionA=1&versionB=2
 * Accessible to authenticated ESTIMATOR and SALES_HEAD users.
 */
router.get(
  '/:quoteId/compare',
  authorizeRoles('ESTIMATOR', 'SALES_HEAD'),
  compareQuoteRevisionsHandler,
);

export default router;
