/**
 * services/quote.service.ts
 *
 * Business logic for creating, revising, and approving quotation versions.
 *
 * Immutability rules (enforced server-side, not just in comments):
 *  - PENDING_APPROVAL, APPROVED, READY_FOR_SALES, SENT versions may NOT be edited or deleted.
 *  - A revision always creates a new version document; it never overwrites.
 *  - Approval is associated with a specific rfqId + version pair.
 *  - REJECTED versions remain in history and cannot be deleted.
 *  - Every quote version stores a complete, frozen snapshot of:
 *      · Costing inputs
 *      · Rate snapshot (all rates used, with their effectiveFrom dates)
 *      · Three volume-tier results
 *      · Per-piece cost breakdown
 *      · Annual quotation value
 *    This snapshot is never recalculated from current rate masters.
 *
 * The service calls the costing engine synchronously for calculations and
 * the rate lookup service asynchronously for DB queries.
 */

import mongoose from 'mongoose';
import {
  Quote,
  IMMUTABLE_STATUSES,
  type QuoteStatus,
  type IQuote,
  type IRateSnapshot,
  type ICostingInputSnapshot,
  type ICostBreakdownSnapshot,
  type IVolumeTierSnapshot,
} from '../models/Quote';
import { QuoteEvent, type IQuoteEvent, type QuoteEventAction } from '../models/QuoteEvent';
import type { CostingInput, CostingResult, VolumeTierOutput, CostingOutput } from '@rfq/costing-engine';
import { evaluateApproval } from '@rfq/costing-engine';

// ─── Error types ──────────────────────────────────────────────────────────────

export type QuoteServiceErrorCode =
  | 'QUOTE_NOT_FOUND'
  | 'QUOTE_IMMUTABLE'
  | 'INVALID_STATUS_TRANSITION'
  | 'VERSION_NOT_FOUND'
  | 'STATUS_CONFLICT';

export class QuoteServiceError extends Error {
  public readonly code: QuoteServiceErrorCode;
  constructor(code: QuoteServiceErrorCode, message: string) {
    super(message);
    this.name = 'QuoteServiceError';
    this.code = code;
  }
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CreateQuoteParams {
  rfqId: mongoose.Types.ObjectId;
  partId?: mongoose.Types.ObjectId;
  createdBy: mongoose.Types.ObjectId;
  costingDate: Date;
  /** Fully assembled CostingInput (rates already looked up and injected). */
  costingInput: CostingInput;
  /** Result from calculateCosting(costingInput). */
  costingResult: CostingResult;
  /** Rate snapshot — assembled by the caller from rate lookup results. */
  rateSnapshot: IRateSnapshot;
}

export interface ReviseQuoteParams {
  rfqId: mongoose.Types.ObjectId;
  partId?: mongoose.Types.ObjectId;
  createdBy: mongoose.Types.ObjectId;
  costingDate: Date;
  costingInput: CostingInput;
  costingResult: CostingResult;
  rateSnapshot: IRateSnapshot;
}

export interface ApproveQuoteParams {
  rfqId: mongoose.Types.ObjectId;
  version: number;
  approverId: mongoose.Types.ObjectId;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function d128(s: string | number): mongoose.Types.Decimal128 {
  return mongoose.Types.Decimal128.fromString(String(s));
}

/**
 * Build an ICostingInputSnapshot from a CostingInput.
 * Converts all money values to Decimal128 for MongoDB storage.
 */
function buildInputSnapshot(input: CostingInput): ICostingInputSnapshot {
  return {
    grossWeightKg: d128(input.grossWeightKg),
    materialRatePerKg: d128(input.materialRatePerKg),
    scrapPct: Number(input.scrapPct),
    routingOperations: input.routingOperations.map((op) => ({
      operationName: op.operationName,
      machine: op.machine,
      cycleTimeMinutes: d128(op.cycleTimeMinutes),
      machineHourRate: d128(op.machineHourRate),
    })),
    overheadPct: Number(input.overheadPct),
    packingFreightPerPiece: d128(input.packingFreightPerPiece),
    setupCostPerPart: d128(input.setupCostPerPart),
    annualVolume: input.annualVolume,
    defaultMarginPct: Number(input.defaultMarginPct),
    gstPct: Number(input.gstPct),
  };
}

function buildCostBreakdown(b: CostingOutput): ICostBreakdownSnapshot {
  return {
    materialCost: b.materialCost,
    scrapCost: b.scrapCost,
    conversionCost: b.conversionCost,
    overheadCost: b.overheadCost,
    packingFreight: b.packingFreight,
    baseManufacturingCost: b.baseManufacturingCost,
    setupAllocationPerPiece: b.setupAllocationPerPiece,
    totalCost: b.totalCost,
    sellingPriceExGst: b.sellingPriceExGst,
    gstAmount: b.gstAmount,
    sellingPriceIncludingGst: b.sellingPriceIncludingGst,
  };
}

function buildTierResults(tiers: VolumeTierOutput[]): IVolumeTierSnapshot[] {
  return tiers.map((t) => ({
    tierName: t.tierName,
    tierPercentage: t.tierPercentage,
    tierVolume: t.tierVolume,
    setupAllocationPerPiece: t.setupAllocationPerPiece,
    totalCostPerPiece: t.totalCostPerPiece,
    sellingPriceExGst: t.sellingPriceExGst,
    gstAmount: t.gstAmount,
    sellingPriceIncludingGst: t.sellingPriceIncludingGst,
  }));
}

/**
 * Assert that a quote in the given status can still be mutated.
 * Throws QuoteServiceError(QUOTE_IMMUTABLE) if not.
 */
function assertMutable(quote: IQuote): void {
  if (IMMUTABLE_STATUSES.includes(quote.status)) {
    throw new QuoteServiceError(
      'QUOTE_IMMUTABLE',
      `Quote version ${quote.version} has status "${quote.status}" and cannot be modified. Create a revision instead.`,
    );
  }
}

// ─── Service functions ────────────────────────────────────────────────────────

/**
 * Create the first version (v1) of a quote for an RFQ.
 * If a draft already exists it is returned unchanged (idempotent for drafts).
 * If a non-draft exists a new version is NOT created here — use reviseQuote().
 */
export async function createQuote(params: CreateQuoteParams): Promise<IQuote> {
  const { rfqId, partId, createdBy, costingDate, costingInput, costingResult, rateSnapshot } = params;

  // If a v1 DRAFT exists for this RFQ, return it (idempotent)
  const existing = await Quote.findOne({ rfqId, version: 1, status: 'DRAFT' });
  if (existing) return existing;

  const totalAnnualValue = mongoose.Types.Decimal128.fromString(costingResult.annualQuotationValue);

  const quote = await Quote.create({
    rfqId,
    ...(partId ? { partId } : {}),
    version: 1,
    status: 'DRAFT',
    totalAnnualValue,
    costingDate,
    createdBy,
    rateSnapshot,
    costingInputSnapshot: buildInputSnapshot(costingInput),
    costBreakdown: buildCostBreakdown(costingResult.breakdown),
    volumeTierResults: buildTierResults(costingResult.volumeTiers),
    annualQuotationValue: costingResult.annualQuotationValue,
  });

  return quote;
}

/**
 * Revise an existing quote — creates a new version document.
 * The previous version is preserved unchanged in the database.
 * Any status is allowed for the PREVIOUS version (even REJECTED),
 * but PENDING_APPROVAL / APPROVED / SENT versions cannot be "replaced" —
 * the new revision is a sibling document, not an edit.
 */
export async function reviseQuote(params: ReviseQuoteParams): Promise<IQuote> {
  const { rfqId, partId, createdBy, costingDate, costingInput, costingResult, rateSnapshot } = params;

  // Find the highest existing version for this RFQ
  const latest = await Quote.findOne({ rfqId }).sort({ version: -1 }).lean();
  const nextVersion = latest ? latest.version + 1 : 1;

  const totalAnnualValue = mongoose.Types.Decimal128.fromString(costingResult.annualQuotationValue);

  const quote = await Quote.create({
    rfqId,
    ...(partId ? { partId } : {}),
    version: nextVersion,
    status: 'DRAFT',
    totalAnnualValue,
    costingDate,
    createdBy,
    rateSnapshot,
    costingInputSnapshot: buildInputSnapshot(costingInput),
    costBreakdown: buildCostBreakdown(costingResult.breakdown),
    volumeTierResults: buildTierResults(costingResult.volumeTiers),
    annualQuotationValue: costingResult.annualQuotationValue,
  });

  return quote;
}

/**
 * Shared transactional status transition.
 *
 * In ONE MongoDB transaction:
 *   1. Conditionally update the quote: the filter includes `status: { $in: from }`,
 *      so the update only applies if the quote is still in an expected previous state.
 *   2. Write the matching QuoteEvent with the same session.
 *
 * If another request already moved the quote (conditional update matches nothing) a
 * STATUS_CONFLICT error is thrown and nothing is written. If the audit write fails,
 * the transaction aborts and the status change is rolled back. Errors are never swallowed.
 */
async function transitionWithAudit(args: {
  rfqId: mongoose.Types.ObjectId;
  version: number;
  from: readonly QuoteStatus[];
  set: Record<string, unknown>;
  action: QuoteEventAction;
  actorId: mongoose.Types.ObjectId;
  at: Date;
  comment?: string;
}): Promise<IQuote> {
  const { rfqId, version, from, set, action, actorId, at, comment } = args;
  const session = await mongoose.startSession();
  try {
    let saved: IQuote | undefined;
    await session.withTransaction(async () => {
      const updated = await Quote.findOneAndUpdate(
        { rfqId, version, status: { $in: from } },
        { $set: set },
        { new: true, session },
      );
      if (!updated) {
        throw new QuoteServiceError(
          'STATUS_CONFLICT',
          `Quote rfqId=${rfqId} v${version} is no longer in ${from.join(' / ')} ` +
            `(it was changed by another request); ${action} not applied.`,
        );
      }
      await QuoteEvent.create(
        [
          {
            quoteId: updated._id,
            rfqId,
            version,
            action,
            actorId,
            timestamp: at,
            ...(comment ? { comment } : {}),
          },
        ],
        { session },
      );
      saved = updated;
    });
    return saved as IQuote;
  } finally {
    await session.endSession();
  }
}

async function loadQuote(rfqId: mongoose.Types.ObjectId, version: number): Promise<IQuote> {
  const quote = await Quote.findOne({ rfqId, version });
  if (!quote) throw new QuoteServiceError('QUOTE_NOT_FOUND', `Quote rfqId=${rfqId} v${version} not found`);
  return quote;
}

/**
 * Submit a DRAFT quote for approval.
 *  - Annual value STRICTLY > ₹25,00,000 → PENDING_APPROVAL
 *  - Annual value ≤ ₹25,00,000          → READY_FOR_SALES
 * Target status is derived from the persisted annualQuotationValue via evaluateApproval.
 * Atomic with the SUBMITTED event; only succeeds from DRAFT.
 */
export async function submitForApproval(
  rfqId: mongoose.Types.ObjectId,
  version: number,
  submitterId: mongoose.Types.ObjectId,
): Promise<IQuote> {
  const quote = await loadQuote(rfqId, version);
  assertMutable(quote);
  if (quote.status !== 'DRAFT') {
    throw new QuoteServiceError(
      'INVALID_STATUS_TRANSITION',
      `Only DRAFT quotes can be submitted; current status: ${quote.status}`,
    );
  }

  const decision = evaluateApproval([quote.annualQuotationValue]);
  const at = new Date();
  return transitionWithAudit({
    rfqId,
    version,
    from: ['DRAFT'],
    set: {
      status: decision.requiresApproval ? 'PENDING_APPROVAL' : 'READY_FOR_SALES',
      submittedBy: submitterId,
      submittedAt: at,
    },
    action: 'SUBMITTED',
    actorId: submitterId,
    at,
  });
}

/**
 * Approve a PENDING_APPROVAL quote. Exactly one concurrent approver can win.
 */
export async function approveQuote(params: ApproveQuoteParams): Promise<IQuote> {
  const { rfqId, version, approverId } = params;
  const existing = await loadQuote(rfqId, version);
  if (existing.status !== 'PENDING_APPROVAL') {
    throw new QuoteServiceError(
      'INVALID_STATUS_TRANSITION',
      `Only PENDING_APPROVAL quotes can be approved; current status: ${existing.status}`,
    );
  }
  const at = new Date();
  return transitionWithAudit({
    rfqId,
    version,
    from: ['PENDING_APPROVAL'],
    set: { status: 'APPROVED', approverId, approvedAt: at },
    action: 'APPROVED',
    actorId: approverId,
    at,
  });
}

/**
 * Reject a PENDING_APPROVAL quote. The rejecter ID and a non-empty comment are
 * required; rejected versions remain in history.
 */
export async function rejectQuote(
  rfqId: mongoose.Types.ObjectId,
  version: number,
  rejecterId: mongoose.Types.ObjectId,
  comment: string,
): Promise<IQuote> {
  if (!rejecterId) {
    throw new QuoteServiceError('INVALID_STATUS_TRANSITION', 'rejecterId is required to reject a quote');
  }
  if (!comment || !comment.trim()) {
    throw new QuoteServiceError('INVALID_STATUS_TRANSITION', 'A rejection comment is required');
  }
  const existing = await loadQuote(rfqId, version);
  if (existing.status !== 'PENDING_APPROVAL') {
    throw new QuoteServiceError(
      'INVALID_STATUS_TRANSITION',
      `Only PENDING_APPROVAL quotes can be rejected; current status: ${existing.status}`,
    );
  }
  const at = new Date();
  return transitionWithAudit({
    rfqId,
    version,
    from: ['PENDING_APPROVAL'],
    set: { status: 'REJECTED', rejectedBy: rejecterId, rejectedAt: at, rejectionComment: comment },
    action: 'REJECTED',
    actorId: rejecterId,
    at,
    comment,
  });
}

/**
 * Mark an APPROVED or READY_FOR_SALES quote as SENT. Atomic with the SENT event;
 * exactly one concurrent request can win.
 */
export async function markAsSent(
  rfqId: mongoose.Types.ObjectId,
  version: number,
  sentById: mongoose.Types.ObjectId,
): Promise<IQuote> {
  const existing = await loadQuote(rfqId, version);
  if (existing.status !== 'APPROVED' && existing.status !== 'READY_FOR_SALES') {
    throw new QuoteServiceError(
      'INVALID_STATUS_TRANSITION',
      `Only APPROVED or READY_FOR_SALES quotes can be marked as SENT; current status: ${existing.status}`,
    );
  }
  const at = new Date();
  return transitionWithAudit({
    rfqId,
    version,
    from: ['APPROVED', 'READY_FOR_SALES'],
    set: { status: 'SENT', sentBy: sentById, sentAt: at },
    action: 'SENT',
    actorId: sentById,
    at,
  });
}


/**
 * Retrieve all versions of a quote for an RFQ, ordered oldest first.
 */
export async function getQuoteHistory(rfqId: mongoose.Types.ObjectId): Promise<IQuote[]> {
  return Quote.find({ rfqId }).sort({ version: 1 });
}

/**
 * Retrieve a specific version of a quote.
 */
export async function getQuoteVersion(rfqId: mongoose.Types.ObjectId, version: number): Promise<IQuote | null> {
  return Quote.findOne({ rfqId, version });
}

/**
 * Retrieve all quotes with status PENDING_APPROVAL, with RFQ and estimator info populated.
 * Used by the Sales Head approval dashboard.
 */
export async function getPendingApprovals(): Promise<IQuote[]> {
  return Quote.find({ status: 'PENDING_APPROVAL' })
    .populate('rfqId', 'rfqNo customer dueDate')
    .populate('createdBy', 'name email')
    .sort({ createdAt: -1 });
}

/**
 * Retrieve a specific quote by its _id, with related documents populated.
 * Used by the approval review page.
 */
export async function getQuoteById(quoteId: mongoose.Types.ObjectId): Promise<IQuote | null> {
  return Quote.findById(quoteId)
    .populate('rfqId', 'rfqNo customer dueDate')
    .populate('createdBy', 'name email')
    .populate('approverId', 'name email')
    .populate('rejectedBy', 'name email');
}

/**
 * Retrieve the audit trail for a specific quote, ordered chronologically.
 * Used by the quote review page.
 */
export async function getQuoteEvents(quoteId: mongoose.Types.ObjectId): Promise<IQuoteEvent[]> {
  return QuoteEvent.find({ quoteId })
    .populate('actorId', 'name email role')
    .sort({ timestamp: 1 });
}
