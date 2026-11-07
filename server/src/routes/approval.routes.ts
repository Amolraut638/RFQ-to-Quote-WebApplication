/**
 * routes/approval.routes.ts
 *
 * Sales Head approval workflow routes.
 * All routes require authentication + SALES_HEAD role.
 */
import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { authorizeRoles } from '../middleware/authorizeRoles';
import {
  getPendingApprovalsHandler,
  getQuoteForApprovalHandler,
  approveQuoteHandler,
  rejectQuoteHandler,
} from '../controllers/approval.controller';

const router = Router();

router.use(authenticate);
router.use(authorizeRoles('SALES_HEAD'));

/** GET  /api/approvals/pending */
router.get('/pending', getPendingApprovalsHandler);

/** GET  /api/approvals/:quoteId */
router.get('/:quoteId', getQuoteForApprovalHandler);

/** POST /api/approvals/:quoteId/approve */
router.post('/:quoteId/approve', approveQuoteHandler);

/** POST /api/approvals/:quoteId/reject — body: { comment: string } */
router.post('/:quoteId/reject', rejectQuoteHandler);

export default router;

