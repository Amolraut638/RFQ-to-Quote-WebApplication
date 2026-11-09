/**
 * models/RFQ.ts
 *
 * RFQ register. Each RFQ has one or more Parts (separate collection).
 * Commercial outcome lifecycle: ESTIMATING → SENT → WON | LOST
 * (Separate from Quote lifecycle: DRAFT → PENDING_APPROVAL / READY_FOR_SALES → APPROVED / REJECTED → SENT)
 */

import mongoose, { Document, Schema } from 'mongoose';

export const LOST_REASONS = [
  'PRICE_TOO_HIGH',
  'DELIVERY_TIMELINE',
  'COMPETITOR_SELECTED',
  'TECHNICAL_REJECTION',
  'CUSTOMER_CANCELLED',
  'OTHER',
] as const;

export type LostReason = (typeof LOST_REASONS)[number];

export type RFQCommercialOutcome = 'ESTIMATING' | 'SENT' | 'WON' | 'LOST';

export type RFQStatus = 'ESTIMATING' | 'PENDING_APPROVAL' | 'SENT' | 'WON' | 'LOST';

export interface IRFQ extends Document {
  _id: mongoose.Types.ObjectId;
  rfqNo: string;
  customer: string;
  receivedDate: Date;
  dueDate: Date;
  ownerId: mongoose.Types.ObjectId;
  status: RFQStatus;
  lostReason?: LostReason | string;
  lostReasonNote?: string;
  outcomeUpdatedBy?: mongoose.Types.ObjectId;
  outcomeUpdatedAt?: Date;
  sourceEmailText?: string;
  customerContact?: string;
  /** Provenance marker for historical Excel imports. */
  importSource?: 'HISTORICAL_EXCEL';
  importBatchId?: string;
  isSyntheticDemo?: boolean;
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
    lostReason: {
      type: String,
      enum: [...LOST_REASONS],
    },
    lostReasonNote: {
      type: String,
      trim: true,
    },
    outcomeUpdatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    outcomeUpdatedAt: {
      type: Date,
    },
    sourceEmailText: { type: String },
    customerContact: { type: String, trim: true },
    importSource: {
      type: String,
      enum: ['HISTORICAL_EXCEL'],
    },
    importBatchId: { type: String, trim: true },
    isSyntheticDemo: { type: Boolean },
  },
  { timestamps: true }
);

export const RFQ = mongoose.model<IRFQ>('RFQ', RFQSchema);


