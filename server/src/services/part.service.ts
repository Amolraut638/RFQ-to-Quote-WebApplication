/**
 * services/part.service.ts
 *
 * Part creation (Zod-validated). Accepts an optional Mongo session so the intake
 * commit can create the RFQ and all its parts atomically.
 */

import mongoose, { type ClientSession } from 'mongoose';
import { z } from 'zod';
import { Part, type IPart } from '../models/Part';
import { RFQ } from '../models/RFQ';

export const CreatePartSchema = z.object({
  partName: z.string().trim().min(1, 'Part name is required'),
  material: z.string().trim().min(1, 'Material is required'),
  grossWeightKg: z.number({ invalid_type_error: 'Gross weight must be a number' }).positive('Gross weight must be positive'),
  annualVolume: z.number().int('Annual volume must be a whole number').positive('Annual volume must be positive'),
  cycleTimeMinutes: z.number().positive().optional(),
  drawingNumber: z.string().trim().min(1).optional(),
  drawingRevision: z.string().trim().min(1).optional(),
});
export type CreatePartInput = z.infer<typeof CreatePartSchema>;

export class PartServiceError extends Error {
  constructor(public readonly code: 'RFQ_NOT_FOUND' | 'INVALID_ID', message: string) {
    super(message);
    this.name = 'PartServiceError';
  }
}

export async function createPart(
  rfqId: string | mongoose.Types.ObjectId,
  data: CreatePartInput,
  session?: ClientSession,
): Promise<IPart> {
  if (!mongoose.isValidObjectId(rfqId)) throw new PartServiceError('INVALID_ID', 'Invalid RFQ id');
  const rfq = await RFQ.findById(rfqId).session(session ?? null).lean();
  if (!rfq) throw new PartServiceError('RFQ_NOT_FOUND', 'RFQ not found');
  const [part] = await Part.create([{ ...data, rfqId }], { session });
  return part;
}

