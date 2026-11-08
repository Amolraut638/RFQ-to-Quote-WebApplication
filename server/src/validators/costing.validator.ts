/**
 * validators/costing.validator.ts
 *
 * Zod schemas for costing workflow request bodies.
 */

import { z } from 'zod';

export const RoutingOperationSchema = z.object({
  operationName: z.string().min(1, 'Operation name is required'),
  machine: z.string().min(1, 'Machine is required'),
  cycleTimeMinutes: z.number().positive('Cycle time must be positive'),
});

export const CostingPreviewSchema = z.object({
  partId: z.string().min(1, 'partId is required'),
  routingOperations: z
    .array(RoutingOperationSchema)
    .min(1, 'At least one routing operation is required'),
  scrapPct: z.number().min(0).max(100).optional(),
  overheadPct: z.number().min(0).max(1000).optional(),
  packingFreight: z.number().min(0).optional(),
  setupCost: z.number().min(0).optional(),
  marginPct: z.number().min(0).max(100).optional(),
  gstPct: z.number().min(0).max(100).optional(),
  costingDate: z.string().optional(),
});

/** Save-quote body has the same shape as preview */
export const SaveQuoteSchema = CostingPreviewSchema;

export type CostingPreviewInput = z.infer<typeof CostingPreviewSchema>;
export type SaveQuoteInput = z.infer<typeof SaveQuoteSchema>;

export const CompareHistoricalQuoteSchema = z
  .object({
    rfqId: z.string().min(1, 'rfqId is required'),
    routingOperations: z
      .array(RoutingOperationSchema)
      .min(1, 'At least one routing operation is required'),
    scrapPct: z.number().min(0).max(100).optional(),
    overheadPct: z.number().min(0).max(1000).optional(),
    packingFreight: z.number().min(0).optional(),
    setupCost: z.number().min(0).optional(),
    marginPct: z.number().min(0).max(100).optional(),
    gstPct: z.number().min(0).max(100).optional(),
    costingDate: z.string().optional(),
    tierPercentage: z.union([z.literal(50), z.literal(100), z.literal(150)]).optional(),
  })
  .strict();

export type CompareHistoricalQuoteRequest = z.infer<typeof CompareHistoricalQuoteSchema>;

