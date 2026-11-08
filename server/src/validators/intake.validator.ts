/**
 * validators/intake.validator.ts
 */

import { z } from 'zod';

export const EmailIntakeSchema = z.object({
  emailText: z.string().trim().min(10, 'Email content must be at least 10 characters'),
  draftId: z.string().trim().min(1).optional(),
});

export const FieldUpdateItemSchema = z.object({
  scope: z.enum(['RFQ', 'PART']),
  partIndex: z.number().int().min(-1).default(-1),
  key: z.string().trim().min(1),
  action: z.enum(['ACCEPT', 'EDIT', 'REJECT']),
  value: z.union([z.string(), z.number(), z.null()]).optional(),
});

export const PatchDraftFieldsSchema = z.object({
  updates: z.array(FieldUpdateItemSchema).default([]),
  addPart: z.boolean().optional(),
});

