/**
 * routes/rfq.routes.ts
 */

import { Router } from 'express';
import { listRFQs, getRFQ, createRFQ } from '../controllers/rfq.controller';
import { authenticate } from '../middleware/authenticate';
import { authorizeRoles } from '../middleware/authorizeRoles';

const router = Router();

// All RFQ routes require authentication
router.use(authenticate);

router.get('/', listRFQs);
router.get('/:id', getRFQ);
router.post('/', authorizeRoles('ESTIMATOR'), createRFQ);

export default router;

