/**
 * Types for the costing engine.
 * This module is a pure TypeScript module — it MUST NOT import Express, React, or Mongoose.
 */

export interface ProcessRateInput {
  processCode: string;
  processName: string;
  /** Rate in currency per hour */
  ratePerHour: number;
  /** Cycle time for this process step in seconds */
  cycleTimeSeconds: number;
}

export interface VolumeTierInput {
  volume: number;
  tierLabel?: string;
  /** If provided, overrides the calculated selling price for this tier */
  priceOverride?: number;
}

export interface CostingEngineInput {
  /** Looked up externally and passed in — engine does NOT query DB */
  materialRatePerKg: number;
  materialGradeCode: string;
  weightKg: number;
  /** Percentage, e.g. 5 means 5% */
  scrapRatePercent: number;
  processes: ProcessRateInput[];
  /** Percentage, e.g. 25 means 25% */
  overheadRatePercent: number;
  /** Total setup cost (amortized over volume per tier) */
  setupCostTotal: number;
  /** Volume tiers — at least one required */
  annualVolumes: VolumeTierInput[];
  packagingCostPerPiece: number;
  freightCostPerPiece: number;
  /** Percentage, e.g. 15 means 15% margin. If undefined, sellingPrice = totalCostPerPiece */
  targetMarginPercent?: number;
  /** Percentage, e.g. 18 means 18% GST */
  gstRatePercent: number;
  costingDate?: Date;
  /** Quotes where totalCostPerPiece exceeds this require SALES_HEAD approval */
  approvalThreshold?: number;
}

export interface VolumeTierResult {
  volume: number;
  tierLabel?: string;
  materialCostPerPiece: number;
  conversionCostPerPiece: number;
  overheadCostPerPiece: number;
  setupCostPerPiece: number;
  totalManufacturingCost: number;
  packagingCostPerPiece: number;
  freightCostPerPiece: number;
  totalCostPerPiece: number;
  sellingPricePerPiece: number;
  gstAmount: number;
  annualValue: number;
}

export interface CostingEngineOutput {
  volumeTiers: VolumeTierResult[];
  /** Sum of annualValue across all tiers */
  totalAnnualValue: number;
  /** True if any tier's totalCostPerPiece exceeds approvalThreshold */
  requiresApproval: boolean;
  /** The threshold that was used for the approval check */
  approvalThreshold?: number;
}

export interface CostingEngineError {
  code: 'MISSING_RATE' | 'INVALID_VOLUME' | 'INVALID_INPUT';
  message: string;
  field?: string;
}

export class CostingError extends Error {
  public readonly code: CostingEngineError['code'];
  public readonly field?: string;

  constructor(error: CostingEngineError) {
    super(error.message);
    this.name = 'CostingError';
    this.code = error.code;
    this.field = error.field;
  }
}
