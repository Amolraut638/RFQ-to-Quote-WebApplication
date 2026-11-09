/**
 * models/Quote.ts
 *
 * Quotation versioning: every revision is a new document version.
 * The rateSnapshot embedded object freezes all rates AND results at costing time.
 * Once a version is PENDING_APPROVAL, APPROVED, or SENT, it is immutable.
 *
 * Key design decisions:
 *  - rateSnapshot.operations[] replaces single machine fields — supports multiple
 *    routing operations as the costing engine requires.
 *  - costingInputSnapshot stores the original validated inputs so the quote is
 *    fully self-contained and can be audited without the rate masters.
 *  - volumeTierResults stores all three tier outputs (50/100/150%).
 *  - costBreakdown stores the per-piece breakdown at the base (100%) tier.
 *  - annualQuotationValue is the base tier selling price × annual volume.
 *  - Immutability is enforced server-side in the service layer; the schema
 *    records status so middleware can gate mutations.
 *
 * Unique compound index: rfqId + version prevents duplicate versions.
 */

import mongoose, { Document, Schema } from 'mongoose';

export type QuoteStatus =
  | 'DRAFT'
  | 'PENDING_APPROVAL'
  | 'APPROVED'
  | 'REJECTED'
  | 'READY_FOR_SALES'
  | 'SENT';

/** Statuses that lock a quote version against any further editing. */
export const IMMUTABLE_STATUSES: readonly QuoteStatus[] = [
  'PENDING_APPROVAL',
  'APPROVED',
  'READY_FOR_SALES',
  'SENT',
];

// ─── Operation snapshot ───────────────────────────────────────────────────────

/**
 * Snapshot of a single routing operation used at costing time.
 * Preserves every field needed to reproduce or audit the conversion cost.
 */
export interface ISnapshotOperation {
  operationName: string;
  machine: string;
  /** Cycle time in minutes (matches the costing engine's CostingInput field). */
  cycleTimeMinutes: mongoose.Types.Decimal128;
  /** Machine hour rate in ₹/hr at the time of costing. */
  machineHourRate: mongoose.Types.Decimal128;
  /** effectiveFrom of the MachineRate record used. */
  machineRateEffectiveFrom: Date;
}

// ─── Rate snapshot ────────────────────────────────────────────────────────────

/**
 * Frozen snapshot of every rate used to produce this quotation version.
 * Preserves full traceability: even if masters change, this record never does.
 */
export interface IRateSnapshot {
  // Material
  material: string;
  materialRatePerKg: mongoose.Types.Decimal128;
  materialRateEffectiveFrom: Date;
  // Routing operations (one per operation; replaces the old single-machine fields)
  operations: ISnapshotOperation[];
  // Global assumptions
  scrapPct: number;
  overheadPct: number;
  packingFreight: mongoose.Types.Decimal128;
  marginPct: number;
  gstPct: number;
  setupCostPerPart: mongoose.Types.Decimal128;
  rateSettingEffectiveFrom: Date;
  // Metadata
  snapshotCreatedAt: Date;
}

// ─── Costing input snapshot ───────────────────────────────────────────────────

/**
 * Verbatim copy of the CostingInput passed to calculateCosting().
 * Stored so the quote is fully auditable without rate masters.
 * All monetary values stored as Decimal128; percentages as plain numbers.
 */
export interface ICostingInputSnapshot {
  grossWeightKg: mongoose.Types.Decimal128;
  materialRatePerKg: mongoose.Types.Decimal128;
  scrapPct: number;
  routingOperations: Array<{
    operationName: string;
    machine: string;
    cycleTimeMinutes: mongoose.Types.Decimal128;
    machineHourRate: mongoose.Types.Decimal128;
  }>;
  overheadPct: number;
  packingFreightPerPiece: mongoose.Types.Decimal128;
  setupCostPerPart: mongoose.Types.Decimal128;
  annualVolume: number;
  defaultMarginPct: number;
  gstPct: number;
}

// ─── Cost breakdown snapshot ──────────────────────────────────────────────────

/**
 * Per-piece cost breakdown at the base (100%) tier.
 * All monetary values stored as strings (the costing engine's MoneyString format).
 * This is a snapshot — never recalculated from rate masters after creation.
 */
export interface ICostBreakdownSnapshot {
  materialCost: string;
  scrapCost: string;
  conversionCost: string;
  overheadCost: string;
  packingFreight: string;
  baseManufacturingCost: string;
  setupAllocationPerPiece: string;
  totalCost: string;
  sellingPriceExGst: string;
  gstAmount: string;
  sellingPriceIncludingGst: string;
}

// ─── Volume tier snapshot ─────────────────────────────────────────────────────

export interface IVolumeTierSnapshot {
  tierName: string;
  tierPercentage: number;
  tierVolume: number;
  setupAllocationPerPiece: string;
  totalCostPerPiece: string;
  sellingPriceExGst: string;
  gstAmount: string;
  sellingPriceIncludingGst: string;
}

// ─── Quote document ───────────────────────────────────────────────────────────

export interface IQuote extends Document {
  _id: mongoose.Types.ObjectId;
  rfqId: mongoose.Types.ObjectId;
  /** Version number; starts at 1, incremented for each revision. */
  version: number;
  status: QuoteStatus;
  /** Annual quotation value = base-tier selling price × annual volume. */
  totalAnnualValue: mongoose.Types.Decimal128;
  /** Date on which the costing was performed. Rate lookup uses this date. */
  costingDate: Date;
  createdBy: mongoose.Types.ObjectId;
  approverId?: mongoose.Types.ObjectId;
  approvedAt?: Date;
  /** Which part was costed — optional for backward compat with pre-Day4 quotes. */
  partId?: mongoose.Types.ObjectId;
  submittedBy?: mongoose.Types.ObjectId;
  submittedAt?: Date;
  rejectedBy?: mongoose.Types.ObjectId;
  rejectedAt?: Date;
  /** Mandatory comment when rejecting. Stored once, never modified. */
  rejectionComment?: string;
  sentBy?: mongoose.Types.ObjectId;
  sentAt?: Date;
  /** Frozen rate snapshot — set once at creation, never mutated. */
  rateSnapshot: IRateSnapshot;
  /** Verbatim costing inputs — preserved for auditability. */
  costingInputSnapshot: ICostingInputSnapshot;
  /** Per-piece cost breakdown at the 100% tier. */
  costBreakdown: ICostBreakdownSnapshot;
  /** All three volume tiers (50/100/150%). */
  volumeTierResults: IVolumeTierSnapshot[];
  /** Part-level annual value = base-tier sellingPriceExGst × annualVolume. */
  annualQuotationValue: string;
  /** Historical Excel import provenance fields (optional; undefined for native quotes). */
  importSource?: 'HISTORICAL_EXCEL';
  importBatchId?: string;
  externalRowKey?: string;
  isSyntheticDemo?: boolean;
  /** Preserved verbatim if the historical Excel row stated a selling price. */
  historicalStatedPriceExGst?: mongoose.Types.Decimal128;
  /** True when historicalStatedPriceExGst differs from deterministic engine calculation by >= ₹0.01. */
  priceDiscrepancyFlag?: boolean;
  /** Difference (historicalStatedPriceExGst - costBreakdown.sellingPriceExGst) when flagged. */
  priceDiscrepancyDelta?: mongoose.Types.Decimal128;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Mongoose schemas ─────────────────────────────────────────────────────────

const SnapshotOperationSchema = new Schema<ISnapshotOperation>(
  {
    operationName: { type: String, required: true },
    machine: { type: String, required: true },
    cycleTimeMinutes: { type: mongoose.Schema.Types.Decimal128, required: true },
    machineHourRate: { type: mongoose.Schema.Types.Decimal128, required: true },
    machineRateEffectiveFrom: { type: Date, required: true },
  },
  { _id: false },
);

const RateSnapshotSchema = new Schema<IRateSnapshot>(
  {
    material: { type: String, required: true },
    materialRatePerKg: { type: mongoose.Schema.Types.Decimal128, required: true },
    materialRateEffectiveFrom: { type: Date, required: true },
    operations: { type: [SnapshotOperationSchema], required: true },
    scrapPct: { type: Number, required: true },
    overheadPct: { type: Number, required: true },
    packingFreight: { type: mongoose.Schema.Types.Decimal128, required: true },
    marginPct: { type: Number, required: true },
    gstPct: { type: Number, required: true },
    setupCostPerPart: { type: mongoose.Schema.Types.Decimal128, required: true },
    rateSettingEffectiveFrom: { type: Date, required: true },
    snapshotCreatedAt: { type: Date, required: true, default: Date.now },
  },
  { _id: false },
);

const CostingInputSnapshotSchema = new Schema<ICostingInputSnapshot>(
  {
    grossWeightKg: { type: mongoose.Schema.Types.Decimal128, required: true },
    materialRatePerKg: { type: mongoose.Schema.Types.Decimal128, required: true },
    scrapPct: { type: Number, required: true },
    routingOperations: [
      {
        _id: false,
        operationName: { type: String, required: true },
        machine: { type: String, required: true },
        cycleTimeMinutes: { type: mongoose.Schema.Types.Decimal128, required: true },
        machineHourRate: { type: mongoose.Schema.Types.Decimal128, required: true },
      },
    ],
    overheadPct: { type: Number, required: true },
    packingFreightPerPiece: { type: mongoose.Schema.Types.Decimal128, required: true },
    setupCostPerPart: { type: mongoose.Schema.Types.Decimal128, required: true },
    annualVolume: { type: Number, required: true },
    defaultMarginPct: { type: Number, required: true },
    gstPct: { type: Number, required: true },
  },
  { _id: false },
);

const CostBreakdownSnapshotSchema = new Schema<ICostBreakdownSnapshot>(
  {
    materialCost: { type: String, required: true },
    scrapCost: { type: String, required: true },
    conversionCost: { type: String, required: true },
    overheadCost: { type: String, required: true },
    packingFreight: { type: String, required: true },
    baseManufacturingCost: { type: String, required: true },
    setupAllocationPerPiece: { type: String, required: true },
    totalCost: { type: String, required: true },
    sellingPriceExGst: { type: String, required: true },
    gstAmount: { type: String, required: true },
    sellingPriceIncludingGst: { type: String, required: true },
  },
  { _id: false },
);

const VolumeTierSnapshotSchema = new Schema<IVolumeTierSnapshot>(
  {
    tierName: { type: String, required: true },
    tierPercentage: { type: Number, required: true },
    tierVolume: { type: Number, required: true },
    setupAllocationPerPiece: { type: String, required: true },
    totalCostPerPiece: { type: String, required: true },
    sellingPriceExGst: { type: String, required: true },
    gstAmount: { type: String, required: true },
    sellingPriceIncludingGst: { type: String, required: true },
  },
  { _id: false },
);

const QuoteSchema = new Schema<IQuote>(
  {
    rfqId: { type: mongoose.Schema.Types.ObjectId, ref: 'RFQ', required: true },
    version: { type: Number, required: true, min: 1 },
    status: {
      type: String,
      enum: ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'READY_FOR_SALES', 'SENT'] as QuoteStatus[],
      default: 'DRAFT',
    },
    totalAnnualValue: { type: mongoose.Schema.Types.Decimal128 },
    costingDate: { type: Date, required: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    approverId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    approvedAt: { type: Date },
    partId: { type: mongoose.Schema.Types.ObjectId, ref: 'Part' },
    submittedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    submittedAt: { type: Date },
    rejectedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    rejectedAt: { type: Date },
    rejectionComment: { type: String },
    sentBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    sentAt: { type: Date },
    rateSnapshot: { type: RateSnapshotSchema, required: true },
    costingInputSnapshot: { type: CostingInputSnapshotSchema, required: true },
    costBreakdown: { type: CostBreakdownSnapshotSchema, required: true },
    volumeTierResults: { type: [VolumeTierSnapshotSchema], required: true },
    annualQuotationValue: { type: String, required: true },
    importSource: {
      type: String,
      enum: ['HISTORICAL_EXCEL'],
    },
    importBatchId: { type: String, trim: true, index: true },
    externalRowKey: { type: String, trim: true },
    isSyntheticDemo: { type: Boolean },
    historicalStatedPriceExGst: { type: mongoose.Schema.Types.Decimal128 },
    priceDiscrepancyFlag: { type: Boolean },
    priceDiscrepancyDelta: { type: mongoose.Schema.Types.Decimal128 },
  },
  { timestamps: true },
);

// No two versions of the same RFQ can share a version number.
QuoteSchema.index({ rfqId: 1, version: 1 }, { unique: true });
QuoteSchema.index({ externalRowKey: 1 }, { unique: true, sparse: true });

export const Quote = mongoose.model<IQuote>('Quote', QuoteSchema);
