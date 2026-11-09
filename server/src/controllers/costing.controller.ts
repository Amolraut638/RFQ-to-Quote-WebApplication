/**
 * controllers/costing.controller.ts
 *
 * HTTP handlers for the costing workflow:
 *   GET  /api/rfqs/:rfqId/costing-context
 *   POST /api/rfqs/:rfqId/costing-preview
 *   POST /api/rfqs/:rfqId/quotes           (ESTIMATOR)
 *   GET  /api/rfqs/:rfqId/quotes
 *   GET  /api/rfqs/:rfqId/quotes/:quoteId
 *
 * Error mapping:
 *   WorkflowError → 400 / 404
 *   RateLookupError (rate missing) → 422
 *   QuoteServiceError → 400 / 409
 *   Anything else → next(err) → 500
 */

import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import {
  getCostingContext,
  previewCosting,
  saveQuoteVersion,
  WorkflowError,
  type CostingWorkflowInput,
} from '../services/costingWorkflow.service';
import { getQuoteHistory, getQuoteVersion, QuoteServiceError } from '../services/quote.service';
import { Quote } from '../models/Quote';
import { RFQ } from '../models/RFQ';
import { RateLookupError } from '../services/rateLookup.service';
import { CostingPreviewSchema, SaveQuoteSchema } from '../validators/costing.validator';
import type { IQuote, IRateSnapshot } from '../models/Quote';
import { submitForApproval, markAsSent } from '../services/quote.service';
import { generateQuotationPdf } from '../services/quotationPdf.service';

// ─── Serialization helpers ────────────────────────────────────────────────────

function d128Str(v: mongoose.Types.Decimal128 | undefined | null): string {
  return v ? v.toString() : '0';
}

function serializeRateSnapshot(rs: IRateSnapshot): Record<string, unknown> {
  return {
    material: rs.material,
    materialRatePerKg: d128Str(rs.materialRatePerKg),
    materialRateEffectiveFrom: rs.materialRateEffectiveFrom,
    operations: rs.operations.map((op) => ({
      operationName: op.operationName,
      machine: op.machine,
      cycleTimeMinutes: d128Str(op.cycleTimeMinutes),
      machineHourRate: d128Str(op.machineHourRate),
      machineRateEffectiveFrom: op.machineRateEffectiveFrom,
    })),
    scrapPct: rs.scrapPct,
    overheadPct: rs.overheadPct,
    packingFreight: d128Str(rs.packingFreight),
    marginPct: rs.marginPct,
    gstPct: rs.gstPct,
    setupCostPerPart: d128Str(rs.setupCostPerPart),
    rateSettingEffectiveFrom: rs.rateSettingEffectiveFrom,
    snapshotCreatedAt: rs.snapshotCreatedAt,
  };
}

function serializeCostingInputSnapshot(cs: IQuote['costingInputSnapshot']): Record<string, unknown> {
  return {
    grossWeightKg: d128Str(cs.grossWeightKg),
    materialRatePerKg: d128Str(cs.materialRatePerKg),
    scrapPct: cs.scrapPct,
    routingOperations: cs.routingOperations.map((op) => ({
      operationName: op.operationName,
      machine: op.machine,
      cycleTimeMinutes: d128Str(op.cycleTimeMinutes),
      machineHourRate: d128Str(op.machineHourRate),
    })),
    overheadPct: cs.overheadPct,
    packingFreightPerPiece: d128Str(cs.packingFreightPerPiece),
    setupCostPerPart: d128Str(cs.setupCostPerPart),
    annualVolume: cs.annualVolume,
    defaultMarginPct: cs.defaultMarginPct,
    gstPct: cs.gstPct,
  };
}

function serializeQuote(quote: IQuote): Record<string, unknown> {
  const obj = quote.toObject ? quote.toObject() : (quote as unknown as Record<string, unknown>);
  return {
    _id: String(obj._id ?? (quote as any)._id),
    rfqId: String((quote as any).rfqId),
    version: (quote as any).version,
    status: (quote as any).status,
    totalAnnualValue: d128Str((quote as any).totalAnnualValue),
    annualQuotationValue: (quote as any).annualQuotationValue,
    costingDate: (quote as any).costingDate,
    createdBy: String((quote as any).createdBy),
    approverId: (quote as any).approverId ? String((quote as any).approverId) : undefined,
    approvedAt: (quote as any).approvedAt,
    rateSnapshot: serializeRateSnapshot((quote as any).rateSnapshot),
    costingInputSnapshot: serializeCostingInputSnapshot((quote as any).costingInputSnapshot),
    costBreakdown: (quote as any).costBreakdown,
    volumeTierResults: (quote as any).volumeTierResults,
    importSource: (quote as any).importSource,
    importBatchId: (quote as any).importBatchId,
    externalRowKey: (quote as any).externalRowKey,
    isSyntheticDemo: Boolean((quote as any).isSyntheticDemo),
    historicalStatedPriceExGst: (quote as any).historicalStatedPriceExGst
      ? d128Str((quote as any).historicalStatedPriceExGst)
      : undefined,
    priceDiscrepancyFlag: Boolean((quote as any).priceDiscrepancyFlag),
    priceDiscrepancyDelta: (quote as any).priceDiscrepancyDelta
      ? d128Str((quote as any).priceDiscrepancyDelta)
      : undefined,
    createdAt: (quote as any).createdAt,
    updatedAt: (quote as any).updatedAt,
  };
}

// ─── Error handler helper ─────────────────────────────────────────────────────

function handleWorkflowError(
  err: unknown,
  res: Response,
  next: NextFunction,
): void {
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
  if (err instanceof QuoteServiceError) {
    const status =
      err.code === 'QUOTE_NOT_FOUND' ? 404 :
      err.code === 'QUOTE_IMMUTABLE' || err.code === 'STATUS_CONFLICT' ? 409 : 400;
    res.status(status).json({ error: err.message, code: err.code });
    return;
  }
  next(err);
}

// ─── GET /api/rfqs/:rfqId/costing-context ─────────────────────────────────────

export async function getCostingContextHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { rfqId } = req.params;
    const { partId, costingDate } = req.query as { partId?: string; costingDate?: string };

    if (!partId) {
      res.status(400).json({ error: 'partId query parameter is required' });
      return;
    }

    const result = await getCostingContext(rfqId, partId, costingDate);
    res.json({ success: true, data: result });
  } catch (err) {
    handleWorkflowError(err, res, next);
  }
}

// ─── POST /api/rfqs/:rfqId/costing-preview ────────────────────────────────────

export async function getCostingPreviewHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { rfqId } = req.params;
    const parsed = CostingPreviewSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
      return;
    }

    const d = parsed.data;
    const workflowInput: CostingWorkflowInput = {
      rfqId,
      partId: d.partId,
      routingOperations: d.routingOperations,
      scrapPctOverride: d.scrapPct,
      overheadPctOverride: d.overheadPct,
      packingFreightOverride: d.packingFreight,
      setupCostOverride: d.setupCost,
      marginPctOverride: d.marginPct,
      gstPctOverride: d.gstPct,
      costingDate: d.costingDate,
    };

    const result = await previewCosting(workflowInput);

    // Serialize Decimal128 in rateSnapshot before sending
    const serializedResult = {
      breakdown: result.breakdown,
      volumeTiers: result.volumeTiers,
      annualQuotationValue: result.annualQuotationValue,
      approvalDecision: result.approvalDecision,
      rateSnapshot: serializeRateSnapshot(result.rateSnapshot),
      costingInput: result.costingInput,
      costingDate: result.costingDate,
    };

    res.json({ success: true, data: serializedResult });
  } catch (err) {
    handleWorkflowError(err, res, next);
  }
}

// ─── POST /api/rfqs/:rfqId/quotes ─────────────────────────────────────────────

export async function saveQuoteHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { rfqId } = req.params;
    const parsed = SaveQuoteSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
      return;
    }

    const d = parsed.data;
    const workflowInput: CostingWorkflowInput = {
      rfqId,
      partId: d.partId,
      routingOperations: d.routingOperations,
      scrapPctOverride: d.scrapPct,
      overheadPctOverride: d.overheadPct,
      packingFreightOverride: d.packingFreight,
      setupCostOverride: d.setupCost,
      marginPctOverride: d.marginPct,
      gstPctOverride: d.gstPct,
      costingDate: d.costingDate,
    };

    const userId = req.user!.id;
    const quote = await saveQuoteVersion(workflowInput, userId);

    res.status(201).json({ success: true, data: serializeQuote(quote) });
  } catch (err) {
    handleWorkflowError(err, res, next);
  }
}

// ─── GET /api/rfqs/:rfqId/quotes ──────────────────────────────────────────────

export async function listQuotesHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { rfqId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(rfqId)) {
      res.status(400).json({ error: 'Invalid rfqId' });
      return;
    }
    const quotes = await getQuoteHistory(new mongoose.Types.ObjectId(rfqId));
    res.json({ success: true, data: quotes.map(serializeQuote) });
  } catch (err) {
    next(err);
  }
}

// ─── GET /api/rfqs/:rfqId/quotes/:quoteId ─────────────────────────────────────

export async function getQuoteHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { rfqId, quoteId } = req.params;
    if (
      !mongoose.Types.ObjectId.isValid(rfqId) ||
      !mongoose.Types.ObjectId.isValid(quoteId)
    ) {
      res.status(400).json({ error: 'Invalid rfqId or quoteId' });
      return;
    }
    const quote = await Quote.findOne({
      _id: new mongoose.Types.ObjectId(quoteId),
      rfqId: new mongoose.Types.ObjectId(rfqId),
    });
    if (!quote) {
      res.status(404).json({ error: 'Quote not found' });
      return;
    }
    res.json({ success: true, data: serializeQuote(quote) });
  } catch (err) {
    next(err);
  }
}

// ─── POST /api/rfqs/:rfqId/quotes/:quoteId/submit ─────────────────────────────

export async function submitQuoteHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { rfqId, quoteId } = req.params;
    if (
      !mongoose.Types.ObjectId.isValid(rfqId) ||
      !mongoose.Types.ObjectId.isValid(quoteId)
    ) {
      res.status(400).json({ error: 'Invalid rfqId or quoteId' });
      return;
    }

    // Verify quote belongs to this rfq
    const quote = await Quote.findOne({
      _id: new mongoose.Types.ObjectId(quoteId),
      rfqId: new mongoose.Types.ObjectId(rfqId),
    });
    if (!quote) {
      res.status(404).json({ error: 'Quote not found' });
      return;
    }

    const submitterId = new mongoose.Types.ObjectId(req.user!.id);
    const updated = await submitForApproval(
      new mongoose.Types.ObjectId(rfqId),
      quote.version,
      submitterId,
    );

    res.json({ success: true, data: serializeQuote(updated) });
  } catch (err) {
    handleWorkflowError(err, res, next);
  }
}

// ─── POST /api/rfqs/:rfqId/quotes/:quoteId/mark-sent ─────────────────────────

export async function markSentHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { rfqId, quoteId } = req.params;
    if (
      !mongoose.Types.ObjectId.isValid(rfqId) ||
      !mongoose.Types.ObjectId.isValid(quoteId)
    ) {
      res.status(400).json({ error: 'Invalid rfqId or quoteId' });
      return;
    }

    const quote = await Quote.findOne({
      _id: new mongoose.Types.ObjectId(quoteId),
      rfqId: new mongoose.Types.ObjectId(rfqId),
    });
    if (!quote) {
      res.status(404).json({ error: 'Quote not found' });
      return;
    }

    const sentById = new mongoose.Types.ObjectId(req.user!.id);
    const updated = await markAsSent(
      new mongoose.Types.ObjectId(rfqId),
      quote.version,
      sentById,
    );

    res.json({ success: true, data: serializeQuote(updated) });
  } catch (err) {
    handleWorkflowError(err, res, next);
  }
}

// ─── GET /api/rfqs/:rfqId/quotes/:quoteId/pdf ────────────────────────────────

export async function downloadQuotePdfHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { rfqId, quoteId } = req.params;
    if (
      !mongoose.Types.ObjectId.isValid(rfqId) ||
      !mongoose.Types.ObjectId.isValid(quoteId)
    ) {
      res.status(400).json({ error: 'Invalid rfqId or quoteId' });
      return;
    }

    const quote = await Quote.findOne({
      _id: new mongoose.Types.ObjectId(quoteId),
      rfqId: new mongoose.Types.ObjectId(rfqId),
    });
    if (!quote) {
      res.status(404).json({ error: 'Quote not found' });
      return;
    }

    // PDF is only available for quotes that have been approved or sent
    const allowedStatuses = ['APPROVED', 'READY_FOR_SALES', 'SENT'];
    if (!allowedStatuses.includes(quote.status)) {
      res.status(403).json({
        error: `PDF not available for status "${quote.status}". Quote must be APPROVED, READY_FOR_SALES, or SENT.`,
      });
      return;
    }

    const rfq = await RFQ.findById(rfqId).lean();
    if (!rfq) {
      res.status(404).json({ error: 'RFQ not found' });
      return;
    }

    const pdfBuffer = await generateQuotationPdf(quote, rfq as { rfqNo: string; customer: string; dueDate?: Date });
    const filename = `Quotation-${rfq.rfqNo}-v${quote.version}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(pdfBuffer);
  } catch (err) {
    next(err);
  }
}

