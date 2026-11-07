/**
 * routes/rfq.routes.ts
 */

import { Router } from 'express';
import { listRFQs, getRFQ, createRFQ } from '../controllers/rfq.controller';
import {
  getCostingContextHandler,
  getCostingPreviewHandler,
  saveQuoteHandler,
  listQuotesHandler,
  getQuoteHandler,
} from '../controllers/costing.controller';
import { authenticate } from '../middleware/authenticate';
import { authorizeRoles } from '../middleware/authorizeRoles';

const router = Router();

// All RFQ routes require authentication
router.use(authenticate);

// ─── Core RFQ CRUD ────────────────────────────────────────────────────────────
router.get('/', listRFQs);
router.post('/', authorizeRoles('ESTIMATOR'), createRFQ);

// ─── Costing workflow (nested under rfqId) ───────────────────────────────────
// Order matters: more specific paths first to avoid /:id catching sub-paths.

/** GET  /api/rfqs/:rfqId/costing-context?partId=xxx&costingDate=... */
router.get('/:rfqId/costing-context', getCostingContextHandler);

/** POST /api/rfqs/:rfqId/costing-preview — both roles can preview */
router.post('/:rfqId/costing-preview', getCostingPreviewHandler);

/** POST /api/rfqs/:rfqId/quotes — ESTIMATOR only */
router.post('/:rfqId/quotes', authorizeRoles('ESTIMATOR'), saveQuoteHandler);

/** GET  /api/rfqs/:rfqId/quotes — both roles */
router.get('/:rfqId/quotes', listQuotesHandler);

/** GET  /api/rfqs/:rfqId/quotes/:quoteId — both roles */
router.get('/:rfqId/quotes/:quoteId', getQuoteHandler);

// ─── Single RFQ (must come AFTER sub-paths) ───────────────────────────────────
router.get('/:id', getRFQ);

export default router;
