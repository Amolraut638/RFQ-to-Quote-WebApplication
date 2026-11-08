/**
 * controllers/quoteRevisionComparison.controller.ts
 *
 * HTTP handler for:
 *   GET /api/quotes/:quoteId/compare?versionA=1&versionB=2
 */

import { Request, Response, NextFunction } from 'express';
import {
  compareQuoteRevisions,
  QuoteRevisionComparisonError,
} from '../services/quoteRevisionComparison.service';

export async function compareQuoteRevisionsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { quoteId } = req.params;
    const rawVersionA = req.query.versionA;
    const rawVersionB = req.query.versionB;

    const versionA =
      rawVersionA !== undefined && rawVersionA !== '' ? Number(rawVersionA) : undefined;
    const versionB =
      rawVersionB !== undefined && rawVersionB !== '' ? Number(rawVersionB) : undefined;

    const result = await compareQuoteRevisions({
      quoteId,
      versionA,
      versionB,
    });

    res.json({ success: true, data: result });
  } catch (err) {
    if (err instanceof QuoteRevisionComparisonError) {
      const statusMap: Record<QuoteRevisionComparisonError['code'], number> = {
        INVALID_ID: 400,
        INVALID_VERSION_PARAM: 400,
        QUOTE_NOT_FOUND: 404,
        VERSION_NOT_FOUND: 404,
        RFQ_MISMATCH: 422,
        PART_MISMATCH: 422,
        SNAPSHOT_INCOMPLETE: 422,
      };
      res.status(statusMap[err.code] ?? 400).json({
        error: err.message,
        code: err.code,
      });
      return;
    }
    next(err);
  }
}
