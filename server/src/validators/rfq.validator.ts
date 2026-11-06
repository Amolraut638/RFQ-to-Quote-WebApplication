/**
 * validators/rfq.validator.ts
 */

import { z } from 'zod';

export const CreateRFQSchema = z.object({
  rfqNo: z.string().min(1, 'RFQ number is required').trim(),
  customer: z.string().min(1, 'Customer name is required').trim(),
  receivedDate: z.string().datetime({ message: 'Invalid receivedDate' }),
  dueDate: z.string().datetime({ message: 'Invalid dueDate' }),
  sourceEmailText: z.string().optional(),
});

export type CreateRFQInput = z.infer<typeof CreateRFQSchema>;

export const UpdateRFQStatusSchema = z.object({
  status: z.enum(['ESTIMATING', 'PENDING_APPROVAL', 'SENT', 'WON', 'LOST']),
  lostReason: z.string().optional(),
});

