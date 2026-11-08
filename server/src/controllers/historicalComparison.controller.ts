/**
 * controllers/historicalComparison.controller.ts
 *
 * HTTP handlers for:
 *  - GET  /api/parts/:id/historical-quotes
 *  - POST /api/parts/:id/historical-quotes/:quoteId/compare
 */

import { Request, Response, NextFunction } from 'express';
import {
  searchHistoricalQuotesForPart,
  compareWithHistoricalQuote,
  HistoricalComparisonError,
} from '../services/historicalQuoteComparison.service';
import { WorkflowError } from '../services/costingWorkflow.service';
import { RateLookupError } from '../services/rateLookup.service';
import { CompareHistoricalQuoteSchema } from '../validators/costing.validator';

function handleComparisonError(
  err: unknown,
  res: Response,
  next: NextFunction,
): void {
  if (err instanceof HistoricalComparisonError) {
    const statusMap: Record<HistoricalComparisonError['code'], number> = {
      INVALID_ID: 400,
      PART_NOT_FOUND: 404,
      QUOTE_NOT_FOUND: 404,
      QUOTE_INELIGIBLE: 422,
      QUOTE_SNAPSHOT_INCOMPLETE: 422,
      INVALID_TIER: 400,
    };
    res.status(statusMap[err.code] ?? 400).json({
      error: err.message,
      code: err.code,
    });
    return;
  }
  if (err instanceof WorkflowError) {
    const status =
      err.code === 'RFQ_NOT_FOUND' ||
      err.code === 'PART_NOT_FOUND' ||
      err.code === 'PART_NOT_IN_RFQ'
        ? 404
        : 400;
    res.status(status).json({ error: err.message, code: err.code });
    return;
  }
  if (err instanceof RateLookupError) {
    const status = err.code === 'INVALID_COSTING_DATE' ? 400 : 422;
    res.status(status).json({ error: err.message, code: err.code });
    return;
  }
  next(err);
}

/**
 * GET /api/parts/:id/historical-quotes?limit=5&weightTolerancePct=35
 */
export async function listHistoricalQuotesForPartHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const partId = req.params.id;
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    const weightTolerancePct = req.query.weightTolerancePct
      ? Number(req.query.weightTolerancePct)
      : undefined;

    const result = await searchHistoricalQuotesForPart({
      partId,
      limit,
      weightTolerancePct,
    });

    res.json({ success: true, data: result });
  } catch (err) {
    handleComparisonError(err, res, next);
  }
}

/**
 * POST /api/parts/:id/historical-quotes/:quoteId/compare
 */
export async function compareHistoricalQuoteHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const parsed = CompareHistoricalQuoteSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: parsed.error.issues[0]?.message ?? 'Validation failed',
        code: 'VALIDATION_FAILED',
        details: parsed.error.flatten(),
      });
      return;
    }

    const d = parsed.data;
    const result = await compareWithHistoricalQuote({
      partId: req.params.id,
      historicalQuoteId: req.params.quoteId,
      tierPercentage: d.tierPercentage ?? 100,
      currentCostingInput: {
        rfqId: d.rfqId,
        routingOperations: d.routingOperations,
        scrapPctOverride: d.scrapPct,
        overheadPctOverride: d.overheadPct,
        packingFreightOverride: d.packingFreight,
        setupCostOverride: d.setupCost,
        marginPctOverride: d.marginPct,
        gstPctOverride: d.gstPct,
        costingDate: d.costingDate,
      },
    });

    res.json({ success: true, data: result });
  } catch (err) {
    handleComparisonError(err, res, next);
  }
}
