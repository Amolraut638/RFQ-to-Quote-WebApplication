/**
 * models/Quote.ts
 *
 * Quotation versioning: every revision is a new document version.
 * The rateSnapshot embedded object freezes all rates at the time of costing.
 * Once a version is submitted/approved/sent, it must never be mutated.
 *
 * Unique compound index: rfqId + version ensures no duplicate versions.
 */

import mongoose, { Document, Schema } from 'mongoose';

export type QuoteStatus = 'DRAFT' | 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED' | 'SENT';

/**
 * Frozen snapshot of every rate used to produce this quotation version.
 * Preserves full traceability: even if masters change, this record never does.
 */
export interface IRateSnapshot {
  // Material
  material: string;
  materialRatePerKg: mongoose.Types.Decimal128;
  materialRateEffectiveFrom: Date;
  // Machine
  machine: string;
  machineHourRate: mongoose.Types.Decimal128;
  machineRateEffectiveFrom: Date;
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

export interface IQuote extends Document {
  _id: mongoose.Types.ObjectId;
  rfqId: mongoose.Types.ObjectId;
  version: number;
  status: QuoteStatus;
  totalAnnualValue: mongoose.Types.Decimal128;
  costingDate: Date;
  createdBy: mongoose.Types.ObjectId;
  approverId?: mongoose.Types.ObjectId;
  approvedAt?: Date;
  rateSnapshot: IRateSnapshot;
  createdAt: Date;
  updatedAt: Date;
}

const RateSnapshotSchema = new Schema<IRateSnapshot>(
  {
    material: { type: String, required: true },
    materialRatePerKg: { type: mongoose.Schema.Types.Decimal128, required: true },
    materialRateEffectiveFrom: { type: Date, required: true },
    machine: { type: String, required: true },
    machineHourRate: { type: mongoose.Schema.Types.Decimal128, required: true },
    machineRateEffectiveFrom: { type: Date, required: true },
    scrapPct: { type: Number, required: true },
    overheadPct: { type: Number, required: true },
    packingFreight: { type: mongoose.Schema.Types.Decimal128, required: true },
    marginPct: { type: Number, required: true },
    gstPct: { type: Number, required: true },
    setupCostPerPart: { type: mongoose.Schema.Types.Decimal128, required: true },
    rateSettingEffectiveFrom: { type: Date, required: true },
    snapshotCreatedAt: { type: Date, required: true, default: Date.now },
  },
  { _id: false }
);

const QuoteSchema = new Schema<IQuote>(
  {
    rfqId: { type: mongoose.Schema.Types.ObjectId, ref: 'RFQ', required: true },
    version: { type: Number, required: true, min: 1 },
    status: {
      type: String,
      enum: ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'SENT'] as QuoteStatus[],
      default: 'DRAFT',
    },
    totalAnnualValue: { type: mongoose.Schema.Types.Decimal128 },
    costingDate: { type: Date },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    approverId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    approvedAt: { type: Date },
    rateSnapshot: { type: RateSnapshotSchema },
  },
  { timestamps: true }
);

// No two versions of the same quote can have the same version number
QuoteSchema.index({ rfqId: 1, version: 1 }, { unique: true });

export const Quote = mongoose.model<IQuote>('Quote', QuoteSchema);

