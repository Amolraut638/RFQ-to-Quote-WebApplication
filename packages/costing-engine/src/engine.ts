/**
 * Costing Engine — SKELETON
 *
 * This module is a pure TypeScript function. It has NO side effects, NO I/O,
 * NO database access, NO HTTP calls. All rates are passed in by the caller.
 *
 * Status: NOT IMPLEMENTED — will throw until Day 2 implementation.
 */

import type { CostingEngineInput, CostingEngineOutput } from './types.js';

/**
 * Calculate the full cost breakdown for a part given all rate inputs.
 *
 * @param input - All costing parameters with rates pre-fetched by the service layer
 * @returns Detailed cost breakdown per volume tier plus totals
 * @throws {CostingError} If inputs are invalid (zero/negative volume, missing rate, etc.)
 */
export function calculateCost(_input: CostingEngineInput): CostingEngineOutput {
  throw new Error('Not implemented');
}
