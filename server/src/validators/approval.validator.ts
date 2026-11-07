import { z } from 'zod';

export const RejectQuoteSchema = z.object({
  comment: z.string().trim().min(1, 'Rejection comment is required'),
});

