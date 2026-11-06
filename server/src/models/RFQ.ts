/**
 * models/RFQ.ts
 *
 * RFQ register. Each RFQ has one or more Parts (separate collection).
 * Status transitions: ESTIMATING → PENDING_APPROVAL → SENT → WON | LOST
 */

import mongoose, { Document, Schema } from 'mongoose';

export type RFQStatus = 'ESTIMATING' | 'PENDING_APPROVAL' | 'SENT' | 'WON' | 'LOST';

export interface IRFQ extends Document {
  _id: mongoose.Types.ObjectId;
  rfqNo: string;
  customer: string;
  receivedDate: Date;
  dueDate: Date;
  ownerId: mongoose.Types.ObjectId;
  status: RFQStatus;
  lostReason?: string;
  sourceEmailText?: string;
  createdAt: Date;
  updatedAt: Date;
}

const RFQSchema = new Schema<IRFQ>(
  {
    rfqNo: { type: String, required: true, unique: true, trim: true, index: true },
    customer: { type: String, required: true, trim: true },
    receivedDate: { type: Date, required: true },
    dueDate: { type: Date, required: true, index: true },
    ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    status: {
      type: String,
      enum: ['ESTIMATING', 'PENDING_APPROVAL', 'SENT', 'WON', 'LOST'] as RFQStatus[],
      default: 'ESTIMATING',
      index: true,
    },
    lostReason: { type: String },
    sourceEmailText: { type: String },
  },
  { timestamps: true }
);

export const RFQ = mongoose.model<IRFQ>('RFQ', RFQSchema);

