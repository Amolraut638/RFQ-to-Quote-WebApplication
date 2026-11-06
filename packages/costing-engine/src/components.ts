/**
 * Cost component calculations.
 *
 * All values are Dec (Decimal) instances carrying full 40-digit precision.
 * No rounding happens here — rounding is deferred to the output boundary.
 *
 * Formulas:
 *   materialCost = grossWeightKg × materialRatePerKg
 *   scrapCost    = materialCost × (scrapPct / 100)
 *   conversionCost = Σ (cycleTimeMinutes / 60) × machineHourRate
 *   overheadCost   = (materialCost + scrapCost + conversionCost) × (overheadPct / 100)
 *   packingFreight = packingFreightPerPiece (pass-through)
 *   baseManufacturingCost = materialCost + scrapCost + conversionCost + overheadCost
 *
 * Note: packing/freight and setup are NOT part of the overhead basis.
 */

import { D } from './decimal';
import type { Dec } from './decimal';
import type { ValidatedCostingInput } from './validation';

export interface CostComponents {
  materialCost: Dec;
  scrapCost: Dec;
  conversionCost: Dec;
  overheadCost: Dec;
  packingFreight: Dec;
  baseManufacturingCost: Dec;
}

export function calculateCostComponents(input: ValidatedCostingInput): CostComponents {
  // materialCost = weight × rate
  const materialCost = input.grossWeightKg.times(input.materialRatePerKg);

  // scrapCost = materialCost × (scrapPct / 100)
  const scrapCost = materialCost.times(input.scrapPct.dividedBy(D(100)));

  // conversionCost = Σ (cycleTimeMinutes / 60) × machineHourRate
  let conversionCost = D(0);
  for (const op of input.operations) {
    const opCost = op.cycleTimeMinutes.dividedBy(D(60)).times(op.machineHourRate);
    conversionCost = conversionCost.plus(opCost);
  }

  // overheadCost = (material + scrap + conversion) × (overheadPct / 100)
  // packing/freight and setup are excluded from the overhead basis
  const overheadBasis = materialCost.plus(scrapCost).plus(conversionCost);
  const overheadCost = overheadBasis.times(input.overheadPct.dividedBy(D(100)));

  // packingFreight is a pass-through per-piece cost
  const packingFreight = input.packingFreightPerPiece;

  // baseManufacturingCost = material + scrap + conversion + overhead
  // Does NOT include packing/freight or setup allocation
  const baseManufacturingCost = materialCost
    .plus(scrapCost)
    .plus(conversionCost)
    .plus(overheadCost);

  return {
    materialCost,
    scrapCost,
    conversionCost,
    overheadCost,
    packingFreight,
    baseManufacturingCost,
  };
}
