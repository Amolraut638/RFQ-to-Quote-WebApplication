/**
 * Main costing engine entry point.
 *
 * calculateCosting is the SINGLE SOURCE OF TRUTH for all costing calculations.
 * It composes the pure functions from the other modules:
 *   1. validateCostingInput  → ValidatedCostingInput
 *   2. calculateCostComponents → CostComponents (full precision, unrounded)
 *   3. buildVolumeTiers      → VolumeTierOutput[] (3 tiers, all rounded to 2dp)
 *   4. Compose CostingResult  — breakdown taken from the base (100%) tier
 *
 * No formulas live here; this module only orchestrates the pipeline.
 */

import { toMoneyString, D } from './decimal';
import { validateCostingInput } from './validation';
import { calculateCostComponents } from './components';
import { buildVolumeTiers, BASE_TIER_PERCENTAGE } from './tiers';
import type { CostingInput, CostingOutput, CostingResult } from './types';

export function calculateCosting(input: CostingInput): CostingResult {
  // 1. Validate — throws CostingError with ALL issues if anything is wrong
  const validated = validateCostingInput(input);

  // 2. Calculate cost components (all in full Decimal precision, unrounded)
  const components = calculateCostComponents(validated);

  // 3. Build volume tiers (50%, 100%, 150%)
  const volumeTiers = buildVolumeTiers(validated, components);

  // 4. Base tier (100%) drives the breakdown summary
  const baseTierIndex = volumeTiers.findIndex((t) => t.tierPercentage === BASE_TIER_PERCENTAGE);
  const baseTier = volumeTiers[baseTierIndex];

  // 5. Compose CostingOutput from base-tier data (avoid duplicating formulas)
  const breakdown: CostingOutput = {
    materialCost: toMoneyString(components.materialCost),
    scrapCost: toMoneyString(components.scrapCost),
    conversionCost: toMoneyString(components.conversionCost),
    overheadCost: toMoneyString(components.overheadCost),
    packingFreight: toMoneyString(components.packingFreight),
    baseManufacturingCost: toMoneyString(components.baseManufacturingCost),
    // The fields below are taken directly from the base tier to avoid any formula duplication
    setupAllocationPerPiece: baseTier.setupAllocationPerPiece,
    totalCost: baseTier.totalCostPerPiece,
    sellingPriceExGst: baseTier.sellingPriceExGst,
    gstAmount: baseTier.gstAmount,
    sellingPriceIncludingGst: baseTier.sellingPriceIncludingGst,
  };

  // 6. Annual quotation value = base-tier selling price (rounded) × annual volume
  const annualQuotationValue = toMoneyString(
    D(baseTier.sellingPriceExGst).times(D(validated.annualVolume)),
  );

  return { breakdown, volumeTiers, annualQuotationValue };
}
