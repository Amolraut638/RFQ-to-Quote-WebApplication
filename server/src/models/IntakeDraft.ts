/**
 * models/IntakeDraft.ts
 *
 * Staging area for AI-extracted RFQ/part data. Nothing here touches the RFQ or Part
 * collections until the estimator reviews and commits. Uploaded files are NOT stored
 * (memory-only); only the extracted fields + provenance (and pasted email text) are kept.
 */

import mongoose, { Document, Schema } from 'mongoose';

export type IntakeSourceType = 'EMAIL' | 'EXCEL' | 'PDF';
export type FieldStatus = 'PENDING' | 'ACCEPTED' | 'EDITED' | 'REJECTED';
export type DraftStatus = 'PROCESSING' | 'REVIEW_REQUIRED' | 'READY_TO_COMMIT' | 'COMMITTED' | 'FAILED';
export type FieldScope = 'RFQ' | 'PART';
export type FieldMethod = 'AI' | 'MANUAL';

export interface IFieldSource {
  fileName: string;
  sourceType: IntakeSourceType | 'MANUAL';
  page: number | null;
  sheet: string | null;
  cell: string | null;
  originalValue: string | null;
  snippet: string | null;
}

export interface IDraftField {
  scope: FieldScope;
  /** Index into the draft's parts for scope PART; -1 for RFQ fields. */
  partIndex: number;
  key: string;
  /** Current value (AI value until edited). */
  value: string | number | null;
  /** The value the AI originally produced (kept for audit). */
  aiValue: string | number | null;
  source: IFieldSource;
  method: FieldMethod;
  confidence: number | null;
  verified: boolean;
  status: FieldStatus;
}

export interface IIntakeDraft extends Document {
  _id: mongoose.Types.ObjectId;
  createdBy: mongoose.Types.ObjectId;
  sourceType: IntakeSourceType;
  /** All sources merged into this draft (e.g. email + excel + pdf). */
  sources: Array<{
    sourceType: IntakeSourceType;
    fileName: string;
    mimeType?: string;
    sizeBytes?: number;
    pageCount?: number;
    sheetCount?: number;
    extractedAt: Date;
  }>;
  /** Pasted email text only (never file contents). */
  originalEmailText?: string;
  ai: { provider: string; model: string; extractedAt: Date };
  fields: IDraftField[];
  partCount: number;
  status: DraftStatus;
  failureReason?: string;
  committedRfqId?: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const FieldSourceSchema = new Schema<IFieldSource>(
  {
    fileName: { type: String, required: true },
    sourceType: { type: String, enum: ['EMAIL', 'EXCEL', 'PDF', 'MANUAL'], required: true },
    page: { type: Number, default: null },
    sheet: { type: String, default: null },
    cell: { type: String, default: null },
    originalValue: { type: String, default: null },
    snippet: { type: String, default: null },
  },
  { _id: false },
);

const DraftFieldSchema = new Schema<IDraftField>(
  {
    scope: { type: String, enum: ['RFQ', 'PART'], required: true },
    partIndex: { type: Number, required: true },
    key: { type: String, required: true },
    value: { type: Schema.Types.Mixed, default: null },
    aiValue: { type: Schema.Types.Mixed, default: null },
    source: { type: FieldSourceSchema, required: true },
    method: { type: String, enum: ['AI', 'MANUAL'], required: true },
    confidence: { type: Number, default: null },
    verified: { type: Boolean, default: false },
    status: { type: String, enum: ['PENDING', 'ACCEPTED', 'EDITED', 'REJECTED'], default: 'PENDING' },
  },
  { _id: false },
);

const IntakeDraftSchema = new Schema<IIntakeDraft>(
  {
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    sourceType: { type: String, enum: ['EMAIL', 'EXCEL', 'PDF'], required: true },
    sources: [
      {
        _id: false,
        sourceType: { type: String, enum: ['EMAIL', 'EXCEL', 'PDF'], required: true },
        fileName: { type: String, required: true },
        mimeType: String,
        sizeBytes: Number,
        pageCount: Number,
        sheetCount: Number,
        extractedAt: { type: Date, required: true },
      },
    ],
    originalEmailText: { type: String },
    ai: {
      provider: { type: String, required: true },
      model: { type: String, required: true },
      extractedAt: { type: Date, required: true },
    },
    fields: { type: [DraftFieldSchema], default: [] },
    partCount: { type: Number, default: 0 },
    status: {
      type: String,
      enum: ['PROCESSING', 'REVIEW_REQUIRED', 'READY_TO_COMMIT', 'COMMITTED', 'FAILED'],
      default: 'REVIEW_REQUIRED',
      index: true,
    },
    failureReason: { type: String },
    committedRfqId: { type: Schema.Types.ObjectId, ref: 'RFQ' },
  },
  { timestamps: true },
);

export const IntakeDraft = mongoose.model<IIntakeDraft>('IntakeDraft', IntakeDraftSchema);

