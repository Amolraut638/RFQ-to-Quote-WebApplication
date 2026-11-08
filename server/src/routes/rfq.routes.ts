/**
 * routes/rfq.routes.ts
 */

import { Router } from 'express';
import { listRFQs, getRFQ, createRFQ, createRFQPart } from '../controllers/rfq.controller';
import {
  getCostingContextHandler,
  getCostingPreviewHandler,
  saveQuoteHandler,
  listQuotesHandler,
  getQuoteHandler,
  submitQuoteHandler,
  markSentHandler,
  downloadQuotePdfHandler,
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

/** POST /api/rfqs/:rfqId/parts — ESTIMATOR only */
router.post('/:rfqId/parts', authorizeRoles('ESTIMATOR'), createRFQPart);

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

/** POST /api/rfqs/:rfqId/quotes/:quoteId/submit — ESTIMATOR only */
router.post('/:rfqId/quotes/:quoteId/submit', authorizeRoles('ESTIMATOR'), submitQuoteHandler);

/** POST /api/rfqs/:rfqId/quotes/:quoteId/mark-sent — SALES_HEAD only */
router.post('/:rfqId/quotes/:quoteId/mark-sent', authorizeRoles('SALES_HEAD'), markSentHandler);

/** GET  /api/rfqs/:rfqId/quotes/:quoteId/pdf — both roles (status check inside handler) */
router.get('/:rfqId/quotes/:quoteId/pdf', downloadQuotePdfHandler);

// ─── Single RFQ (must come AFTER sub-paths) ───────────────────────────────────
router.get('/:id', getRFQ);

export default router;
