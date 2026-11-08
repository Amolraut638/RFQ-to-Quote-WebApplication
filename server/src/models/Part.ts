/**
 * models/Part.ts
 *
 * Parts belong to an RFQ (separate collection for clean querying).
 * grossWeightKg is stored as a plain Number for Part — costing picks it up.
 * cycleTimeMinutes and machineHourRate are reference figures from the RFQ;
 * actual costing uses rate masters.
 */

import mongoose, { Document, Schema } from 'mongoose';

export interface IPart extends Document {
  _id: mongoose.Types.ObjectId;
  rfqId: mongoose.Types.ObjectId;
  partName: string;
  material: string;
  grossWeightKg: number;
  annualVolume: number;
  cycleTimeMinutes?: number;
  machineHourRateRef?: mongoose.Types.Decimal128; // reference figure only
  drawingNumber?: string;
  drawingRevision?: string;
  createdAt: Date;
  updatedAt: Date;
}

const PartSchema = new Schema<IPart>(
  {
    rfqId: { type: mongoose.Schema.Types.ObjectId, ref: 'RFQ', required: true, index: true },
    partName: { type: String, required: true, trim: true },
    material: { type: String, required: true, trim: true },
    grossWeightKg: { type: Number, required: true, min: 0 },
    annualVolume: { type: Number, required: true, min: 1 },
    cycleTimeMinutes: { type: Number },
    machineHourRateRef: { type: mongoose.Schema.Types.Decimal128 },
    drawingNumber: { type: String, trim: true },
    drawingRevision: { type: String, trim: true },
  },
  { timestamps: true }
);

export const Part = mongoose.model<IPart>('Part', PartSchema);

