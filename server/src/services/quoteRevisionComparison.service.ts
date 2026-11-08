/**
 * services/quoteRevisionComparison.service.ts
 *
 * Deterministic side-by-side comparison of two immutable Quote revisions
 * belonging to the same RFQ and the same Part.
 *
 * Rules:
 *  - Reads all rates, inputs, routing operations, breakdowns, and volume tiers
 *    exclusively from the frozen snapshots (rateSnapshot, costingInputSnapshot,
 *    costBreakdown, volumeTierResults).
 *  - Never recalculates historical quote versions from current rate masters.
 *  - Validates that both versions exist, belong to the same RFQ and the same Part,
 *    and have complete, non-corrupted snapshots.
 *  - Uses decimal.js (40-digit precision, ROUND_HALF_UP to 2 dp) for all financial
 *    and cycle-time difference calculations.
 *  - Handles zero base values safely (percentageDifference: null).
 */

import mongoose from 'mongoose';
import Decimal from 'decimal.js';
import {
  Quote,
  type IQuote,
  type QuoteStatus,
  type IVolumeTierSnapshot,
} from '../models/Quote';
import { Part, type IPart } from '../models/Part';
import { RFQ, type IRFQ } from '../models/RFQ';
import { User } from '../models/User';
import { QuoteEvent, type IQuoteEvent } from '../models/QuoteEvent';

// ─── Decimal Configuration (matches @rfq/costing-engine) ─────────────────────

const D = Decimal.clone({
  precision: 40,
  rounding: Decimal.ROUND_HALF_UP,
});

function toDec(val: unknown): Decimal {
  if (val === null || val === undefined) return new D(0);
  if (typeof val === 'number') return new D(Number.isFinite(val) ? val : 0);
  try {
    if (typeof val === 'string') {
      const cleaned = val.trim();
      return cleaned ? new D(cleaned) : new D(0);
    }
    if (typeof (val as { toString?: () => string }).toString === 'function') {
      const s = (val as { toString: () => string }).toString().trim();
      return s ? new D(s) : new D(0);
    }
  } catch {
    return new D(0);
  }
  return new D(0);
}

function toMoneyStr(d: Decimal): string {
  return d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2, Decimal.ROUND_HALF_UP);
}

function toFixedStr(d: Decimal, dp: number): string {
  return d.toDecimalPlaces(dp, Decimal.ROUND_HALF_UP).toFixed(dp, Decimal.ROUND_HALF_UP);
}

function isPositiveFiniteDecimal(val: unknown): boolean {
  try {
    const d = toDec(val);
    return d.isFinite() && d.greaterThan(0);
  } catch {
    return false;
  }
}

function isNonNegativeFiniteDecimal(val: unknown): boolean {
  try {
    const d = toDec(val);
    return d.isFinite() && d.greaterThanOrEqualTo(0);
  } catch {
    return false;
  }
}

function toIsoSafe(val: unknown, fallback?: Date): string | null {
  if (!val && !fallback) return null;
  const d = val ? new Date(val as string | number | Date) : new Date(fallback!);
  if (!Number.isNaN(d.getTime())) return d.toISOString();
  if (fallback && !Number.isNaN(new Date(fallback).getTime())) {
    return new Date(fallback).toISOString();
  }
  return null;
}

export type ChangeDirection = 'INCREASED' | 'DECREASED' | 'UNCHANGED';

function computeDelta(
  valA: unknown,
  valB: unknown,
  dp = 2,
): {
  valueA: string;
  valueB: string;
  absoluteDifference: string;
  percentageDifference: string | null;
  direction: ChangeDirection;
} {
  const a = toDec(valA);
  const b = toDec(valB);
  const diff = b.minus(a);
  const pct = a.isZero() ? null : toMoneyStr(diff.dividedBy(a).times(100));
  const direction: ChangeDirection = diff.greaterThan(0)
    ? 'INCREASED'
    : diff.lessThan(0)
    ? 'DECREASED'
    : 'UNCHANGED';

  return {
    valueA: toFixedStr(a, dp),
    valueB: toFixedStr(b, dp),
    absoluteDifference: toFixedStr(diff, dp),
    percentageDifference: pct,
    direction,
  };
}

// ─── Error Type ──────────────────────────────────────────────────────────────

export type QuoteRevisionComparisonErrorCode =
  | 'INVALID_ID'
  | 'INVALID_VERSION_PARAM'
  | 'QUOTE_NOT_FOUND'
  | 'VERSION_NOT_FOUND'
  | 'RFQ_MISMATCH'
  | 'PART_MISMATCH'
  | 'SNAPSHOT_INCOMPLETE';

export class QuoteRevisionComparisonError extends Error {
  constructor(
    public readonly code: QuoteRevisionComparisonErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'QuoteRevisionComparisonError';
  }
}

// ─── Snapshot Completeness Validation ────────────────────────────────────────

export function isCompleteQuoteRevisionSnapshot(
  quote: Partial<IQuote> | null | undefined,
): boolean {
  if (!quote) return false;

  const rs = quote.rateSnapshot;
  const cis = quote.costingInputSnapshot;
  const cb = quote.costBreakdown;
  const tiers = quote.volumeTierResults;

  if (!rs || !cis || !cb || !Array.isArray(tiers) || tiers.length === 0) return false;
  if (!rs.material || !isPositiveFiniteDecimal(rs.materialRatePerKg)) return false;
  if (!isPositiveFiniteDecimal(cis.grossWeightKg)) return false;
  if (!Array.isArray(cis.routingOperations) || cis.routingOperations.length === 0) return false;
  if (
    typeof cis.annualVolume !== 'number' ||
    !Number.isFinite(cis.annualVolume) ||
    cis.annualVolume <= 0
  ) {
    return false;
  }
  if (
    typeof rs.scrapPct !== 'number' ||
    !Number.isFinite(rs.scrapPct) ||
    typeof rs.overheadPct !== 'number' ||
    !Number.isFinite(rs.overheadPct) ||
    typeof rs.marginPct !== 'number' ||
    !Number.isFinite(rs.marginPct) ||
    typeof rs.gstPct !== 'number' ||
    !Number.isFinite(rs.gstPct) ||
    !isNonNegativeFiniteDecimal(rs.packingFreight) ||
    !isNonNegativeFiniteDecimal(rs.setupCostPerPart)
  ) {
    return false;
  }
  if (
    !isNonNegativeFiniteDecimal(cb.materialCost) ||
    !isNonNegativeFiniteDecimal(cb.scrapCost) ||
    !isNonNegativeFiniteDecimal(cb.conversionCost) ||
    !isNonNegativeFiniteDecimal(cb.overheadCost) ||
    !isNonNegativeFiniteDecimal(cb.packingFreight) ||
    !isNonNegativeFiniteDecimal(cb.setupAllocationPerPiece) ||
    !isNonNegativeFiniteDecimal(cb.totalCost) ||
    !isPositiveFiniteDecimal(cb.sellingPriceExGst) ||
    !isNonNegativeFiniteDecimal(cb.gstAmount) ||
    !isPositiveFiniteDecimal(cb.sellingPriceIncludingGst)
  ) {
    return false;
  }

  for (const pct of [50, 100, 150]) {
    const tier = tiers.find((t) => t && t.tierPercentage === pct);
    if (
      !tier ||
      typeof tier.tierVolume !== 'number' ||
      !Number.isFinite(tier.tierVolume) ||
      tier.tierVolume <= 0 ||
      !isNonNegativeFiniteDecimal(tier.setupAllocationPerPiece) ||
      !isNonNegativeFiniteDecimal(tier.totalCostPerPiece) ||
      !isPositiveFiniteDecimal(tier.sellingPriceExGst) ||
      !isNonNegativeFiniteDecimal(tier.gstAmount) ||
      !isPositiveFiniteDecimal(tier.sellingPriceIncludingGst)
    ) {
      return false;
    }
  }

  return true;
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface UserSummaryRef {
  _id: string;
  name: string;
  email: string;
  role?: string;
}

export interface RevisionEventSummary {
  action: 'SUBMITTED' | 'APPROVED' | 'REJECTED' | 'SENT';
  actor: UserSummaryRef | string;
  timestamp: string;
  comment: string | null;
}

export interface RevisionMetadata {
  quoteId: string;
  version: number;
  status: QuoteStatus;
  costingDate: string;
  createdAt: string;
  createdBy: UserSummaryRef | string;
  submittedBy: UserSummaryRef | string | null;
  submittedAt: string | null;
  approvedBy: UserSummaryRef | string | null;
  approvedAt: string | null;
  rejectedBy: UserSummaryRef | string | null;
  rejectedAt: string | null;
  rejectionComment: string | null;
  sentBy: UserSummaryRef | string | null;
  sentAt: string | null;
  events: RevisionEventSummary[];
}

export interface RevisionComparisonRow {
  key:
    | 'materialRate'
    | 'grossWeightKg'
    | 'materialCost'
    | 'scrapPct'
    | 'scrapCost'
    | 'conversionCost'
    | 'overheadPct'
    | 'overheadCost'
    | 'packingFreight'
    | 'setupCostTotal'
    | 'setupAllocationPerPiece'
    | 'totalCostPerPiece'
    | 'marginPct'
    | 'marginAmountPerPiece'
    | 'sellingPriceExGst'
    | 'annualVolume'
    | 'annualQuoteValue'
    | 'gstPct'
    | 'gstAmountPerPiece'
    | 'sellingPriceInclGst';
  label: string;
  category: 'SPEC_AND_RATES' | 'COST_BREAKDOWN' | 'SELLING_PRICE_AND_VOLUME' | 'GST';
  unit: 'INR_PER_KG' | 'INR_PER_PC' | 'INR' | 'KG' | 'PCT' | 'PCS';
  versionAValue: string;
  versionBValue: string;
  absoluteDifference: string;
  percentageDifference: string | null;
  direction: ChangeDirection;
  note?: string;
}

export type RoutingDiffStatus = 'UNCHANGED' | 'MODIFIED' | 'ADDED' | 'REMOVED';

export interface RoutingOperationDiff {
  stepNumberA: number | null;
  stepNumberB: number | null;
  operationName: string;
  status: RoutingDiffStatus;
  machineA: string | null;
  machineB: string | null;
  machineChanged: boolean;
  machineHourRateA: string | null;
  machineHourRateB: string | null;
  machineHourRateDiff: string | null;
  machineHourRatePctDiff: string | null;
  cycleTimeMinutesA: string | null;
  cycleTimeMinutesB: string | null;
  cycleTimeDiffMinutes: string | null;
  cycleTimePctDiff: string | null;
  operationCostA: string | null;
  operationCostB: string | null;
  operationCostDiff: string | null;
  operationCostPctDiff: string | null;
}

export interface TierMetricDiff {
  valueA: string;
  valueB: string;
  absoluteDifference: string;
  percentageDifference: string | null;
  direction: ChangeDirection;
}

export interface VolumeTierRevisionComparison {
  tierPercentage: 50 | 100 | 150;
  tierName: string;
  tierVolume: TierMetricDiff;
  setupAllocationPerPiece: TierMetricDiff;
  totalCostPerPiece: TierMetricDiff;
  sellingPriceExGst: TierMetricDiff;
  gstAmount: TierMetricDiff;
  sellingPriceIncludingGst: TierMetricDiff;
  tierAnnualQuoteValueExGst: TierMetricDiff;
}

export interface QuoteRevisionComparisonResult {
  rfq: {
    _id: string;
    rfqNo: string;
    customer: string;
  };
  part: {
    _id: string | null;
    partName: string;
    drawingNumber: string | null;
    materialA: string;
    materialB: string;
    materialChanged: boolean;
  };
  versionA: RevisionMetadata;
  versionB: RevisionMetadata;
  summary: {
    sellingPriceExGst: TierMetricDiff;
    totalCostPerPiece: TierMetricDiff;
    annualQuoteValue: TierMetricDiff;
    gstAmountPerPiece: TierMetricDiff;
    sellingPriceIncludingGst: TierMetricDiff;
    totalCycleTimeMinutes: TierMetricDiff;
  };
  parameterRows: RevisionComparisonRow[];
  gstRows: RevisionComparisonRow[];
  routingComparison: {
    operations: RoutingOperationDiff[];
    addedCount: number;
    removedCount: number;
    modifiedCount: number;
    unchangedCount: number;
  };
  tierComparisons: VolumeTierRevisionComparison[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function normalizeText(s: string | undefined | null): string {
  return (s ?? '').trim().toLowerCase();
}

function resolvePartForQuote(quote: IQuote, rfqParts: IPart[]): IPart | null {
  if (quote.partId) {
    const byId = rfqParts.find((p) => String(p._id) === String(quote.partId));
    return byId ?? null;
  }
  if (rfqParts.length === 1) return rfqParts[0];

  const snapMat = normalizeText(quote.rateSnapshot?.material);
  const snapWt = Number(toDec(quote.costingInputSnapshot?.grossWeightKg).toNumber());

  const byMatAndWt = rfqParts.find(
    (p) =>
      normalizeText(p.material) === snapMat &&
      Math.abs(p.grossWeightKg - snapWt) < 0.001,
  );
  if (byMatAndWt) return byMatAndWt;

  return rfqParts.find((p) => normalizeText(p.material) === snapMat) ?? rfqParts[0] ?? null;
}

/**
 * Align routing operations between version A and version B deterministically.
 * Matches operations by normalized operationName (in occurrence order),
 * falling back to positional alignment if names were renamed at the same index,
 * and marks unmatched operations as ADDED or REMOVED.
 */
export function buildRoutingComparison(
  quoteA: IQuote,
  quoteB: IQuote,
): QuoteRevisionComparisonResult['routingComparison'] {
  const opsA = (quoteA.rateSnapshot?.operations ?? quoteA.costingInputSnapshot?.routingOperations ?? []).map(
    (op, idx) => ({
      index: idx,
      operationName: op.operationName,
      machine: op.machine,
      cycleTime: toDec(op.cycleTimeMinutes),
      hourRate: toDec(op.machineHourRate),
    }),
  );

  const opsB = (quoteB.rateSnapshot?.operations ?? quoteB.costingInputSnapshot?.routingOperations ?? []).map(
    (op, idx) => ({
      index: idx,
      operationName: op.operationName,
      machine: op.machine,
      cycleTime: toDec(op.cycleTimeMinutes),
      hourRate: toDec(op.machineHourRate),
    }),
  );

  const matchedBIndices = new Set<number>();
  const matchedPairs = new Map<number, number>(); // indexA -> indexB

  // Pass 1: Match by normalized operationName in order of appearance
  for (let i = 0; i < opsA.length; i++) {
    const nameA = normalizeText(opsA[i].operationName);
    for (let j = 0; j < opsB.length; j++) {
      if (matchedBIndices.has(j)) continue;
      if (normalizeText(opsB[j].operationName) === nameA) {
        matchedPairs.set(i, j);
        matchedBIndices.add(j);
        break;
      }
    }
  }

  // Merge in sequence order preserving A's steps and interleaving B's added steps
  const diffs: RoutingOperationDiff[] = [];
  let nextBToEmit = 0;

  const emitAddedB = (bIdx: number) => {
    const b = opsB[bIdx];
    const opCostB = b.cycleTime.dividedBy(60).times(b.hourRate);
    diffs.push({
      stepNumberA: null,
      stepNumberB: b.index + 1,
      operationName: b.operationName,
      status: 'ADDED',
      machineA: null,
      machineB: b.machine,
      machineChanged: true,
      machineHourRateA: null,
      machineHourRateB: toMoneyStr(b.hourRate),
      machineHourRateDiff: null,
      machineHourRatePctDiff: null,
      cycleTimeMinutesA: null,
      cycleTimeMinutesB: toFixedStr(b.cycleTime, 2),
      cycleTimeDiffMinutes: null,
      cycleTimePctDiff: null,
      operationCostA: null,
      operationCostB: toMoneyStr(opCostB),
      operationCostDiff: null,
      operationCostPctDiff: null,
    });
  };

  for (let i = 0; i < opsA.length; i++) {
    const a = opsA[i];
    const matchedBIdx = matchedPairs.get(i);

    if (matchedBIdx !== undefined) {
      // Emit any unmatched B operations that appear before matchedBIdx
      while (nextBToEmit < matchedBIdx) {
        if (!matchedBIndices.has(nextBToEmit)) {
          emitAddedB(nextBToEmit);
        }
        nextBToEmit++;
      }
      nextBToEmit = Math.max(nextBToEmit, matchedBIdx + 1);

      const b = opsB[matchedBIdx];
      const machineChanged = normalizeText(a.machine) !== normalizeText(b.machine);
      const rateDelta = computeDelta(a.hourRate, b.hourRate, 2);
      const cycleDelta = computeDelta(a.cycleTime, b.cycleTime, 2);
      const opCostA = a.cycleTime.dividedBy(60).times(a.hourRate);
      const opCostB = b.cycleTime.dividedBy(60).times(b.hourRate);
      const opCostDelta = computeDelta(opCostA, opCostB, 2);

      const isModified =
        machineChanged ||
        rateDelta.direction !== 'UNCHANGED' ||
        cycleDelta.direction !== 'UNCHANGED';

      diffs.push({
        stepNumberA: a.index + 1,
        stepNumberB: b.index + 1,
        operationName: b.operationName || a.operationName,
        status: isModified ? 'MODIFIED' : 'UNCHANGED',
        machineA: a.machine,
        machineB: b.machine,
        machineChanged,
        machineHourRateA: rateDelta.valueA,
        machineHourRateB: rateDelta.valueB,
        machineHourRateDiff: rateDelta.absoluteDifference,
        machineHourRatePctDiff: rateDelta.percentageDifference,
        cycleTimeMinutesA: cycleDelta.valueA,
        cycleTimeMinutesB: cycleDelta.valueB,
        cycleTimeDiffMinutes: cycleDelta.absoluteDifference,
        cycleTimePctDiff: cycleDelta.percentageDifference,
        operationCostA: opCostDelta.valueA,
        operationCostB: opCostDelta.valueB,
        operationCostDiff: opCostDelta.absoluteDifference,
        operationCostPctDiff: opCostDelta.percentageDifference,
      });
    } else {
      const opCostA = a.cycleTime.dividedBy(60).times(a.hourRate);
      diffs.push({
        stepNumberA: a.index + 1,
        stepNumberB: null,
        operationName: a.operationName,
        status: 'REMOVED',
        machineA: a.machine,
        machineB: null,
        machineChanged: true,
        machineHourRateA: toMoneyStr(a.hourRate),
        machineHourRateB: null,
        machineHourRateDiff: null,
        machineHourRatePctDiff: null,
        cycleTimeMinutesA: toFixedStr(a.cycleTime, 2),
        cycleTimeMinutesB: null,
        cycleTimeDiffMinutes: null,
        cycleTimePctDiff: null,
        operationCostA: toMoneyStr(opCostA),
        operationCostB: null,
        operationCostDiff: null,
        operationCostPctDiff: null,
      });
    }
  }

  // Emit any remaining unmatched B operations
  while (nextBToEmit < opsB.length) {
    if (!matchedBIndices.has(nextBToEmit)) {
      emitAddedB(nextBToEmit);
    }
    nextBToEmit++;
  }

  return {
    operations: diffs,
    addedCount: diffs.filter((d) => d.status === 'ADDED').length,
    removedCount: diffs.filter((d) => d.status === 'REMOVED').length,
    modifiedCount: diffs.filter((d) => d.status === 'MODIFIED').length,
    unchangedCount: diffs.filter((d) => d.status === 'UNCHANGED').length,
  };
}

function buildTierComparison(
  tierPct: 50 | 100 | 150,
  tierA: IVolumeTierSnapshot,
  tierB: IVolumeTierSnapshot,
  annualValOverrideA?: Decimal,
  annualValOverrideB?: Decimal,
): VolumeTierRevisionComparison {
  const tierValA =
    tierPct === 100 && annualValOverrideA && annualValOverrideA.greaterThan(0)
      ? annualValOverrideA
      : toDec(tierA.sellingPriceExGst).times(tierA.tierVolume);
  const tierValB =
    tierPct === 100 && annualValOverrideB && annualValOverrideB.greaterThan(0)
      ? annualValOverrideB
      : toDec(tierB.sellingPriceExGst).times(tierB.tierVolume);

  return {
    tierPercentage: tierPct,
    tierName: tierB.tierName || tierA.tierName || `${tierPct}% Tier`,
    tierVolume: computeDelta(tierA.tierVolume, tierB.tierVolume, 0),
    setupAllocationPerPiece: computeDelta(
      tierA.setupAllocationPerPiece,
      tierB.setupAllocationPerPiece,
      2,
    ),
    totalCostPerPiece: computeDelta(tierA.totalCostPerPiece, tierB.totalCostPerPiece, 2),
    sellingPriceExGst: computeDelta(tierA.sellingPriceExGst, tierB.sellingPriceExGst, 2),
    gstAmount: computeDelta(tierA.gstAmount, tierB.gstAmount, 2),
    sellingPriceIncludingGst: computeDelta(
      tierA.sellingPriceIncludingGst,
      tierB.sellingPriceIncludingGst,
      2,
    ),
    tierAnnualQuoteValueExGst: computeDelta(tierValA, tierValB, 2),
  };
}

// ─── Main Service Entry Point ────────────────────────────────────────────────

export interface CompareQuoteRevisionsOptions {
  quoteId: string;
  versionA?: number;
  versionB?: number;
}

export async function compareQuoteRevisions(
  options: CompareQuoteRevisionsOptions,
): Promise<QuoteRevisionComparisonResult> {
  const { quoteId } = options;
  if (!mongoose.isValidObjectId(quoteId)) {
    throw new QuoteRevisionComparisonError('INVALID_ID', `Invalid quoteId: "${quoteId}"`);
  }

  const anchorQuote = await Quote.findById(quoteId).lean<IQuote>();
  if (!anchorQuote) {
    throw new QuoteRevisionComparisonError('QUOTE_NOT_FOUND', `Quote "${quoteId}" not found`);
  }

  const rfqId = anchorQuote.rfqId;

  // Determine versionA and versionB
  let verA = options.versionA;
  let verB = options.versionB;

  if (verA === undefined && verB === undefined) {
    // Default to comparing previous version vs anchorQuote.version
    if (anchorQuote.version > 1) {
      verA = anchorQuote.version - 1;
      verB = anchorQuote.version;
    } else {
      throw new QuoteRevisionComparisonError(
        'INVALID_VERSION_PARAM',
        'versionA and versionB query parameters are required when anchored on v1.',
      );
    }
  }

  if (
    verA === undefined ||
    verB === undefined ||
    !Number.isInteger(Number(verA)) ||
    !Number.isInteger(Number(verB)) ||
    Number(verA) < 1 ||
    Number(verB) < 1
  ) {
    throw new QuoteRevisionComparisonError(
      'INVALID_VERSION_PARAM',
      'versionA and versionB must be positive integer version numbers.',
    );
  }

  verA = Number(verA);
  verB = Number(verB);

  if (verA === verB) {
    throw new QuoteRevisionComparisonError(
      'INVALID_VERSION_PARAM',
      `Cannot compare version v${verA} against itself. Select two distinct versions.`,
    );
  }

  const [quoteA, quoteB, rfq, rfqParts] = await Promise.all([
    Quote.findOne({ rfqId, version: verA }).lean<IQuote>(),
    Quote.findOne({ rfqId, version: verB }).lean<IQuote>(),
    RFQ.findById(rfqId).lean<IRFQ>(),
    Part.find({ rfqId }).lean<IPart[]>(),
  ]);

  if (!quoteA) {
    throw new QuoteRevisionComparisonError(
      'VERSION_NOT_FOUND',
      `Quote version v${verA} not found for this RFQ.`,
    );
  }
  if (!quoteB) {
    throw new QuoteRevisionComparisonError(
      'VERSION_NOT_FOUND',
      `Quote version v${verB} not found for this RFQ.`,
    );
  }
  if (!rfq) {
    throw new QuoteRevisionComparisonError(
      'SNAPSHOT_INCOMPLETE',
      `RFQ "${String(rfqId)}" for quote "${quoteId}" not found.`,
    );
  }

  // Enforce same RFQ
  if (
    String(quoteA.rfqId) !== String(rfqId) ||
    String(quoteB.rfqId) !== String(rfqId) ||
    String(quoteA.rfqId) !== String(quoteB.rfqId)
  ) {
    throw new QuoteRevisionComparisonError(
      'RFQ_MISMATCH',
      'Both quote versions must belong to the same RFQ.',
    );
  }

  // Validate snapshot completeness on both versions before accessing nested fields
  if (!isCompleteQuoteRevisionSnapshot(quoteA)) {
    throw new QuoteRevisionComparisonError(
      'SNAPSHOT_INCOMPLETE',
      `Quote version v${verA} has an incomplete or malformed costing snapshot.`,
    );
  }
  if (!isCompleteQuoteRevisionSnapshot(quoteB)) {
    throw new QuoteRevisionComparisonError(
      'SNAPSHOT_INCOMPLETE',
      `Quote version v${verB} has an incomplete or malformed costing snapshot.`,
    );
  }

  // Resolve and verify both versions belong to the same Part
  const partA = resolvePartForQuote(quoteA, rfqParts);
  const partB = resolvePartForQuote(quoteB, rfqParts);

  if (quoteA.partId && !partA) {
    throw new QuoteRevisionComparisonError(
      'PART_MISMATCH',
      `Quote version v${verA} references part "${String(quoteA.partId)}" which does not belong to RFQ "${rfq.rfqNo}".`,
    );
  }
  if (quoteB.partId && !partB) {
    throw new QuoteRevisionComparisonError(
      'PART_MISMATCH',
      `Quote version v${verB} references part "${String(quoteB.partId)}" which does not belong to RFQ "${rfq.rfqNo}".`,
    );
  }

  const resolvedPartIdA = quoteA.partId
    ? String(quoteA.partId)
    : partA
    ? String(partA._id)
    : null;
  const resolvedPartIdB = quoteB.partId
    ? String(quoteB.partId)
    : partB
    ? String(partB._id)
    : null;

  if (resolvedPartIdA && resolvedPartIdB && resolvedPartIdA !== resolvedPartIdB) {
    throw new QuoteRevisionComparisonError(
      'PART_MISMATCH',
      `Quote versions v${verA} and v${verB} belong to different parts and cannot be compared as revisions of the same part.`,
    );
  }

  const targetPart = partB ?? partA;

  // Resolve user references & QuoteEvent audit history for both versions
  const userIds = new Set<string>();
  for (const q of [quoteA, quoteB]) {
    if (q.createdBy && mongoose.isValidObjectId(q.createdBy)) userIds.add(String(q.createdBy));
    if (q.submittedBy && mongoose.isValidObjectId(q.submittedBy)) userIds.add(String(q.submittedBy));
    if (q.approverId && mongoose.isValidObjectId(q.approverId)) userIds.add(String(q.approverId));
    if (q.rejectedBy && mongoose.isValidObjectId(q.rejectedBy)) userIds.add(String(q.rejectedBy));
    if (q.sentBy && mongoose.isValidObjectId(q.sentBy)) userIds.add(String(q.sentBy));
  }

  const events = await QuoteEvent.find({
    quoteId: { $in: [quoteA._id, quoteB._id] },
  })
    .sort({ timestamp: 1 })
    .lean<IQuoteEvent[]>();

  for (const ev of events) {
    if (ev.actorId && mongoose.isValidObjectId(ev.actorId)) {
      userIds.add(String(ev.actorId));
    }
  }

  const users =
    userIds.size > 0
      ? await User.find({
          _id: { $in: Array.from(userIds).map((id) => new mongoose.Types.ObjectId(id)) },
        })
          .select('name email role')
          .lean<Array<{ _id: mongoose.Types.ObjectId; name: string; email: string; role?: string }>>()
      : [];

  const userMap = new Map<string, UserSummaryRef>(
    users.map((u) => [
      String(u._id),
      { _id: String(u._id), name: u.name, email: u.email, role: u.role },
    ]),
  );

  const resolveUser = (id: unknown): UserSummaryRef | string | null => {
    if (!id) return null;
    const str = String(id);
    return userMap.get(str) ?? str;
  };

  const buildMeta = (q: IQuote): RevisionMetadata => {
    const qEvents = events
      .filter((e) => String(e.quoteId) === String(q._id))
      .map((e) => ({
        action: e.action,
        actor: resolveUser(e.actorId) ?? String(e.actorId),
        timestamp: toIsoSafe(e.timestamp, e.createdAt) ?? new Date(0).toISOString(),
        comment: e.comment ?? null,
      }));

    return {
      quoteId: String(q._id),
      version: q.version,
      status: q.status,
      costingDate: toIsoSafe(q.costingDate, q.createdAt) ?? new Date(0).toISOString(),
      createdAt: toIsoSafe(q.createdAt) ?? new Date(0).toISOString(),
      createdBy: resolveUser(q.createdBy) ?? String(q.createdBy),
      submittedBy: resolveUser(q.submittedBy),
      submittedAt: toIsoSafe(q.submittedAt),
      approvedBy: resolveUser(q.approverId),
      approvedAt: toIsoSafe(q.approvedAt),
      rejectedBy: resolveUser(q.rejectedBy),
      rejectedAt: toIsoSafe(q.rejectedAt),
      rejectionComment: q.rejectionComment ?? null,
      sentBy: resolveUser(q.sentBy),
      sentAt: toIsoSafe(q.sentAt),
      events: qEvents,
    };
  };

  // Extract snapshots
  const rsA = quoteA.rateSnapshot;
  const rsB = quoteB.rateSnapshot;
  const cisA = quoteA.costingInputSnapshot;
  const cisB = quoteB.costingInputSnapshot;
  const cbA = quoteA.costBreakdown;
  const cbB = quoteB.costBreakdown;

  const baseTierA = quoteA.volumeTierResults.find((t) => t.tierPercentage === 100)!;
  const baseTierB = quoteB.volumeTierResults.find((t) => t.tierPercentage === 100)!;

  const annualValA = toDec(quoteA.annualQuotationValue ?? quoteA.totalAnnualValue);
  const effectiveAnnualValA = annualValA.greaterThan(0)
    ? annualValA
    : toDec(baseTierA.sellingPriceExGst).times(cisA.annualVolume);

  const annualValB = toDec(quoteB.annualQuotationValue ?? quoteB.totalAnnualValue);
  const effectiveAnnualValB = annualValB.greaterThan(0)
    ? annualValB
    : toDec(baseTierB.sellingPriceExGst).times(cisB.annualVolume);

  // Per-piece margin amount = sellingPriceExGst - totalCost
  const marginAmtA = toDec(cbA.sellingPriceExGst).minus(toDec(cbA.totalCost));
  const marginAmtB = toDec(cbB.sellingPriceExGst).minus(toDec(cbB.totalCost));

  // Total cycle time across all operations
  const totalCycleA = (rsA.operations ?? cisA.routingOperations ?? []).reduce(
    (acc, op) => acc.plus(toDec(op.cycleTimeMinutes)),
    new D(0),
  );
  const totalCycleB = (rsB.operations ?? cisB.routingOperations ?? []).reduce(
    (acc, op) => acc.plus(toDec(op.cycleTimeMinutes)),
    new D(0),
  );

  // Build parameter rows (items 1-14: ex-GST costing & volume parameters)
  const makeRow = (
    key: RevisionComparisonRow['key'],
    label: string,
    category: RevisionComparisonRow['category'],
    unit: RevisionComparisonRow['unit'],
    valA: unknown,
    valB: unknown,
    dp = 2,
    note?: string,
  ): RevisionComparisonRow => {
    const d = computeDelta(valA, valB, dp);
    return {
      key,
      label,
      category,
      unit,
      versionAValue: d.valueA,
      versionBValue: d.valueB,
      absoluteDifference: d.absoluteDifference,
      percentageDifference: d.percentageDifference,
      direction: d.direction,
      ...(note ? { note } : {}),
    };
  };

  const materialNote =
    normalizeText(rsA.material) !== normalizeText(rsB.material)
      ? `Material changed: ${rsA.material} → ${rsB.material}`
      : `Material: ${rsB.material}`;

  const parameterRows: RevisionComparisonRow[] = [
    makeRow(
      'materialRate',
      'Material Rate',
      'SPEC_AND_RATES',
      'INR_PER_KG',
      rsA.materialRatePerKg,
      rsB.materialRatePerKg,
      2,
      materialNote,
    ),
    makeRow(
      'grossWeightKg',
      'Gross Weight',
      'SPEC_AND_RATES',
      'KG',
      cisA.grossWeightKg,
      cisB.grossWeightKg,
      3,
    ),
    makeRow(
      'materialCost',
      'Material Cost',
      'COST_BREAKDOWN',
      'INR_PER_PC',
      cbA.materialCost,
      cbB.materialCost,
      2,
    ),
    makeRow('scrapPct', 'Scrap %', 'SPEC_AND_RATES', 'PCT', rsA.scrapPct, rsB.scrapPct, 2),
    makeRow(
      'scrapCost',
      'Scrap Cost',
      'COST_BREAKDOWN',
      'INR_PER_PC',
      cbA.scrapCost,
      cbB.scrapCost,
      2,
    ),
    makeRow(
      'conversionCost',
      'Conversion Cost (Routing)',
      'COST_BREAKDOWN',
      'INR_PER_PC',
      cbA.conversionCost,
      cbB.conversionCost,
      2,
    ),
    makeRow(
      'overheadPct',
      'Overhead %',
      'SPEC_AND_RATES',
      'PCT',
      rsA.overheadPct,
      rsB.overheadPct,
      2,
    ),
    makeRow(
      'overheadCost',
      'Overhead Amount',
      'COST_BREAKDOWN',
      'INR_PER_PC',
      cbA.overheadCost,
      cbB.overheadCost,
      2,
    ),
    makeRow(
      'packingFreight',
      'Packing & Freight',
      'COST_BREAKDOWN',
      'INR_PER_PC',
      cbA.packingFreight,
      cbB.packingFreight,
      2,
    ),
    makeRow(
      'setupCostTotal',
      'Setup Cost per Part (Total)',
      'SPEC_AND_RATES',
      'INR',
      rsA.setupCostPerPart,
      rsB.setupCostPerPart,
      2,
    ),
    makeRow(
      'setupAllocationPerPiece',
      'Setup Allocation / Piece (100% Tier)',
      'COST_BREAKDOWN',
      'INR_PER_PC',
      cbA.setupAllocationPerPiece,
      cbB.setupAllocationPerPiece,
      2,
    ),
    makeRow(
      'totalCostPerPiece',
      'Total Cost / Piece (100% Tier)',
      'COST_BREAKDOWN',
      'INR_PER_PC',
      cbA.totalCost,
      cbB.totalCost,
      2,
    ),
    makeRow('marginPct', 'Margin %', 'SPEC_AND_RATES', 'PCT', rsA.marginPct, rsB.marginPct, 2),
    makeRow(
      'marginAmountPerPiece',
      'Margin Amount / Piece (100% Tier)',
      'SELLING_PRICE_AND_VOLUME',
      'INR_PER_PC',
      marginAmtA,
      marginAmtB,
      2,
    ),
    makeRow(
      'sellingPriceExGst',
      'Selling Price / Piece (Ex-GST, 100% Tier)',
      'SELLING_PRICE_AND_VOLUME',
      'INR_PER_PC',
      cbA.sellingPriceExGst,
      cbB.sellingPriceExGst,
      2,
    ),
    makeRow(
      'annualVolume',
      'Annual Volume',
      'SELLING_PRICE_AND_VOLUME',
      'PCS',
      cisA.annualVolume,
      cisB.annualVolume,
      0,
    ),
    makeRow(
      'annualQuoteValue',
      'Annual Quote Value (Ex-GST)',
      'SELLING_PRICE_AND_VOLUME',
      'INR',
      effectiveAnnualValA,
      effectiveAnnualValB,
      2,
    ),
  ];

  // Item 15: GST displayed separately
  const gstRows: RevisionComparisonRow[] = [
    makeRow('gstPct', 'GST %', 'GST', 'PCT', rsA.gstPct, rsB.gstPct, 2),
    makeRow(
      'gstAmountPerPiece',
      'GST Amount / Piece (100% Tier)',
      'GST',
      'INR_PER_PC',
      cbA.gstAmount,
      cbB.gstAmount,
      2,
    ),
    makeRow(
      'sellingPriceInclGst',
      'Selling Price / Piece (Incl. GST, 100% Tier)',
      'GST',
      'INR_PER_PC',
      cbA.sellingPriceIncludingGst,
      cbB.sellingPriceIncludingGst,
      2,
    ),
  ];

  // Routing comparison
  const routingComparison = buildRoutingComparison(quoteA, quoteB);

  // Three volume tiers comparison (50%, 100%, 150%)
  const tierComparisons: VolumeTierRevisionComparison[] = ([50, 100, 150] as const).map(
    (pct) => {
      const tA = quoteA.volumeTierResults.find((t) => t.tierPercentage === pct)!;
      const tB = quoteB.volumeTierResults.find((t) => t.tierPercentage === pct)!;
      return buildTierComparison(
        pct,
        tA,
        tB,
        pct === 100 ? effectiveAnnualValA : undefined,
        pct === 100 ? effectiveAnnualValB : undefined,
      );
    },
  );

  return {
    rfq: {
      _id: String(rfq._id),
      rfqNo: rfq.rfqNo,
      customer: rfq.customer,
    },
    part: {
      _id: targetPart ? String(targetPart._id) : resolvedPartIdB ?? resolvedPartIdA,
      partName: targetPart?.partName ?? `RFQ ${rfq.rfqNo} Part`,
      drawingNumber: targetPart?.drawingNumber ?? null,
      materialA: rsA.material,
      materialB: rsB.material,
      materialChanged: normalizeText(rsA.material) !== normalizeText(rsB.material),
    },
    versionA: buildMeta(quoteA),
    versionB: buildMeta(quoteB),
    summary: {
      sellingPriceExGst: computeDelta(cbA.sellingPriceExGst, cbB.sellingPriceExGst, 2),
      totalCostPerPiece: computeDelta(cbA.totalCost, cbB.totalCost, 2),
      annualQuoteValue: computeDelta(effectiveAnnualValA, effectiveAnnualValB, 2),
      gstAmountPerPiece: computeDelta(cbA.gstAmount, cbB.gstAmount, 2),
      sellingPriceIncludingGst: computeDelta(
        cbA.sellingPriceIncludingGst,
        cbB.sellingPriceIncludingGst,
        2,
      ),
      totalCycleTimeMinutes: computeDelta(totalCycleA, totalCycleB, 2),
    },
    parameterRows,
    gstRows,
    routingComparison,
    tierComparisons,
  };
}
