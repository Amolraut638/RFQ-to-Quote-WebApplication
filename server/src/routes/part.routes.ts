/**
 * routes/part.routes.ts
 *
 * Part-specific routes (e.g. historical routing suggestions).
 */

import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { authorizeRoles } from '../middleware/authorizeRoles';
import { getPartRoutingSuggestionsHandler } from '../controllers/intake.controller';
import {
  listHistoricalQuotesForPartHandler,
  compareHistoricalQuoteHandler,
} from '../controllers/historicalComparison.controller';

const router = Router();

router.use(authenticate);

/** GET /api/parts/:id/routing-suggestions — ESTIMATOR only */
router.get(
  '/:id/routing-suggestions',
  authorizeRoles('ESTIMATOR'),
  getPartRoutingSuggestionsHandler,
);

/** GET /api/parts/:id/historical-quotes — authenticated users (ESTIMATOR or SALES_HEAD) */
router.get(
  '/:id/historical-quotes',
  authorizeRoles('ESTIMATOR', 'SALES_HEAD'),
  listHistoricalQuotesForPartHandler,
);

/** POST /api/parts/:id/historical-quotes/:quoteId/compare — authenticated users (ESTIMATOR or SALES_HEAD) */
router.post(
  '/:id/historical-quotes/:quoteId/compare',
  authorizeRoles('ESTIMATOR', 'SALES_HEAD'),
  compareHistoricalQuoteHandler,
);

export default router;

