import type { CostingInput } from '../src';

/**
 * Client-brief worked example (Rear wheel spindle).
 * Treated as a REFERENCE-TEST assumption set, not confirmed production rates.
 */
export const REFERENCE_INPUT: CostingInput = {
  grossWeightKg: 0.61,
  materialRatePerKg: 70,
  scrapPct: 4,
  routingOperations: [
    { operationName: 'Turning', machine: 'CNC Turning', cycleTimeMinutes: 3.2, machineHourRate: 850 },
  ],
  overheadPct: 8,
  packingFreightPerPiece: 2.5,
  setupCostPerPart: 0,
  annualVolume: 180000,
  defaultMarginPct: 12,
  gstPct: 18,
};

/**
 * Hand-checked scenario with non-zero setup, two operations and a 25% overhead.
 *   material 1.2 kg × 85 = 102.00 ; scrap 5% = 5.10
 *   conversion = 1 min @450/h (7.50) + 0.5 min @300/h (2.50) = 10.00
 *   overhead = (102 + 5.1 + 10) × 25% = 29.275
 *   base manufacturing = 146.375 ; packing/freight = 3.50
 */
export const SETUP_INPUT: CostingInput = {
  grossWeightKg: 1.2,
  materialRatePerKg: 85,
  scrapPct: 5,
  routingOperations: [
    { operationName: 'Turning', machine: 'CNC Turning', cycleTimeMinutes: 1, machineHourRate: 450 },
    { operationName: 'Milling', machine: 'VMC Milling', cycleTimeMinutes: 0.5, machineHourRate: 300 },
  ],
  overheadPct: 25,
  packingFreightPerPiece: 3.5,
  setupCostPerPart: 50000,
  annualVolume: 10000,
  defaultMarginPct: 15,
  gstPct: 18,
};

/** Returns a copy of `base` with top-level fields replaced (also allows undefined/null for missing-data tests). */
export function withInput(base: CostingInput, patch: Record<string, unknown>): CostingInput {
  return { ...base, ...patch } as CostingInput;
}

