/**
 * validators/rfq.validator.ts
 */

import { z } from 'zod';
import { LOST_REASONS } from '../models/RFQ';

export const CreateRFQSchema = z.object({
  rfqNo: z.string().min(1, 'RFQ number is required').trim(),
  customer: z.string().min(1, 'Customer name is required').trim(),
  receivedDate: z.string().datetime({ message: 'Invalid receivedDate' }),
  dueDate: z.string().datetime({ message: 'Invalid dueDate' }),
  sourceEmailText: z.string().optional(),
});

export type CreateRFQInput = z.infer<typeof CreateRFQSchema>;

export const LostReasonEnum = z.enum(LOST_REASONS);

export const UpdateRFQOutcomeSchema = z
  .object({
    outcome: z.enum(['WON', 'LOST']),
    lostReason: LostReasonEnum.optional(),
    lostReasonNote: z.string().trim().max(500, 'Explanation note cannot exceed 500 characters').optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (data.outcome === 'LOST') {
      if (!data.lostReason) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['lostReason'],
          message: 'A lostReason is required when marking an RFQ as LOST.',
        });
      }
      if (data.lostReason === 'OTHER') {
        const note = data.lostReasonNote?.trim() ?? '';
        if (note.length < 5) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['lostReasonNote'],
            message: 'A meaningful explanation (at least 5 characters) is required when lostReason is OTHER.',
          });
        }
      }
    }
  });

export type UpdateRFQOutcomeInput = z.infer<typeof UpdateRFQOutcomeSchema>;


