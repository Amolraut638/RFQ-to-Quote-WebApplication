/**
 * models/RateSetting.ts
 *
 * Global costing assumptions that an estimator can tune:
 *   scrapPct, overheadPct, packingFreight, defaultMarginPct, gstPct, setupCostPerPart
 *
 * Rate versioning: never overwrite. Insert new record per change.
 * Lookup: find the latest record where effectiveFrom <= costingDate.
 *
 * These are illustrative defaults, not client-provided values.
 */

import mongoose, { Document, Schema } from 'mongoose';

export interface IRateSetting extends Document {
  _id: mongoose.Types.ObjectId;
  scrapPct: number;
  overheadPct: number;
  packingFreight: mongoose.Types.Decimal128;
  defaultMarginPct: number;
  gstPct: number;
  setupCostPerPart: mongoose.Types.Decimal128;
  effectiveFrom: Date;
  createdAt: Date;
}

const RateSettingSchema = new Schema<IRateSetting>(
  {
    scrapPct: { type: Number, required: true },
    overheadPct: { type: Number, required: true },
    packingFreight: { type: mongoose.Schema.Types.Decimal128, required: true },
    defaultMarginPct: { type: Number, required: true },
    gstPct: { type: Number, required: true },
    setupCostPerPart: { type: mongoose.Schema.Types.Decimal128, required: true },
    effectiveFrom: { type: Date, required: true },
  },
  { timestamps: true }
);

RateSettingSchema.index({ effectiveFrom: -1 });

export const RateSetting = mongoose.model<IRateSetting>('RateSetting', RateSettingSchema);

