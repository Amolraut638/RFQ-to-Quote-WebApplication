/**
 * controllers/approval.controller.ts
 *
 * HTTP handlers for the Sales Head approval workflow.
 *
 * GET  /api/approvals/pending              → list all PENDING_APPROVAL quotes
 * GET  /api/approvals/:quoteId             → get one quote with audit trail
 * POST /api/approvals/:quoteId/approve     → approve the quote
 * POST /api/approvals/:quoteId/reject      → reject with mandatory comment
 *
 * All routes require SALES_HEAD role (enforced by the router middleware).
 */

import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import {
  getPendingApprovals,
  getQuoteById,
  approveQuote,
  rejectQuote,
  getQuoteEvents,
  QuoteServiceError,
} from '../services/quote.service';
import { RejectQuoteSchema } from '../validators/approval.validator';
import type { IQuote, IRateSnapshot } from '../models/Quote';
import type { IQuoteEvent } from '../models/QuoteEvent';

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

function serializePopulatedRef(ref: unknown): unknown {
  if (!ref) return undefined;
  if (typeof ref === 'string') return ref;
  const r = ref as Record<string, unknown>;
  if (r['_id']) {
    return {
      _id: String(r['_id']),
      name: r['name'],
      email: r['email'],
      role: r['role'],
      rfqNo: r['rfqNo'],
      customer: r['customer'],
      dueDate: r['dueDate'],
    };
  }
  return String(ref);
}

function serializeQuoteForApproval(q: IQuote): Record<string, unknown> {
  const raw = q as unknown as Record<string, unknown>;
  return {
    _id: String(raw['_id']),
    rfqId: serializePopulatedRef(raw['rfqId']),
    version: raw['version'],
    status: raw['status'],
    totalAnnualValue: d128Str(raw['totalAnnualValue'] as mongoose.Types.Decimal128),
    annualQuotationValue: raw['annualQuotationValue'],
    costingDate: raw['costingDate'],
    createdBy: serializePopulatedRef(raw['createdBy']),
    approverId: serializePopulatedRef(raw['approverId']),
    approvedAt: raw['approvedAt'],
    rejectedBy: raw['rejectedBy'] ? String(raw['rejectedBy']) : undefined,
    rejectedAt: raw['rejectedAt'],
    rejectionComment: raw['rejectionComment'],
    submittedBy: raw['submittedBy'] ? String(raw['submittedBy']) : undefined,
    submittedAt: raw['submittedAt'],
    sentBy: raw['sentBy'] ? String(raw['sentBy']) : undefined,
    sentAt: raw['sentAt'],
    costBreakdown: raw['costBreakdown'],
    volumeTierResults: raw['volumeTierResults'],
    rateSnapshot: raw['rateSnapshot'] ? serializeRateSnapshot(raw['rateSnapshot'] as IRateSnapshot) : undefined,
    costingInputSnapshot: (() => {
      const cs = raw['costingInputSnapshot'] as IQuote['costingInputSnapshot'] | undefined;
      if (!cs) return undefined;
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
    })(),
    createdAt: raw['createdAt'],
    updatedAt: raw['updatedAt'],
  };
}

function serializeEvent(e: IQuoteEvent): Record<string, unknown> {
  const raw = e as unknown as Record<string, unknown>;
  return {
    _id: String(raw['_id']),
    action: raw['action'],
    actorId: serializePopulatedRef(raw['actorId']),
    timestamp: raw['timestamp'],
    comment: raw['comment'],
  };
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

/** GET /api/approvals/pending */
export async function getPendingApprovalsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const quotes = await getPendingApprovals();
    res.json({ success: true, data: quotes.map(serializeQuoteForApproval) });
  } catch (err) {
    next(err);
  }
}

/** GET /api/approvals/:quoteId */
export async function getQuoteForApprovalHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { quoteId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(quoteId)) {
      res.status(400).json({ error: 'Invalid quoteId' });
      return;
    }

    const quote = await getQuoteById(new mongoose.Types.ObjectId(quoteId));
    if (!quote) {
      res.status(404).json({ error: 'Quote not found' });
      return;
    }

    const events = await getQuoteEvents(new mongoose.Types.ObjectId(quoteId));

    res.json({
      success: true,
      data: {
        quote: serializeQuoteForApproval(quote),
        events: events.map(serializeEvent),
      },
    });
  } catch (err) {
    next(err);
  }
}

/** POST /api/approvals/:quoteId/approve */
export async function approveQuoteHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { quoteId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(quoteId)) {
      res.status(400).json({ error: 'Invalid quoteId' });
      return;
    }

    const approverId = new mongoose.Types.ObjectId(req.user!.id);

    const existing = await getQuoteById(new mongoose.Types.ObjectId(quoteId));
    if (!existing) {
      res.status(404).json({ error: 'Quote not found' });
      return;
    }

    const quote = await approveQuote({
      rfqId: existing.rfqId as mongoose.Types.ObjectId,
      version: existing.version,
      approverId,
    });

    res.json({ success: true, data: serializeQuoteForApproval(quote) });
  } catch (err) {
    if (err instanceof QuoteServiceError) {
      const status =
        err.code === 'QUOTE_NOT_FOUND' ? 404 :
        err.code === 'QUOTE_IMMUTABLE' || err.code === 'STATUS_CONFLICT' ? 409 : 400;
      res.status(status).json({ error: err.message, code: err.code });
      return;
    }
    next(err);
  }
}

/** POST /api/approvals/:quoteId/reject — body: { comment: string } */
export async function rejectQuoteHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { quoteId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(quoteId)) {
      res.status(400).json({ error: 'Invalid quoteId' });
      return;
    }

    const parsed = RejectQuoteSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
      return;
    }
    const { comment } = parsed.data;

    const rejecterId = new mongoose.Types.ObjectId(req.user!.id);

    const existing = await getQuoteById(new mongoose.Types.ObjectId(quoteId));
    if (!existing) {
      res.status(404).json({ error: 'Quote not found' });
      return;
    }

    const quote = await rejectQuote(
      existing.rfqId as mongoose.Types.ObjectId,
      existing.version,
      rejecterId,
      comment,
    );

    res.json({ success: true, data: serializeQuoteForApproval(quote) });
  } catch (err) {
    if (err instanceof QuoteServiceError) {
      const status =
        err.code === 'QUOTE_NOT_FOUND' ? 404 :
        err.code === 'QUOTE_IMMUTABLE' || err.code === 'STATUS_CONFLICT' ? 409 : 400;
      res.status(status).json({ error: err.message, code: err.code });
      return;
    }
    next(err);
  }
}
