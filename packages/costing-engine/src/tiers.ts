/**
 * Volume tier calculations.
 *
 * Always three tiers: 50% (Low), 100% (Base), 150% (High) of annualVolume.
 *
 * Tier volume = round_half_up(annualVolume × pct / 100), whole pieces.
 * A tier volume of 0 is never allowed and throws CostingError.
 *
 * Per-tier formulas:
 *   setupAlloc = setupCostPerPart / tierVolume
 *   totalCostPerPiece = baseManufacturingCost + packingFreight + setupAlloc
 *   sellingPriceExGst = totalCostPerPiece × (1 + defaultMarginPct / 100)   [markup]
 *   gstAmount = round2dp(sellingPriceExGst) × (gstPct / 100)               [on ROUNDED price]
 *   sellingPriceIncludingGst = round2dp(sellingPriceExGst) + round2dp(gstAmount)
 *
 * GST is computed on the ROUNDED selling price, not the intermediate value.
 * This matches the test expectations.
 */

import { D, roundMoney, toMoneyString } from './decimal';
import { CostingError } from './errors';
import type { VolumeTierOutput } from './types';
import type { CostComponents } from './components';
import type { ValidatedCostingInput } from './validation';

export interface TierDefinition {
  name: string;
  percentage: number;
}

export const VOLUME_TIERS: readonly TierDefinition[] = [
  { name: 'Low', percentage: 50 },
  { name: 'Base', percentage: 100 },
  { name: 'High', percentage: 150 },
];

export const BASE_TIER_PERCENTAGE = 100;

/**
 * Compute the whole-piece volume for a tier.
 * Rounds half-up. Throws CostingError if the result is 0.
 */
export function computeTierVolume(annual: number, pct: number): number {
  if (
    typeof annual !== 'number' ||
    !Number.isSafeInteger(annual) ||
    annual <= 0
  ) {
    throw new CostingError([{ code: 'INVALID_VOLUME', field: 'annualVolume', message: `annualVolume must be a positive safe integer, got ${JSON.stringify(annual)}` }]);
  }
  if (typeof pct !== 'number' || !Number.isFinite(pct) || pct <= 0) {
    throw new CostingError([{ code: 'INVALID_VOLUME', field: 'tierPercentage', message: `tier percentage must be a positive number, got ${JSON.stringify(pct)}` }]);
  }
  // Use Decimal for the intermediate multiplication to avoid float drift
  const rawVolume = D(annual).times(D(pct)).dividedBy(D(100));
  // Round half-up to whole pieces
  const volume = Number(rawVolume.toDecimalPlaces(0, D.ROUND_HALF_UP).toString());
  if (volume === 0) {
    throw new CostingError([{
      code: 'INVALID_VOLUME',
      field: 'tierVolume',
      message: `Tier volume computed to 0 for annual=${annual} at ${pct}% — cannot cost a zero-volume tier`,
    }]);
  }
  return volume;
}

/**
 * Build all three volume tiers and return them in Low → Base → High order.
 */
export function buildVolumeTiers(
  input: ValidatedCostingInput,
  components: CostComponents,
): VolumeTierOutput[] {
  return VOLUME_TIERS.map((tier) => {
    const tierVolume = computeTierVolume(input.annualVolume, tier.percentage);

    // Setup allocation per piece (full precision intermediate)
    const setupAlloc = input.setupCostPerPart.dividedBy(D(tierVolume));

    // Total cost per piece (full precision)
    const totalCostPerPiece = components.baseManufacturingCost
      .plus(components.packingFreight)
      .plus(setupAlloc);

    // Selling price ex-GST = total × (1 + margin%)
    const sellingPriceExGstRaw = totalCostPerPiece.times(
      D(1).plus(input.defaultMarginPct.dividedBy(D(100))),
    );

    // Round selling price to 2dp before computing GST
    const sellingPriceExGstRounded = roundMoney(sellingPriceExGstRaw);

    // GST computed on the ROUNDED selling price
    const gstAmountRounded = roundMoney(
      sellingPriceExGstRounded.times(input.gstPct.dividedBy(D(100))),
    );

    // Inclusive = rounded exclusive + rounded GST
    const sellingPriceIncludingGst = sellingPriceExGstRounded.plus(gstAmountRounded);

    return {
      tierName: tier.name,
      tierPercentage: tier.percentage,
      tierVolume,
      setupAllocationPerPiece: toMoneyString(setupAlloc),
      totalCostPerPiece: toMoneyString(totalCostPerPiece),
      sellingPriceExGst: toMoneyString(sellingPriceExGstRaw),
      gstAmount: toMoneyString(gstAmountRounded),
      sellingPriceIncludingGst: toMoneyString(sellingPriceIncludingGst),
    };
  });
}
