/**
 * models/MachineRate.ts
 *
 * Rate versioning: never overwrite. Insert new record per change.
 * Lookup: find the latest record where effectiveFrom <= costingDate.
 *
 * Index: { machine: 1, effectiveFrom: -1 }
 */

import mongoose, { Document, Schema } from 'mongoose';

export interface IMachineRate extends Document {
  _id: mongoose.Types.ObjectId;
  machine: string;
  hourRate: mongoose.Types.Decimal128;
  effectiveFrom: Date;
  createdAt: Date;
}

const MachineRateSchema = new Schema<IMachineRate>(
  {
    machine: { type: String, required: true, trim: true },
    hourRate: { type: mongoose.Schema.Types.Decimal128, required: true },
    effectiveFrom: { type: Date, required: true },
  },
  { timestamps: true }
);

MachineRateSchema.index({ machine: 1, effectiveFrom: -1 });

export const MachineRate = mongoose.model<IMachineRate>('MachineRate', MachineRateSchema);

