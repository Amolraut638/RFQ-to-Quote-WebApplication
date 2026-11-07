/**
 * models/QuoteEvent.ts
 *
 * Immutable audit trail for quote lifecycle events.
 * Each event is written once and never updated.
 *
 * Actions:
 *  SUBMITTED — estimator submitted the quote (→ PENDING_APPROVAL or READY_FOR_SALES)
 *  APPROVED  — Sales Head approved a PENDING_APPROVAL quote
 *  REJECTED  — Sales Head rejected a PENDING_APPROVAL quote (comment required)
 *  SENT      — Sales Head marked a quotation as sent to customer
 */

import mongoose, { Document, Schema } from 'mongoose';

export type QuoteEventAction = 'SUBMITTED' | 'APPROVED' | 'REJECTED' | 'SENT';

export interface IQuoteEvent extends Document {
  _id: mongoose.Types.ObjectId;
  quoteId: mongoose.Types.ObjectId;
  rfqId: mongoose.Types.ObjectId;
  version: number;
  action: QuoteEventAction;
  actorId: mongoose.Types.ObjectId;
  timestamp: Date;
  comment?: string;
  createdAt: Date;
  updatedAt: Date;
}

const QuoteEventSchema = new Schema<IQuoteEvent>(
  {
    quoteId: { type: mongoose.Schema.Types.ObjectId, ref: 'Quote', required: true },
    rfqId: { type: mongoose.Schema.Types.ObjectId, ref: 'RFQ', required: true },
    version: { type: Number, required: true },
    action: {
      type: String,
      enum: ['SUBMITTED', 'APPROVED', 'REJECTED', 'SENT'] as QuoteEventAction[],
      required: true,
    },
    actorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    timestamp: { type: Date, required: true, default: Date.now },
    comment: { type: String },
  },
  { timestamps: true },
);

// Efficient lookup of all events for a quote, in order
QuoteEventSchema.index({ quoteId: 1, version: 1 });

export const QuoteEvent = mongoose.model<IQuoteEvent>('QuoteEvent', QuoteEventSchema);

