/**
 * services/quote.service.ts
 *
 * Business logic for creating, revising, and approving quotation versions.
 *
 * Immutability rules (enforced server-side, not just in comments):
 *  - PENDING_APPROVAL, APPROVED, SENT versions may NOT be edited or deleted.
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
import type { CostingInput, CostingResult, VolumeTierOutput, CostingOutput } from '@rfq/costing-engine';

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
 * Submit a DRAFT quote for approval (DRAFT → PENDING_APPROVAL).
 * Immutable statuses are blocked.
 */
export async function submitForApproval(rfqId: mongoose.Types.ObjectId, version: number): Promise<IQuote> {
  const quote = await Quote.findOne({ rfqId, version });
  if (!quote) throw new QuoteServiceError('QUOTE_NOT_FOUND', `Quote rfqId=${rfqId} v${version} not found`);

  assertMutable(quote);

  if (quote.status !== 'DRAFT') {
    throw new QuoteServiceError('INVALID_STATUS_TRANSITION', `Only DRAFT quotes can be submitted for approval; current status: ${quote.status}`);
  }

  quote.status = 'PENDING_APPROVAL';
  return quote.save();
}

/**
 * Approve a PENDING_APPROVAL quote (PENDING_APPROVAL → APPROVED).
 * Records the approver and timestamp. Immutable after approval.
 */
export async function approveQuote(params: ApproveQuoteParams): Promise<IQuote> {
  const { rfqId, version, approverId } = params;
  const quote = await Quote.findOne({ rfqId, version });
  if (!quote) throw new QuoteServiceError('QUOTE_NOT_FOUND', `Quote rfqId=${rfqId} v${version} not found`);

  if (quote.status !== 'PENDING_APPROVAL') {
    throw new QuoteServiceError('INVALID_STATUS_TRANSITION', `Only PENDING_APPROVAL quotes can be approved; current status: ${quote.status}`);
  }

  quote.status = 'APPROVED';
  quote.approverId = approverId;
  quote.approvedAt = new Date();
  return quote.save();
}

/**
 * Reject a PENDING_APPROVAL quote (PENDING_APPROVAL → REJECTED).
 * Rejected versions remain in history and cannot be deleted.
 */
export async function rejectQuote(rfqId: mongoose.Types.ObjectId, version: number): Promise<IQuote> {
  const quote = await Quote.findOne({ rfqId, version });
  if (!quote) throw new QuoteServiceError('QUOTE_NOT_FOUND', `Quote rfqId=${rfqId} v${version} not found`);

  if (quote.status !== 'PENDING_APPROVAL') {
    throw new QuoteServiceError('INVALID_STATUS_TRANSITION', `Only PENDING_APPROVAL quotes can be rejected; current status: ${quote.status}`);
  }

  quote.status = 'REJECTED';
  return quote.save();
}

/**
 * Mark an APPROVED quote as SENT (APPROVED → SENT).
 */
export async function markAsSent(rfqId: mongoose.Types.ObjectId, version: number): Promise<IQuote> {
  const quote = await Quote.findOne({ rfqId, version });
  if (!quote) throw new QuoteServiceError('QUOTE_NOT_FOUND', `Quote rfqId=${rfqId} v${version} not found`);

  if (quote.status !== 'APPROVED') {
    throw new QuoteServiceError('INVALID_STATUS_TRANSITION', `Only APPROVED quotes can be marked as SENT; current status: ${quote.status}`);
  }

  quote.status = 'SENT';
  return quote.save();
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

