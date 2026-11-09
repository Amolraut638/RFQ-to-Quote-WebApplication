/**
 * controllers/rfq.controller.ts
 */

import { Request, Response, NextFunction } from 'express';
import * as RFQService from '../services/rfq.service';
import { RFQServiceError } from '../services/rfq.service';
import { CreateRFQSchema, UpdateRFQOutcomeSchema } from '../validators/rfq.validator';
import { createPart, CreatePartSchema, PartServiceError } from '../services/part.service';
import {
  importHistoricalQuotesFromBuffer,
  generateHistoricalImportTemplateBuffer,
  generateSynthetic1400HistoricalWorkbookBuffer,
  HistoricalImportError,
} from '../services/historicalImport.service';

export async function listRFQs(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const rfqs = await RFQService.listRFQs();
    const now = new Date();
    // Annotate each RFQ with isOverdue flag without altering DB records
    const data = rfqs.map((rfq: any) => ({
      ...rfq,
      isOverdue:
        new Date(rfq.dueDate) < now &&
        rfq.status !== 'WON' &&
        rfq.status !== 'LOST' &&
        rfq.status !== 'SENT',
    }));
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function getRFQ(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const rfq = await RFQService.getRFQById(req.params.id);
    if (!rfq) {
      res.status(404).json({ error: 'RFQ not found', code: 'RFQ_NOT_FOUND' });
      return;
    }
    const now = new Date();
    const dueDate = rfq.dueDate ? new Date(rfq.dueDate as string | Date) : null;
    const isOverdue =
      dueDate !== null &&
      dueDate < now &&
      rfq.status !== 'WON' &&
      rfq.status !== 'LOST' &&
      rfq.status !== 'SENT';
    res.json({ success: true, data: { ...rfq, isOverdue } });
  } catch (err) {
    next(err);
  }
}

export async function createRFQ(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = CreateRFQSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
      return;
    }

    const rfq = await RFQService.createRFQ({
      ...parsed.data,
      receivedDate: new Date(parsed.data.receivedDate),
      dueDate: new Date(parsed.data.dueDate),
      ownerId: req.user!.id,
    });

    res.status(201).json({ success: true, data: rfq });
  } catch (err) {
    next(err);
  }
}

export async function createRFQPart(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = CreatePartSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
      return;
    }

    const part = await createPart(req.params.rfqId, parsed.data);
    res.status(201).json({ success: true, data: part });
  } catch (err) {
    if (err instanceof PartServiceError) {
      const status = err.code === 'RFQ_NOT_FOUND' ? 404 : 400;
      res.status(status).json({ error: err.message, code: err.code });
      return;
    }
    next(err);
  }
}

/**
 * PATCH /api/rfqs/:rfqId/outcome
 * Updates the commercial outcome of an RFQ (WON | LOST).
 * Restricted to SALES_HEAD role.
 */
export async function updateRFQOutcomeHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const parsed = UpdateRFQOutcomeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: 'Validation failed',
        code: 'VALIDATION_FAILED',
        details: parsed.error.flatten(),
      });
      return;
    }

    const result = await RFQService.updateRFQOutcome({
      rfqId: req.params.rfqId,
      outcome: parsed.data.outcome,
      lostReason: parsed.data.lostReason,
      lostReasonNote: parsed.data.lostReasonNote,
      actorId: req.user!.id,
      actorRole: req.user!.role,
    });

    res.json({ success: true, data: result });
  } catch (err) {
    if (err instanceof RFQServiceError) {
      res.status(err.statusCode).json({ error: err.message, code: err.code });
      return;
    }
    next(err);
  }
}

/**
 * GET /api/rfqs/historical-import/template
 * Downloads the canonical Excel template for historical quote imports.
 */
export async function downloadHistoricalTemplateHandler(
  _req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const buffer = generateHistoricalImportTemplateBuffer();
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader(
      'Content-Disposition',
      'attachment; filename="Historical-Quotes-Import-Template.xlsx"',
    );
    res.send(buffer);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/rfqs/historical-import/synthetic-demo
 * Downloads the 1,400-row synthetic Chakan automotive historical quotes workbook.
 */
export async function downloadSyntheticDemoWorkbookHandler(
  _req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const buffer = generateSynthetic1400HistoricalWorkbookBuffer();
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader(
      'Content-Disposition',
      'attachment; filename="Synthetic-1400-Historical-Quotes-Demo.xlsx"',
    );
    res.send(buffer);
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/rfqs/historical-import
 * Parses, validates, and (unless dryRun=true) imports historical quotes from an Excel/CSV file
 * or the built-in 1,400-row synthetic demo dataset (when useSyntheticDemo=true).
 */
export async function importHistoricalQuotesHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const dryRunParam = req.query.dryRun ?? req.body?.dryRun;
    const dryRun =
      dryRunParam === true ||
      dryRunParam === 'true' ||
      dryRunParam === '1';

    const useSyntheticParam = req.query.useSyntheticDemo ?? req.body?.useSyntheticDemo;
    const useSyntheticDemo =
      useSyntheticParam === true ||
      useSyntheticParam === 'true' ||
      useSyntheticParam === '1';

    let buffer: Buffer | undefined = req.file?.buffer;
    if (!buffer && useSyntheticDemo) {
      buffer = generateSynthetic1400HistoricalWorkbookBuffer();
    }

    if (!buffer || buffer.length === 0) {
      res.status(400).json({
        error: 'Please upload an Excel (.xlsx/.xls) or CSV file, or select the 1,400-row synthetic demo dataset.',
        code: 'MISSING_FILE',
      });
      return;
    }

    const summary = await importHistoricalQuotesFromBuffer({
      buffer,
      actorId: req.user!.id,
      dryRun,
    });

    res.json({ success: true, data: summary });
  } catch (err) {
    if (err instanceof HistoricalImportError) {
      res.status(err.statusCode).json({ error: err.message, code: err.code });
      return;
    }
    next(err);
  }
}



