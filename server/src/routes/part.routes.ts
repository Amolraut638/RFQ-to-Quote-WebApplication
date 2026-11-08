/**
 * routes/part.routes.ts
 *
 * Part-specific routes (e.g. historical routing suggestions).
 */

import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { authorizeRoles } from '../middleware/authorizeRoles';
import { getPartRoutingSuggestionsHandler } from '../controllers/intake.controller';

const router = Router();

router.use(authenticate);

/** GET /api/parts/:id/routing-suggestions — ESTIMATOR only */
router.get(
  '/:id/routing-suggestions',
  authorizeRoles('ESTIMATOR'),
  getPartRoutingSuggestionsHandler,
);

export default router;

