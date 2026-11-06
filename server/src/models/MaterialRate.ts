/**
 * models/MaterialRate.ts
 *
 * Rate versioning: never overwrite a record. Insert a new document per change.
 * Lookup: find the latest record where effectiveFrom <= costingDate.
 *
 * Index supports efficient rate lookups: { material: 1, effectiveFrom: -1 }
 */

import mongoose, { Document, Schema } from 'mongoose';

export interface IMaterialRate extends Document {
  _id: mongoose.Types.ObjectId;
  material: string;
  ratePerKg: mongoose.Types.Decimal128;
  effectiveFrom: Date;
  createdAt: Date;
}

const MaterialRateSchema = new Schema<IMaterialRate>(
  {
    material: { type: String, required: true, trim: true },
    ratePerKg: { type: mongoose.Schema.Types.Decimal128, required: true },
    effectiveFrom: { type: Date, required: true },
  },
  { timestamps: true }
);

MaterialRateSchema.index({ material: 1, effectiveFrom: -1 });

export const MaterialRate = mongoose.model<IMaterialRate>('MaterialRate', MaterialRateSchema);

