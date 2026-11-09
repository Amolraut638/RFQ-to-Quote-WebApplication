/**
 * models/RFQEvent.ts
 *
 * Immutable audit trail for RFQ commercial outcome transitions:
 *  SENT — RFQ moved to SENT when a quotation version is marked as sent to customer
 *  WON  — Sales Head recorded commercial outcome as WON
 *  LOST — Sales Head recorded commercial outcome as LOST (with mandatory lostReason)
 *
 * Separate from QuoteEvent (which tracks per-version quote lifecycle).
 */

import mongoose, { Document, Schema } from 'mongoose';
import type { LostReason, RFQStatus } from './RFQ';

export const RFQ_LOST_REASONS = [
  'PRICE_TOO_HIGH',
  'DELIVERY_TIMELINE',
  'COMPETITOR_SELECTED',
  'TECHNICAL_REJECTION',
  'CUSTOMER_CANCELLED',
  'OTHER',
] as const;

export type RFQEventAction = 'SENT' | 'WON' | 'LOST';

export interface IRFQEvent extends Document {
  _id: mongoose.Types.ObjectId;
  rfqId: mongoose.Types.ObjectId;
  action: RFQEventAction;
  previousStatus: RFQStatus;
  newStatus: 'SENT' | 'WON' | 'LOST';
  actorId: mongoose.Types.ObjectId;
  timestamp: Date;
  lostReason?: LostReason;
  lostReasonNote?: string;
  quoteId?: mongoose.Types.ObjectId;
  quoteVersion?: number;
  createdAt: Date;
  updatedAt: Date;
}

const RFQEventSchema = new Schema<IRFQEvent>(
  {
    rfqId: { type: mongoose.Schema.Types.ObjectId, ref: 'RFQ', required: true, index: true },
    action: {
      type: String,
      enum: ['SENT', 'WON', 'LOST'] as RFQEventAction[],
      required: true,
    },
    previousStatus: {
      type: String,
      enum: ['ESTIMATING', 'PENDING_APPROVAL', 'SENT', 'WON', 'LOST'] as RFQStatus[],
      required: true,
    },
    newStatus: {
      type: String,
      enum: ['SENT', 'WON', 'LOST'],
      required: true,
    },
    actorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    timestamp: { type: Date, required: true, default: Date.now },
    lostReason: {
      type: String,
      enum: [...RFQ_LOST_REASONS],
    },
    lostReasonNote: {
      type: String,
      trim: true,
    },
    quoteId: { type: mongoose.Schema.Types.ObjectId, ref: 'Quote' },
    quoteVersion: { type: Number },
  },
  { timestamps: true },
);

RFQEventSchema.index({ rfqId: 1, timestamp: 1 });

export const RFQEvent = mongoose.model<IRFQEvent>('RFQEvent', RFQEventSchema);
