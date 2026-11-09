/**
 * services/historicalQuoteComparison.service.ts
 *
 * Deterministic historical quote search, ranking, and decimal-exact side-by-side
 * costing comparison.
 *
 * Rules:
 *  - Deterministic matching & ranking only — never uses AI to calculate or compare costs.
 *  - Reads all historical rates, operations, and cost breakdowns strictly from the
 *    immutable Quote snapshot (rateSnapshot, costingInputSnapshot, costBreakdown,
 *    volumeTierResults). Never reconstructs historical costs from current rate masters.
 *  - Excludes DRAFT, REJECTED, and incomplete quote records.
 *  - Uses decimal.js (40-digit precision, ROUND_HALF_UP to 2 dp) for all financial
 *    difference and percentage calculations.
 */

import mongoose from 'mongoose';
import Decimal from 'decimal.js';
import { Part, type IPart } from '../models/Part';
import { RFQ, type IRFQ } from '../models/RFQ';
import {
  Quote,
  type IQuote,
  type QuoteStatus,
  type ICostBreakdownSnapshot,
  type IVolumeTierSnapshot,
} from '../models/Quote';
import { previewCosting, type CostingWorkflowInput } from './costingWorkflow.service';

// ─── Decimal configuration (matches @rfq/costing-engine) ─────────────────────

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

function toIsoDateStringSafe(val: unknown, fallback?: Date): string {
  const candidate = val ? new Date(val as string | number | Date) : fallback ?? new Date(0);
  if (!Number.isNaN(candidate.getTime())) {
    return candidate.toISOString();
  }
  const fb = fallback && !Number.isNaN(new Date(fallback).getTime()) ? new Date(fallback) : new Date(0);
  return fb.toISOString();
}

function toMoneyStr(d: Decimal): string {
  return d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2, Decimal.ROUND_HALF_UP);
}

function computeDiff(currentVal: unknown, historicalVal: unknown): {
  current: string;
  historical: string;
  absoluteDifference: string;
  percentageDifference: string | null;
} {
  const cur = toDec(currentVal);
  const hist = toDec(historicalVal);
  const diff = cur.minus(hist);
  const pct = hist.isZero()
    ? null
    : toMoneyStr(diff.dividedBy(hist).times(100));
  return {
    current: toMoneyStr(cur),
    historical: toMoneyStr(hist),
    absoluteDifference: toMoneyStr(diff),
    percentageDifference: pct,
  };
}

// ─── Error type ──────────────────────────────────────────────────────────────

export type HistoricalComparisonErrorCode =
  | 'INVALID_ID'
  | 'INVALID_QUERY_PARAM'
  | 'PART_NOT_FOUND'
  | 'PART_NOT_IN_RFQ'
  | 'QUOTE_NOT_FOUND'
  | 'QUOTE_INELIGIBLE'
  | 'QUOTE_SNAPSHOT_INCOMPLETE'
  | 'INVALID_TIER';

export class HistoricalComparisonError extends Error {
  constructor(
    public readonly code: HistoricalComparisonErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'HistoricalComparisonError';
  }
}

// ─── Eligible statuses & snapshot completeness check ─────────────────────────

export const ELIGIBLE_HISTORICAL_STATUSES: readonly QuoteStatus[] = [
  'PENDING_APPROVAL',
  'APPROVED',
  'READY_FOR_SALES',
  'SENT',
];

export const DEFAULT_WEIGHT_TOLERANCE_PCT = 35;
export const MIN_WEIGHT_TOLERANCE_PCT = 1;
export const MAX_WEIGHT_TOLERANCE_PCT = 100;
export const DEFAULT_MAX_RESULTS = 5;
export const MIN_RESULTS = 1;
export const MAX_RESULTS = 20;

export function isUsableHistoricalSnapshot(quote: Partial<IQuote> | null | undefined): boolean {
  if (!quote) return false;
  if (!quote.status || !ELIGIBLE_HISTORICAL_STATUSES.includes(quote.status)) return false;

  const rs = quote.rateSnapshot;
  const cis = quote.costingInputSnapshot;
  const cb = quote.costBreakdown;
  const tiers = quote.volumeTierResults;

  if (!rs || !cis || !cb || !Array.isArray(tiers) || tiers.length === 0) return false;
  if (!rs.material || !isPositiveFiniteDecimal(rs.materialRatePerKg)) {
    return false;
  }
  if (!Array.isArray(cis.routingOperations) || cis.routingOperations.length === 0) {
    return false;
  }
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
    !isNonNegativeFiniteDecimal(cb.totalCost) ||
    !isPositiveFiniteDecimal(cb.sellingPriceExGst)
  ) {
    return false;
  }

  // All 3 standard volume tiers (50%, 100%, 150%) must be present and valid
  for (const requiredTierPct of [50, 100, 150]) {
    const tier = tiers.find((t) => t && t.tierPercentage === requiredTierPct);
    if (
      !tier ||
      typeof tier.tierVolume !== 'number' ||
      !Number.isFinite(tier.tierVolume) ||
      tier.tierVolume <= 0 ||
      !isNonNegativeFiniteDecimal(tier.setupAllocationPerPiece) ||
      !isNonNegativeFiniteDecimal(tier.totalCostPerPiece) ||
      !isPositiveFiniteDecimal(tier.sellingPriceExGst)
    ) {
      return false;
    }
  }

  return true;
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface HistoricalQuoteMatch {
  quoteId: string;
  partId: string | null;
  historicalPartName: string;
  drawingNumber: string | null;
  drawingRevision: string | null;
  material: string;
  partWeightKg: number;
  customerName: string;
  rfqId: string;
  rfqNo: string;
  quoteVersion: number;
  quoteDate: string;
  historicalQuoteStatus: QuoteStatus;
  historicalMaterialRate: string;
  historicalMachineRates: Array<{
    operationName: string;
    machine: string;
    machineHourRate: string;
    effectiveFrom: string;
  }>;
  historicalRoutingOperations: Array<{
    operationName: string;
    machine: string;
    cycleTimeMinutes: number;
    machineHourRate: string;
  }>;
  historicalScrapPct: number;
  historicalOverheadPct: number;
  historicalMarginPct: number;
  historicalGstPct: number;
  historicalPackingFreight: string;
  historicalSetupCost: string;
  historicalPricePerPieceExGst: string;
  historicalPricePerPieceIncGst: string;
  historicalAnnualVolume: number;
  historicalAnnualQuoteValue: string;
  historicalCostBreakdown: ICostBreakdownSnapshot;
  historicalVolumeTiers: IVolumeTierSnapshot[];
  similarityScore: number;
  weightDifferencePct: number;
  withinWeightTolerance: boolean;
  weightTolerancePct: number;
  matchFlags: {
    exactDrawingMatch: boolean;
    sameMaterial: boolean;
    similarWeight: boolean;
    similarName: boolean;
  };
  matchReasons: string[];
  importSource?: 'HISTORICAL_EXCEL' | null;
  isSyntheticDemo?: boolean;
  historicalStatedPriceExGst?: string | null;
  priceDiscrepancyFlag?: boolean;
  priceDiscrepancyDelta?: string | null;
}

export interface SearchHistoricalQuotesOptions {
  partId: string;
  limit?: number;
  weightTolerancePct?: number;
}

export interface SearchHistoricalQuotesResponse {
  targetPart: {
    _id: string;
    partName: string;
    drawingNumber: string | null;
    material: string;
    grossWeightKg: number;
    annualVolume: number;
  };
  weightTolerancePct: number;
  limit: number;
  matches: HistoricalQuoteMatch[];
}

// ─── Name & similarity helpers ───────────────────────────────────────────────

function normalizeText(s: string | undefined | null): string {
  return (s ?? '').trim().toLowerCase();
}

function tokenizeName(name: string): string[] {
  return normalizeText(name)
    .split(/[^a-z0-9]+/)
    .filter((tok) => tok.length >= 2);
}

/**
 * Computes token-overlap / substring similarity in [0, 1] between two part names.
 */
export function computeNameSimilarity(a: string, b: string): number {
  const na = normalizeText(a);
  const nb = normalizeText(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.8;

  const setA = new Set(tokenizeName(na));
  const setB = new Set(tokenizeName(nb));
  if (setA.size === 0 || setB.size === 0) return 0;

  let shared = 0;
  for (const tok of setA) {
    if (setB.has(tok)) shared++;
  }
  return shared / Math.max(setA.size, setB.size);
}

/**
 * Deterministic scoring and match classification between a target part and a
 * historical part/quote snapshot.
 *
 * Hierarchy:
 *  1. Exact drawing number match (+1000)
 *  2. Same material grade (+300)
 *  3. Similar part weight within tolerance (+150 scaled by closeness)
 *  4. Similar part name (+100 scaled by token similarity)
 */
export function scoreHistoricalCandidate(
  target: {
    partName: string;
    drawingNumber?: string | null;
    material: string;
    grossWeightKg: number;
  },
  candidate: {
    partName: string;
    drawingNumber?: string | null;
    material: string;
    grossWeightKg: number;
  },
  weightTolerancePct: number,
): {
  score: number;
  weightDifferencePct: number;
  withinWeightTolerance: boolean;
  matchFlags: HistoricalQuoteMatch['matchFlags'];
  matchReasons: string[];
} {
  let score = 0;
  const reasons: string[] = [];

  // 1. Exact drawing number match
  const tDwg = normalizeText(target.drawingNumber);
  const cDwg = normalizeText(candidate.drawingNumber);
  const exactDrawingMatch = Boolean(tDwg && cDwg && tDwg === cDwg);
  if (exactDrawingMatch) {
    score += 1000;
    reasons.push(`Exact drawing number match (${candidate.drawingNumber})`);
  }

  // 2. Material grade match
  const tMat = normalizeText(target.material);
  const cMat = normalizeText(candidate.material);
  const sameMaterial = Boolean(tMat && cMat && tMat === cMat);
  if (sameMaterial) {
    score += 300;
    reasons.push(`Same material grade (${candidate.material})`);
  }

  // 3. Weight similarity
  const baseWeight = target.grossWeightKg > 0 ? target.grossWeightKg : 1;
  const weightDiffRatio = Math.abs(candidate.grossWeightKg - baseWeight) / baseWeight;
  const weightDifferencePct = Number((weightDiffRatio * 100).toFixed(2));
  const withinWeightTolerance = weightDifferencePct <= weightTolerancePct;
  if (withinWeightTolerance) {
    const closeness = Math.max(0, 1 - weightDifferencePct / Math.max(weightTolerancePct, 1));
    score += Math.round(50 + 100 * closeness);
    reasons.push(
      `Similar weight (${candidate.grossWeightKg.toFixed(3)} kg, Δ ${weightDifferencePct.toFixed(1)}% within ±${weightTolerancePct}%)`,
    );
  }

  // 4. Part name similarity
  const nameSim = computeNameSimilarity(target.partName, candidate.partName);
  const similarName = nameSim >= 0.35;
  if (similarName) {
    score += Math.round(nameSim * 100);
    reasons.push(`Similar part name ("${candidate.partName}")`);
  }

  return {
    score,
    weightDifferencePct,
    withinWeightTolerance,
    matchFlags: {
      exactDrawingMatch,
      sameMaterial,
      similarWeight: withinWeightTolerance,
      similarName,
    },
    matchReasons: reasons,
  };
}

/**
 * Resolve the Part associated with a Quote.
 * Uses quote.partId if present; otherwise matches among the RFQ's parts by material & weight.
 */
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

export function buildHistoricalQuoteMatch(
  quote: IQuote,
  rfq: IRFQ,
  histPart: IPart | null,
  scoring: ReturnType<typeof scoreHistoricalCandidate>,
  weightTolerancePct: number,
): HistoricalQuoteMatch {
  const rs = quote.rateSnapshot;
  const cis = quote.costingInputSnapshot;
  const cb = quote.costBreakdown;

  const snapWeight = Number(toDec(cis.grossWeightKg).toNumber());
  const partWeightKg = snapWeight > 0 ? snapWeight : histPart?.grossWeightKg ?? 0;

  // Base 100% tier annual quotation value = 100% sellingPriceExGst * snapshot annualVolume
  const baseTier = quote.volumeTierResults.find((t) => t.tierPercentage === 100);
  const basePriceExGst = toDec(baseTier?.sellingPriceExGst ?? cb.sellingPriceExGst);
  const rawAnnualVal = toDec(quote.annualQuotationValue ?? quote.totalAnnualValue);
  const computedBaseAnnualVal = basePriceExGst.times(cis.annualVolume);
  const effectiveAnnualVal = rawAnnualVal.greaterThan(0) ? rawAnnualVal : computedBaseAnnualVal;

  return {
    quoteId: String(quote._id),
    partId: histPart ? String(histPart._id) : quote.partId ? String(quote.partId) : null,
    historicalPartName: histPart?.partName ?? `RFQ ${rfq.rfqNo} Part`,
    drawingNumber: histPart?.drawingNumber ?? null,
    drawingRevision: histPart?.drawingRevision ?? null,
    material: rs.material,
    partWeightKg,
    customerName: rfq.customer,
    rfqId: String(rfq._id),
    rfqNo: rfq.rfqNo,
    quoteVersion: quote.version,
    quoteDate: toIsoDateStringSafe(quote.costingDate, quote.createdAt),
    historicalQuoteStatus: quote.status,
    historicalMaterialRate: toMoneyStr(toDec(rs.materialRatePerKg)),
    historicalMachineRates: (rs.operations ?? []).map((op) => ({
      operationName: op.operationName,
      machine: op.machine,
      machineHourRate: toMoneyStr(toDec(op.machineHourRate)),
      effectiveFrom: toIsoDateStringSafe(
        op.machineRateEffectiveFrom,
        quote.costingDate ?? quote.createdAt,
      ),
    })),
    historicalRoutingOperations: (cis.routingOperations ?? []).map((op) => ({
      operationName: op.operationName,
      machine: op.machine,
      cycleTimeMinutes: Number(toDec(op.cycleTimeMinutes).toNumber()),
      machineHourRate: toMoneyStr(toDec(op.machineHourRate)),
    })),
    historicalScrapPct: rs.scrapPct,
    historicalOverheadPct: rs.overheadPct,
    historicalMarginPct: rs.marginPct,
    historicalGstPct: rs.gstPct,
    historicalPackingFreight: toMoneyStr(toDec(rs.packingFreight)),
    historicalSetupCost: toMoneyStr(toDec(rs.setupCostPerPart)),
    historicalPricePerPieceExGst: toMoneyStr(basePriceExGst),
    historicalPricePerPieceIncGst: toMoneyStr(toDec(cb.sellingPriceIncludingGst)),
    historicalAnnualVolume: cis.annualVolume,
    historicalAnnualQuoteValue: toMoneyStr(effectiveAnnualVal),
    historicalCostBreakdown: cb,
    historicalVolumeTiers: quote.volumeTierResults,
    similarityScore: scoring.score,
    weightDifferencePct: scoring.weightDifferencePct,
    withinWeightTolerance: scoring.withinWeightTolerance,
    weightTolerancePct,
    matchFlags: scoring.matchFlags,
    matchReasons: scoring.matchReasons,
    importSource: quote.importSource ?? rfq.importSource ?? null,
    isSyntheticDemo: Boolean(quote.isSyntheticDemo || rfq.isSyntheticDemo),
    historicalStatedPriceExGst:
      quote.historicalStatedPriceExGst !== undefined && quote.historicalStatedPriceExGst !== null
        ? toMoneyStr(toDec(quote.historicalStatedPriceExGst))
        : null,
    priceDiscrepancyFlag: Boolean(quote.priceDiscrepancyFlag),
    priceDiscrepancyDelta:
      quote.priceDiscrepancyDelta !== undefined && quote.priceDiscrepancyDelta !== null
        ? toMoneyStr(toDec(quote.priceDiscrepancyDelta))
        : null,
  };
}

// ─── Search Historical Quotes ────────────────────────────────────────────────

export async function searchHistoricalQuotesForPart(
  options: SearchHistoricalQuotesOptions,
): Promise<SearchHistoricalQuotesResponse> {
  const { partId } = options;
  if (!mongoose.isValidObjectId(partId)) {
    throw new HistoricalComparisonError('INVALID_ID', `Invalid partId: "${partId}"`);
  }

  let limit = DEFAULT_MAX_RESULTS;
  if (options.limit !== undefined) {
    const rawLimit = Number(options.limit);
    if (!Number.isFinite(rawLimit) || rawLimit < MIN_RESULTS) {
      throw new HistoricalComparisonError(
        'INVALID_QUERY_PARAM',
        `limit must be a number between ${MIN_RESULTS} and ${MAX_RESULTS}`,
      );
    }
    limit = Math.min(Math.floor(rawLimit), MAX_RESULTS);
  }

  let weightTolerancePct = DEFAULT_WEIGHT_TOLERANCE_PCT;
  if (options.weightTolerancePct !== undefined) {
    const rawTol = Number(options.weightTolerancePct);
    if (!Number.isFinite(rawTol) || rawTol < MIN_WEIGHT_TOLERANCE_PCT) {
      throw new HistoricalComparisonError(
        'INVALID_QUERY_PARAM',
        `weightTolerancePct must be a number between ${MIN_WEIGHT_TOLERANCE_PCT} and ${MAX_WEIGHT_TOLERANCE_PCT}`,
      );
    }
    weightTolerancePct = Math.min(rawTol, MAX_WEIGHT_TOLERANCE_PCT);
  }

  const targetPart = await Part.findById(partId).lean<IPart>();
  if (!targetPart) {
    throw new HistoricalComparisonError('PART_NOT_FOUND', `Part "${partId}" not found`);
  }

  // Fetch all eligible non-draft, non-rejected quotes
  const eligibleQuotes = await Quote.find({
    status: { $in: ELIGIBLE_HISTORICAL_STATUSES },
  })
    .sort({ costingDate: -1, version: -1 })
    .lean<IQuote[]>();

  const usableQuotes = eligibleQuotes.filter((q) => isUsableHistoricalSnapshot(q));

  if (usableQuotes.length === 0) {
    return {
      targetPart: {
        _id: String(targetPart._id),
        partName: targetPart.partName,
        drawingNumber: targetPart.drawingNumber ?? null,
        material: targetPart.material,
        grossWeightKg: targetPart.grossWeightKg,
        annualVolume: targetPart.annualVolume,
      },
      weightTolerancePct,
      limit,
      matches: [],
    };
  }

  const rfqIds = Array.from(new Set(usableQuotes.map((q) => String(q.rfqId)))).map(
    (id) => new mongoose.Types.ObjectId(id),
  );
  const [rfqs, parts] = await Promise.all([
    RFQ.find({ _id: { $in: rfqIds } }).lean<IRFQ[]>(),
    Part.find({ rfqId: { $in: rfqIds } }).lean<IPart[]>(),
  ]);

  const rfqById = new Map<string, IRFQ>(rfqs.map((r) => [String(r._id), r]));
  const partsByRfqId = new Map<string, IPart[]>();
  for (const p of parts) {
    const key = String(p.rfqId);
    const list = partsByRfqId.get(key) ?? [];
    list.push(p);
    partsByRfqId.set(key, list);
  }

  const matchedResults: HistoricalQuoteMatch[] = [];

  for (const quote of usableQuotes) {
    const rfq = rfqById.get(String(quote.rfqId));
    if (!rfq) continue;

    const rfqParts = partsByRfqId.get(String(quote.rfqId)) ?? [];
    const histPart = resolvePartForQuote(quote, rfqParts);

    // If quote explicitly references a partId that does not belong to quote.rfqId, skip it
    if (quote.partId && !histPart) {
      continue;
    }

    // Exclude quotes belonging to the exact same part being costed
    if (
      (histPart && String(histPart._id) === String(targetPart._id)) ||
      (quote.partId && String(quote.partId) === String(targetPart._id))
    ) {
      continue;
    }

    const snapWeight = Number(toDec(quote.costingInputSnapshot.grossWeightKg).toNumber());
    const candidateWeight = snapWeight > 0 ? snapWeight : histPart?.grossWeightKg ?? 0;

    const scoring = scoreHistoricalCandidate(
      {
        partName: targetPart.partName,
        drawingNumber: targetPart.drawingNumber ?? null,
        material: targetPart.material,
        grossWeightKg: targetPart.grossWeightKg,
      },
      {
        partName: histPart?.partName ?? '',
        drawingNumber: histPart?.drawingNumber ?? null,
        material: quote.rateSnapshot.material,
        grossWeightKg: candidateWeight,
      },
      weightTolerancePct,
    );

    // Only include candidates that match on at least one criterion
    if (scoring.score <= 0) continue;

    matchedResults.push(
      buildHistoricalQuoteMatch(quote, rfq, histPart, scoring, weightTolerancePct),
    );
  }

  // Sort by similarityScore DESC, then smaller weightDifferencePct ASC, then newer quoteDate DESC
  matchedResults.sort((a, b) => {
    if (b.similarityScore !== a.similarityScore) {
      return b.similarityScore - a.similarityScore;
    }
    if (a.weightDifferencePct !== b.weightDifferencePct) {
      return a.weightDifferencePct - b.weightDifferencePct;
    }
    return new Date(b.quoteDate).getTime() - new Date(a.quoteDate).getTime();
  });

  return {
    targetPart: {
      _id: String(targetPart._id),
      partName: targetPart.partName,
      drawingNumber: targetPart.drawingNumber ?? null,
      material: targetPart.material,
      grossWeightKg: targetPart.grossWeightKg,
      annualVolume: targetPart.annualVolume,
    },
    weightTolerancePct,
    limit,
    matches: matchedResults.slice(0, limit),
  };
}

// ─── Side-by-Side Comparison (Phase 3) ───────────────────────────────────────

export interface ComparisonRow {
  key: string;
  label: string;
  unit: 'INR_PER_KG' | 'INR_PER_PC' | 'INR' | 'PCT' | 'PCS';
  currentValue: string;
  historicalValue: string;
  absoluteDifference: string;
  percentageDifference: string | null;
  note?: string;
}

export interface HistoricalQuoteComparisonResult {
  tierPercentage: number;
  isDirectlyEquivalent: boolean;
  equivalenceWarnings: string[];
  current: {
    partId: string;
    partName: string;
    material: string;
    grossWeightKg: number;
    costingDate: string;
    annualVolume: number;
    tierVolume: number;
    sellingPricePerPieceExGst: string;
    annualQuoteValue: string;
  };
  historical: HistoricalQuoteMatch & {
    comparedTierVolume: number;
    comparedTierSellingPriceExGst: string;
  };
  priceDelta: {
    currentPriceExGst: string;
    historicalPriceExGst: string;
    absoluteDifference: string;
    percentageDifference: string | null;
  };
  annualValueDelta: {
    currentAnnualValue: string;
    historicalAnnualValue: string;
    absoluteDifference: string;
    percentageDifference: string | null;
  };
  rows: ComparisonRow[];
}

export interface CompareHistoricalQuoteInput {
  partId: string;
  historicalQuoteId: string;
  currentCostingInput: Omit<CostingWorkflowInput, 'partId'>;
  tierPercentage?: number; // 50 | 100 | 150 (default 100)
}

export async function compareWithHistoricalQuote(
  input: CompareHistoricalQuoteInput,
): Promise<HistoricalQuoteComparisonResult> {
  const { partId, historicalQuoteId, currentCostingInput } = input;
  const tierPercentage = input.tierPercentage ?? 100;

  if (![50, 100, 150].includes(tierPercentage)) {
    throw new HistoricalComparisonError(
      'INVALID_TIER',
      `tierPercentage must be 50, 100, or 150 (received ${tierPercentage})`,
    );
  }
  if (!mongoose.isValidObjectId(partId)) {
    throw new HistoricalComparisonError('INVALID_ID', `Invalid partId: "${partId}"`);
  }
  if (!mongoose.isValidObjectId(historicalQuoteId)) {
    throw new HistoricalComparisonError(
      'INVALID_ID',
      `Invalid historicalQuoteId: "${historicalQuoteId}"`,
    );
  }

  const [targetPart, histQuote] = await Promise.all([
    Part.findById(partId).lean<IPart>(),
    Quote.findById(historicalQuoteId).lean<IQuote>(),
  ]);

  if (!targetPart) {
    throw new HistoricalComparisonError('PART_NOT_FOUND', `Part "${partId}" not found`);
  }
  if (!mongoose.isValidObjectId(currentCostingInput.rfqId)) {
    throw new HistoricalComparisonError(
      'INVALID_ID',
      `Invalid rfqId: "${currentCostingInput.rfqId}"`,
    );
  }
  if (String(targetPart.rfqId) !== String(currentCostingInput.rfqId)) {
    throw new HistoricalComparisonError(
      'PART_NOT_IN_RFQ',
      `Part "${partId}" does not belong to RFQ "${currentCostingInput.rfqId}".`,
    );
  }
  if (!histQuote) {
    throw new HistoricalComparisonError(
      'QUOTE_NOT_FOUND',
      `Historical quote "${historicalQuoteId}" not found`,
    );
  }
  if (!ELIGIBLE_HISTORICAL_STATUSES.includes(histQuote.status)) {
    throw new HistoricalComparisonError(
      'QUOTE_INELIGIBLE',
      `Quote "${historicalQuoteId}" has status "${histQuote.status}" and cannot be used as a historical benchmark.`,
    );
  }
  if (!isUsableHistoricalSnapshot(histQuote)) {
    throw new HistoricalComparisonError(
      'QUOTE_SNAPSHOT_INCOMPLETE',
      `Historical quote "${historicalQuoteId}" does not have a complete costing snapshot.`,
    );
  }

  const [histRfq, histRfqParts, currentPreview] = await Promise.all([
    RFQ.findById(histQuote.rfqId).lean<IRFQ>(),
    Part.find({ rfqId: histQuote.rfqId }).lean<IPart[]>(),
    previewCosting({
      ...currentCostingInput,
      partId,
    }),
  ]);

  if (!histRfq) {
    throw new HistoricalComparisonError(
      'QUOTE_SNAPSHOT_INCOMPLETE',
      `RFQ for historical quote "${historicalQuoteId}" not found`,
    );
  }

  const histPart = resolvePartForQuote(histQuote, histRfqParts);
  if (histQuote.partId && !histPart) {
    throw new HistoricalComparisonError(
      'QUOTE_SNAPSHOT_INCOMPLETE',
      `Historical quote "${historicalQuoteId}" references part "${String(histQuote.partId)}" which does not belong to RFQ "${String(histQuote.rfqId)}".`,
    );
  }
  if (
    (histPart && String(histPart._id) === String(targetPart._id)) ||
    (histQuote.partId && String(histQuote.partId) === String(targetPart._id))
  ) {
    throw new HistoricalComparisonError(
      'QUOTE_INELIGIBLE',
      `Historical quote "${historicalQuoteId}" belongs to the same part ("${partId}") currently being costed.`,
    );
  }
  const snapWeight = Number(toDec(histQuote.costingInputSnapshot.grossWeightKg).toNumber());
  const scoring = scoreHistoricalCandidate(
    {
      partName: targetPart.partName,
      drawingNumber: targetPart.drawingNumber ?? null,
      material: targetPart.material,
      grossWeightKg: targetPart.grossWeightKg,
    },
    {
      partName: histPart?.partName ?? '',
      drawingNumber: histPart?.drawingNumber ?? null,
      material: histQuote.rateSnapshot.material,
      grossWeightKg: snapWeight > 0 ? snapWeight : histPart?.grossWeightKg ?? 0,
    },
    DEFAULT_WEIGHT_TOLERANCE_PCT,
  );

  const histMatch = buildHistoricalQuoteMatch(
    histQuote,
    histRfq,
    histPart,
    scoring,
    DEFAULT_WEIGHT_TOLERANCE_PCT,
  );

  // Locate the requested volume tier (50%, 100%, or 150%) on both sides
  const curTier = currentPreview.volumeTiers.find((t) => t.tierPercentage === tierPercentage);
  const histTier = histQuote.volumeTierResults.find((t) => t.tierPercentage === tierPercentage);

  if (!curTier || !histTier) {
    throw new HistoricalComparisonError(
      'INVALID_TIER',
      `Volume tier ${tierPercentage}% is not available on both quotes.`,
    );
  }

  // Equivalence checks
  const equivalenceWarnings: string[] = [];
  if (normalizeText(targetPart.material) !== normalizeText(histMatch.material)) {
    equivalenceWarnings.push(
      `Material differs: current part uses ${targetPart.material} vs historical ${histMatch.material}.`,
    );
  }
  if (scoring.weightDifferencePct > 5) {
    equivalenceWarnings.push(
      `Gross weight differs by ${scoring.weightDifferencePct.toFixed(1)}% (${targetPart.grossWeightKg.toFixed(3)} kg vs ${histMatch.partWeightKg.toFixed(3)} kg).`,
    );
  }
  if (targetPart.annualVolume !== histMatch.historicalAnnualVolume) {
    equivalenceWarnings.push(
      `Annual volume differs (${targetPart.annualVolume.toLocaleString('en-IN')} vs ${histMatch.historicalAnnualVolume.toLocaleString('en-IN')} pcs/yr); at the ${tierPercentage}% tier this compares ${curTier.tierVolume.toLocaleString('en-IN')} vs ${histTier.tierVolume.toLocaleString('en-IN')} pcs, which changes per-piece setup allocation.`,
    );
  }

  const curIn = currentPreview.costingInput;
  if (
    Number(curIn.scrapPct) !== histMatch.historicalScrapPct ||
    Number(curIn.overheadPct) !== histMatch.historicalOverheadPct ||
    Number(curIn.defaultMarginPct) !== histMatch.historicalMarginPct
  ) {
    equivalenceWarnings.push(
      `Costing percentage assumptions differ (Scrap ${curIn.scrapPct}% vs ${histMatch.historicalScrapPct}%, Overhead ${curIn.overheadPct}% vs ${histMatch.historicalOverheadPct}%, Margin ${curIn.defaultMarginPct}% vs ${histMatch.historicalMarginPct}%).`,
    );
  }

  const curCb = currentPreview.breakdown;
  const histCb = histQuote.costBreakdown;

  // Build rows in the exact requested order, using tier-adjusted setup & selling price
  const materialRateDiff = computeDiff(
    curIn.materialRatePerKg,
    histMatch.historicalMaterialRate,
  );
  const materialCostDiff = computeDiff(curCb.materialCost, histCb.materialCost);
  const scrapCostDiff = computeDiff(curCb.scrapCost, histCb.scrapCost);
  const conversionCostDiff = computeDiff(curCb.conversionCost, histCb.conversionCost);
  const overheadCostDiff = computeDiff(curCb.overheadCost, histCb.overheadCost);
  const packingFreightDiff = computeDiff(curCb.packingFreight, histCb.packingFreight);
  const setupAllocationDiff = computeDiff(
    curTier.setupAllocationPerPiece,
    histTier.setupAllocationPerPiece,
  );
  const marginPctDiff = computeDiff(curIn.defaultMarginPct, histMatch.historicalMarginPct);
  const sellingPriceDiff = computeDiff(
    curTier.sellingPriceExGst,
    histTier.sellingPriceExGst,
  );
  const annualVolDiff = computeDiff(curTier.tierVolume, histTier.tierVolume);

  // Annual quote value at the compared tier = tier sellingPriceExGst * tierVolume
  const curTierAnnualVal =
    tierPercentage === 100
      ? toDec(currentPreview.annualQuotationValue)
      : toDec(curTier.sellingPriceExGst).times(curTier.tierVolume);
  const histTierAnnualVal =
    tierPercentage === 100
      ? toDec(histMatch.historicalAnnualQuoteValue)
      : toDec(histTier.sellingPriceExGst).times(histTier.tierVolume);
  const annualValueDiff = computeDiff(curTierAnnualVal, histTierAnnualVal);

  const rows: ComparisonRow[] = [
    {
      key: 'materialRate',
      label: 'Material Rate',
      unit: 'INR_PER_KG',
      currentValue: materialRateDiff.current,
      historicalValue: materialRateDiff.historical,
      absoluteDifference: materialRateDiff.absoluteDifference,
      percentageDifference: materialRateDiff.percentageDifference,
      note: `${targetPart.material} vs ${histMatch.material}`,
    },
    {
      key: 'materialCost',
      label: 'Material Cost',
      unit: 'INR_PER_PC',
      currentValue: materialCostDiff.current,
      historicalValue: materialCostDiff.historical,
      absoluteDifference: materialCostDiff.absoluteDifference,
      percentageDifference: materialCostDiff.percentageDifference,
    },
    {
      key: 'scrap',
      label: 'Scrap',
      unit: 'INR_PER_PC',
      currentValue: scrapCostDiff.current,
      historicalValue: scrapCostDiff.historical,
      absoluteDifference: scrapCostDiff.absoluteDifference,
      percentageDifference: scrapCostDiff.percentageDifference,
      note: `Rate: ${curIn.scrapPct}% vs ${histMatch.historicalScrapPct}%`,
    },
    {
      key: 'conversionCost',
      label: 'Conversion Cost',
      unit: 'INR_PER_PC',
      currentValue: conversionCostDiff.current,
      historicalValue: conversionCostDiff.historical,
      absoluteDifference: conversionCostDiff.absoluteDifference,
      percentageDifference: conversionCostDiff.percentageDifference,
    },
    {
      key: 'overhead',
      label: 'Overhead',
      unit: 'INR_PER_PC',
      currentValue: overheadCostDiff.current,
      historicalValue: overheadCostDiff.historical,
      absoluteDifference: overheadCostDiff.absoluteDifference,
      percentageDifference: overheadCostDiff.percentageDifference,
      note: `Rate: ${curIn.overheadPct}% vs ${histMatch.historicalOverheadPct}%`,
    },
    {
      key: 'packingFreight',
      label: 'Packing / Freight',
      unit: 'INR_PER_PC',
      currentValue: packingFreightDiff.current,
      historicalValue: packingFreightDiff.historical,
      absoluteDifference: packingFreightDiff.absoluteDifference,
      percentageDifference: packingFreightDiff.percentageDifference,
    },
    {
      key: 'setupCost',
      label: `Setup Cost (${tierPercentage}% tier allocation)`,
      unit: 'INR_PER_PC',
      currentValue: setupAllocationDiff.current,
      historicalValue: setupAllocationDiff.historical,
      absoluteDifference: setupAllocationDiff.absoluteDifference,
      percentageDifference: setupAllocationDiff.percentageDifference,
      note: `Total setup: ₹${toMoneyStr(toDec(curIn.setupCostPerPart))} vs ₹${histMatch.historicalSetupCost}`,
    },
    {
      key: 'margin',
      label: 'Margin',
      unit: 'PCT',
      currentValue: marginPctDiff.current,
      historicalValue: marginPctDiff.historical,
      absoluteDifference: marginPctDiff.absoluteDifference,
      percentageDifference: marginPctDiff.percentageDifference,
    },
    {
      key: 'sellingPricePerPiece',
      label: `Selling Price / Piece (${tierPercentage}% tier, ex-GST)`,
      unit: 'INR_PER_PC',
      currentValue: sellingPriceDiff.current,
      historicalValue: sellingPriceDiff.historical,
      absoluteDifference: sellingPriceDiff.absoluteDifference,
      percentageDifference: sellingPriceDiff.percentageDifference,
    },
    {
      key: 'annualVolume',
      label: tierPercentage === 100 ? 'Annual Volume' : `Tier Volume (${tierPercentage}%)`,
      unit: 'PCS',
      currentValue: String(curTier.tierVolume),
      historicalValue: String(histTier.tierVolume),
      absoluteDifference: String(curTier.tierVolume - histTier.tierVolume),
      percentageDifference: annualVolDiff.percentageDifference,
    },
    {
      key: 'annualQuoteValue',
      label:
        tierPercentage === 100
          ? 'Annual Quote Value'
          : `Tier Quote Value (${tierPercentage}% tier)`,
      unit: 'INR',
      currentValue: annualValueDiff.current,
      historicalValue: annualValueDiff.historical,
      absoluteDifference: annualValueDiff.absoluteDifference,
      percentageDifference: annualValueDiff.percentageDifference,
    },
  ];

  return {
    tierPercentage,
    isDirectlyEquivalent: equivalenceWarnings.length === 0,
    equivalenceWarnings,
    current: {
      partId: String(targetPart._id),
      partName: targetPart.partName,
      material: targetPart.material,
      grossWeightKg: targetPart.grossWeightKg,
      costingDate: currentPreview.costingDate,
      annualVolume: targetPart.annualVolume,
      tierVolume: curTier.tierVolume,
      sellingPricePerPieceExGst: sellingPriceDiff.current,
      annualQuoteValue: annualValueDiff.current,
    },
    historical: {
      ...histMatch,
      comparedTierVolume: histTier.tierVolume,
      comparedTierSellingPriceExGst: sellingPriceDiff.historical,
    },
    priceDelta: {
      currentPriceExGst: sellingPriceDiff.current,
      historicalPriceExGst: sellingPriceDiff.historical,
      absoluteDifference: sellingPriceDiff.absoluteDifference,
      percentageDifference: sellingPriceDiff.percentageDifference,
    },
    annualValueDelta: {
      currentAnnualValue: annualValueDiff.current,
      historicalAnnualValue: annualValueDiff.historical,
      absoluteDifference: annualValueDiff.absoluteDifference,
      percentageDifference: annualValueDiff.percentageDifference,
    },
    rows,
  };
}

