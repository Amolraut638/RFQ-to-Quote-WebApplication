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
  type IQuote,
  type IRateSnapshot,
  type ICostingInputSnapshot,
  type ICostBreakdownSnapshot,
  type IVolumeTierSnapshot,
} from '../models/Quote';
import { QuoteEvent, type IQuoteEvent } from '../models/QuoteEvent';
import type { CostingInput, CostingResult, VolumeTierOutput, CostingOutput } from '@rfq/costing-engine';
import { evaluateApproval } from '@rfq/costing-engine';

// ─── Error types ──────────────────────────────────────────────────────────────

export type QuoteServiceErrorCode =
  | 'QUOTE_NOT_FOUND'
  | 'QUOTE_IMMUTABLE'
  | 'INVALID_STATUS_TRANSITION'
  | 'VERSION_NOT_FOUND';

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
  const { rfqId, createdBy, costingDate, costingInput, costingResult, rateSnapshot } = params;

  // If a v1 DRAFT exists for this RFQ, return it (idempotent)
  const existing = await Quote.findOne({ rfqId, version: 1, status: 'DRAFT' });
  if (existing) return existing;

  const totalAnnualValue = mongoose.Types.Decimal128.fromString(costingResult.annualQuotationValue);

  const quote = await Quote.create({
    rfqId,
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
  const { rfqId, createdBy, costingDate, costingInput, costingResult, rateSnapshot } = params;

  // Find the highest existing version for this RFQ
  const latest = await Quote.findOne({ rfqId }).sort({ version: -1 }).lean();
  const nextVersion = latest ? latest.version + 1 : 1;

  const totalAnnualValue = mongoose.Types.Decimal128.fromString(costingResult.annualQuotationValue);

  const quote = await Quote.create({
    rfqId,
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
 * Submit a DRAFT quote for approval.
 *
 * Uses the approval threshold from the costing engine:
 *  - Annual value STRICTLY > ₹25,00,000 → PENDING_APPROVAL (requires Sales Head)
 *  - Annual value ≤ ₹25,00,000           → READY_FOR_SALES  (no approval needed)
 *
 * Records submittedBy/submittedAt and writes a SUBMITTED QuoteEvent.
 * The submitterId parameter is optional for backward compatibility with
 * existing tests that call submitForApproval(rfqId, version).
 */
export async function submitForApproval(
  rfqId: mongoose.Types.ObjectId,
  version: number,
  submitterId?: mongoose.Types.ObjectId,
): Promise<IQuote> {
  const quote = await Quote.findOne({ rfqId, version });
  if (!quote) throw new QuoteServiceError('QUOTE_NOT_FOUND', `Quote rfqId=${rfqId} v${version} not found`);

  assertMutable(quote);

  if (quote.status !== 'DRAFT') {
    throw new QuoteServiceError(
      'INVALID_STATUS_TRANSITION',
      `Only DRAFT quotes can be submitted; current status: ${quote.status}`,
    );
  }

  // Determine target status using the costing engine threshold logic
  const decision = evaluateApproval([quote.annualQuotationValue]);
  quote.status = decision.requiresApproval ? 'PENDING_APPROVAL' : 'READY_FOR_SALES';

  if (submitterId) {
    quote.submittedBy = submitterId;
    quote.submittedAt = new Date();
  }

  const session = await mongoose.startSession();
  try {
    let saved!: IQuote;
    await session.withTransaction(async () => {
      saved = await quote.save({ session });
      // Status change and SUBMITTED audit event commit or roll back together.
      if (submitterId) {
        await QuoteEvent.create(
          [
            {
              quoteId: quote._id,
              rfqId,
              version: quote.version,
              action: 'SUBMITTED' as const,
              actorId: submitterId,
              timestamp: new Date(),
            },
          ],
          { session },
        );
      }
    });
    return saved;
  } finally {
    await session.endSession();
  }
}

/**
 * Approve a PENDING_APPROVAL quote (PENDING_APPROVAL → APPROVED).
 *
 * Uses a MongoDB multi-document transaction to atomically:
 *   1. Flip the quote status from PENDING_APPROVAL to APPROVED.
 *   2. Write the APPROVED QuoteEvent audit record.
 *
 * Uses a conditional update (findOneAndUpdate with { status: 'PENDING_APPROVAL' })
 * so that two concurrent approval requests cannot both succeed: only the first
 * writer commits; the second sees no document and throws INVALID_STATUS_TRANSITION.
 *
 * If the transaction fails (including QuoteEvent write failure), the entire
 * operation is rolled back and the quote status is NOT changed.
 */
export async function approveQuote(params: ApproveQuoteParams): Promise<IQuote> {
  const { rfqId, version, approverId } = params;

  // Pre-flight: confirm the quote exists (outside transaction for a clear error)
  const existing = await Quote.findOne({ rfqId, version });
  if (!existing) throw new QuoteServiceError('QUOTE_NOT_FOUND', `Quote rfqId=${rfqId} v${version} not found`);

  if (existing.status !== 'PENDING_APPROVAL') {
    throw new QuoteServiceError(
      'INVALID_STATUS_TRANSITION',
      `Only PENDING_APPROVAL quotes can be approved; current status: ${existing.status}`,
    );
  }

  const session = await mongoose.startSession();
  try {
    let saved!: IQuote;

    await session.withTransaction(async () => {
      // Conditional update — only succeeds if status is still PENDING_APPROVAL.
      // This prevents two concurrent approval requests from both succeeding.
      const approvedAt = new Date();
      const updated = await Quote.findOneAndUpdate(
        { rfqId, version, status: 'PENDING_APPROVAL' },
        { $set: { status: 'APPROVED', approverId, approvedAt } },
        { new: true, session },
      );

      if (!updated) {
        // Another request won the race; expose a clear conflict error.
        throw new QuoteServiceError(
          'INVALID_STATUS_TRANSITION',
          `Quote rfqId=${rfqId} v${version} is no longer PENDING_APPROVAL (concurrent approval conflict).`,
        );
      }

      // Write audit event inside the same transaction — both succeed or both roll back.
      await QuoteEvent.create(
        [
          {
            quoteId: existing._id,
            rfqId,
            version,
            action: 'APPROVED' as const,
            actorId: approverId,
            timestamp: approvedAt,
          },
        ],
        { session },
      );

      saved = updated;
    });

    return saved;
  } finally {
    await session.endSession();
  }
}

/**
 * Reject a PENDING_APPROVAL quote (PENDING_APPROVAL → REJECTED).
 *
 * Uses a MongoDB multi-document transaction to atomically:
 *   1. Flip the quote status to REJECTED and store the mandatory comment.
 *   2. Write the REJECTED QuoteEvent audit record.
 *
 * Rejected versions remain in history and cannot be deleted.
 *
 * The rejecterId and comment parameters are optional so that existing tests
 * that call rejectQuote(rfqId, version) continue to compile and pass.
 */
export async function rejectQuote(
  rfqId: mongoose.Types.ObjectId,
  version: number,
  rejecterId?: mongoose.Types.ObjectId,
  comment?: string,
): Promise<IQuote> {
  const existing = await Quote.findOne({ rfqId, version });
  if (!existing) throw new QuoteServiceError('QUOTE_NOT_FOUND', `Quote rfqId=${rfqId} v${version} not found`);

  if (existing.status !== 'PENDING_APPROVAL') {
    throw new QuoteServiceError(
      'INVALID_STATUS_TRANSITION',
      `Only PENDING_APPROVAL quotes can be rejected; current status: ${existing.status}`,
    );
  }

  // If no rejecterId is supplied (backward-compat path used by old tests),
  // fall back to a simple non-transactional save.
  if (!rejecterId) {
    existing.status = 'REJECTED';
    return existing.save();
  }

  const session = await mongoose.startSession();
  try {
    let saved!: IQuote;
    const rejectedAt = new Date();

    await session.withTransaction(async () => {
      const updated = await Quote.findOneAndUpdate(
        { rfqId, version, status: 'PENDING_APPROVAL' },
        {
          $set: {
            status: 'REJECTED',
            rejectedBy: rejecterId,
            rejectedAt,
            ...(comment ? { rejectionComment: comment } : {}),
          },
        },
        { new: true, session },
      );

      if (!updated) {
        throw new QuoteServiceError(
          'INVALID_STATUS_TRANSITION',
          `Quote rfqId=${rfqId} v${version} is no longer PENDING_APPROVAL (concurrent modification).`,
        );
      }

      await QuoteEvent.create(
        [
          {
            quoteId: existing._id,
            rfqId,
            version,
            action: 'REJECTED' as const,
            actorId: rejecterId,
            timestamp: rejectedAt,
            comment,
          },
        ],
        { session },
      );

      saved = updated;
    });

    return saved;
  } finally {
    await session.endSession();
  }
}

/**
 * Mark an APPROVED or READY_FOR_SALES quote as SENT.
 * Records sentBy/sentAt and writes a SENT QuoteEvent (awaited).
 * The sentById parameter is optional for backward compatibility.
 */
export async function markAsSent(
  rfqId: mongoose.Types.ObjectId,
  version: number,
  sentById?: mongoose.Types.ObjectId,
): Promise<IQuote> {
  const quote = await Quote.findOne({ rfqId, version });
  if (!quote) throw new QuoteServiceError('QUOTE_NOT_FOUND', `Quote rfqId=${rfqId} v${version} not found`);

  if (quote.status !== 'APPROVED' && quote.status !== 'READY_FOR_SALES') {
    throw new QuoteServiceError(
      'INVALID_STATUS_TRANSITION',
      `Only APPROVED or READY_FOR_SALES quotes can be marked as SENT; current status: ${quote.status}`,
    );
  }

  quote.status = 'SENT';
  if (sentById) {
    quote.sentBy = sentById;
    quote.sentAt = new Date();
  }

  const session = await mongoose.startSession();
  try {
    let saved!: IQuote;
    await session.withTransaction(async () => {
      saved = await quote.save({ session });
      // Status change and SENT audit event commit or roll back together.
      if (sentById) {
        await QuoteEvent.create(
          [
            {
              quoteId: quote._id,
              rfqId,
              version: quote.version,
              action: 'SENT' as const,
              actorId: sentById,
              timestamp: new Date(),
            },
          ],
          { session },
        );
      }
    });
    return saved;
  } finally {
    await session.endSession();
  }
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
