/**
 * Public types of the costing engine.
 *
 * Boundary rule: everything that crosses the module boundary is JSON-safe.
 *  - Inputs accept `number | string` (strings are the safest way to carry
 *    Decimal128 values coming from MongoDB).
 *  - Money outputs are fixed 2-dp strings, e.g. "111.35". Decimal instances are
 *    never returned.
 *
 * This module is pure TypeScript: no Express, React, Mongoose, I/O or env access.
 */

/** A decimal quantity supplied by the caller. Strings avoid float representation error. */
export type DecimalInput = number | string;

/** A monetary amount rounded to 2 dp, serialised as a string (e.g. "42.70"). */
export type MoneyString = string;

export interface RoutingOperation {
  operationName: string;
  machine: string;
  /** Cycle time for ONE piece, in minutes. */
  cycleTimeMinutes: DecimalInput;
  /** Machine rate in ₹ per hour (looked up by the service layer, never defaulted here). */
  machineHourRate: DecimalInput;
}

/** Everything the engine needs for ONE part. All percentages are plain numbers: 4 means 4%. */
export interface CostingInput {
  grossWeightKg: DecimalInput;
  /** ₹ per kg. */
  materialRatePerKg: DecimalInput;
  scrapPct: DecimalInput;
  routingOperations: RoutingOperation[];
  overheadPct: DecimalInput;
  /** ₹ per piece, combined packing + freight. */
  packingFreightPerPiece: DecimalInput;
  /** Total setup/tooling cost for the part (₹), amortised over each tier's volume. */
  setupCostPerPart: DecimalInput;
  /** Whole pieces per year (the 100% tier). */
  annualVolume: number;
  defaultMarginPct: DecimalInput;
  gstPct: DecimalInput;
}

/**
 * Cost breakdown at the base (100%) volume tier.
 * All values are ₹ per piece.
 */
export interface CostingOutput {
  materialCost: MoneyString;
  scrapCost: MoneyString;
  conversionCost: MoneyString;
  overheadCost: MoneyString;
  packingFreight: MoneyString;
  /** material + scrap + conversion + overhead (excludes packing/freight and setup). */
  baseManufacturingCost: MoneyString;
  /** Setup per piece at the base tier. Extra field so that totalCost is explainable. */
  setupAllocationPerPiece: MoneyString;
  /** baseManufacturingCost + packingFreight + setupAllocationPerPiece. */
  totalCost: MoneyString;
  sellingPriceExGst: MoneyString;
  gstAmount: MoneyString;
  sellingPriceIncludingGst: MoneyString;
}

export interface VolumeTierOutput {
  tierName: string;
  /** 50, 100 or 150. */
  tierPercentage: number;
  /** Whole pieces: annualVolume × tierPercentage / 100, rounded half-up. */
  tierVolume: number;
  setupAllocationPerPiece: MoneyString;
  totalCostPerPiece: MoneyString;
  sellingPriceExGst: MoneyString;
  gstAmount: MoneyString;
  sellingPriceIncludingGst: MoneyString;
}

export interface CostingResult {
  breakdown: CostingOutput;
  /** Always three tiers, ordered 50%, 100%, 150%. */
  volumeTiers: VolumeTierOutput[];
  /** Part-level annual value = base-tier sellingPriceExGst × annualVolume. */
  annualQuotationValue: MoneyString;
}

export interface ApprovalDecision {
  totalAnnualValue: MoneyString;
  threshold: MoneyString;
  requiresApproval: boolean;
}
