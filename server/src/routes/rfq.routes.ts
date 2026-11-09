/**
 * routes/rfq.routes.ts
 */

import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import {
  listRFQs,
  getRFQ,
  createRFQ,
  createRFQPart,
  updateRFQOutcomeHandler,
  downloadHistoricalTemplateHandler,
  downloadSyntheticDemoWorkbookHandler,
  importHistoricalQuotesHandler,
} from '../controllers/rfq.controller';
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

const uploadExcel = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 15 * 1024 * 1024, // 15 MB limit for historical Excel workbooks
    files: 1,
  },
});

function uploadHistoricalFile(req: Request, res: Response, next: NextFunction): void {
  uploadExcel.single('file')(req, res, (err: unknown) => {
    if (err instanceof multer.MulterError) {
      res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({
        error: err.message,
        code: err.code === 'LIMIT_FILE_SIZE' ? 'FILE_TOO_LARGE' : 'UPLOAD_ERROR',
      });
      return;
    }
    if (err) {
      next(err);
      return;
    }
    next();
  });
}

// All RFQ routes require authentication
router.use(authenticate);

// ─── Core RFQ CRUD & Historical Excel Import ──────────────────────────────────
router.get('/', listRFQs);
router.post('/', authorizeRoles('ESTIMATOR'), createRFQ);

/** GET  /api/rfqs/historical-import/template — download canonical Excel template */
router.get('/historical-import/template', downloadHistoricalTemplateHandler);

/** GET  /api/rfqs/historical-import/synthetic-demo — download 1,400-row synthetic demo workbook */
router.get('/historical-import/synthetic-demo', downloadSyntheticDemoWorkbookHandler);

/** POST /api/rfqs/historical-import — parse, dry-run, or commit historical Excel quotes */
router.post(
  '/historical-import',
  authorizeRoles('ESTIMATOR', 'SALES_HEAD'),
  uploadHistoricalFile,
  importHistoricalQuotesHandler,
);

// ─── Costing workflow (nested under rfqId) ───────────────────────────────────
// Order matters: more specific paths first to avoid /:id catching sub-paths.

/** POST /api/rfqs/:rfqId/parts — ESTIMATOR only */
router.post('/:rfqId/parts', authorizeRoles('ESTIMATOR'), createRFQPart);

/** PATCH /api/rfqs/:rfqId/outcome — SALES_HEAD only (WON | LOST commercial outcome) */
router.patch('/:rfqId/outcome', authorizeRoles('SALES_HEAD'), updateRFQOutcomeHandler);

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
