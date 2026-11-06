/**
 * Costing Engine — TDD Test Suite
 *
 * These tests are written BEFORE the engine is implemented.
 * All tests MUST FAIL until engine.ts is fully implemented.
 *
 * Run: npm run test --workspace=packages/costing-engine
 */

import { describe, it, expect } from 'vitest';
import { calculateCost } from '../src/index.js';
import type { CostingEngineInput } from '../src/index.js';
import { CostingError } from '../src/index.js';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const BASE_INPUT: CostingEngineInput = {
  materialRatePerKg: 85,
  materialGradeCode: 'MS',
  weightKg: 1.2,
  scrapRatePercent: 5,
  processes: [
    { processCode: 'TURNING', processName: 'Turning', ratePerHour: 450, cycleTimeSeconds: 60 },
    { processCode: 'MILLING', processName: 'Milling', ratePerHour: 300, cycleTimeSeconds: 30 },
  ],
  overheadRatePercent: 25,
  setupCostTotal: 50000,
  annualVolumes: [{ volume: 10000, tierLabel: 'Standard' }],
  packagingCostPerPiece: 2,
  freightCostPerPiece: 1.5,
  targetMarginPercent: 15,
  gstRatePercent: 18,
  approvalThreshold: 200,
};

// ---------------------------------------------------------------------------
// Test 1: Worked example — verify every intermediate value and final result
// ---------------------------------------------------------------------------
describe('Test 1: Worked example with known expected values', () => {
  it('calculates materialCostPerPiece correctly', () => {
    // 85 * 1.2 * (1 + 5/100) = 85 * 1.2 * 1.05 = 107.1
    const result = calculateCost(BASE_INPUT);
    const tier = result.volumeTiers[0];
    expect(tier.materialCostPerPiece).toBeCloseTo(107.1, 4);
  });

  it('calculates conversionCostPerPiece correctly', () => {
    // 450 * 60/3600 + 300 * 30/3600 = 7.5 + 2.5 = 10
    const result = calculateCost(BASE_INPUT);
    const tier = result.volumeTiers[0];
    expect(tier.conversionCostPerPiece).toBeCloseTo(10, 4);
  });

  it('calculates overheadCostPerPiece correctly', () => {
    // 10 * 25/100 = 2.5
    const result = calculateCost(BASE_INPUT);
    const tier = result.volumeTiers[0];
    expect(tier.overheadCostPerPiece).toBeCloseTo(2.5, 4);
  });

  it('calculates setupCostPerPiece correctly', () => {
    // 50000 / 10000 = 5
    const result = calculateCost(BASE_INPUT);
    const tier = result.volumeTiers[0];
    expect(tier.setupCostPerPiece).toBeCloseTo(5, 4);
  });

  it('calculates totalManufacturingCost correctly', () => {
    // 107.1 + 10 + 2.5 + 5 = 124.6
    const result = calculateCost(BASE_INPUT);
    const tier = result.volumeTiers[0];
    expect(tier.totalManufacturingCost).toBeCloseTo(124.6, 4);
  });

  it('calculates totalCostPerPiece correctly', () => {
    // 124.6 + 2 + 1.5 = 128.1
    const result = calculateCost(BASE_INPUT);
    const tier = result.volumeTiers[0];
    expect(tier.totalCostPerPiece).toBeCloseTo(128.1, 4);
  });

  it('calculates sellingPricePerPiece correctly', () => {
    // 128.1 / (1 - 0.15) = 128.1 / 0.85 = 150.70588...
    const result = calculateCost(BASE_INPUT);
    const tier = result.volumeTiers[0];
    expect(tier.sellingPricePerPiece).toBeCloseTo(150.7059, 4);
  });

  it('calculates gstAmount correctly', () => {
    // 150.70588... * 0.18 = 27.12706...
    const result = calculateCost(BASE_INPUT);
    const tier = result.volumeTiers[0];
    const expectedGst = 150.705882 * 0.18;
    expect(tier.gstAmount).toBeCloseTo(expectedGst, 4);
  });

  it('calculates annualValue correctly', () => {
    // 150.70588... * 10000 = 1507058.8...
    const result = calculateCost(BASE_INPUT);
    const tier = result.volumeTiers[0];
    expect(tier.annualValue).toBeCloseTo(150.705882 * 10000, 2);
  });

  it('returns correct totalAnnualValue (sum of all tiers)', () => {
    const result = calculateCost(BASE_INPUT);
    const sumTiers = result.volumeTiers.reduce((acc, t) => acc + t.annualValue, 0);
    expect(result.totalAnnualValue).toBeCloseTo(sumTiers, 4);
  });

  it('preserves tier label in output', () => {
    const result = calculateCost(BASE_INPUT);
    expect(result.volumeTiers[0].tierLabel).toBe('Standard');
  });
});

// ---------------------------------------------------------------------------
// Test 2: Zero setup cost
// ---------------------------------------------------------------------------
describe('Test 2: Zero setup cost', () => {
  it('handles zero setupCostTotal gracefully (setupCostPerPiece = 0)', () => {
    const input: CostingEngineInput = { ...BASE_INPUT, setupCostTotal: 0 };
    const result = calculateCost(input);
    expect(result.volumeTiers[0].setupCostPerPiece).toBeCloseTo(0, 4);
  });

  it('calculates totalManufacturingCost correctly with zero setup', () => {
    const input: CostingEngineInput = { ...BASE_INPUT, setupCostTotal: 0 };
    const result = calculateCost(input);
    const tier = result.volumeTiers[0];
    // 107.1 + 10 + 2.5 + 0 = 119.6
    expect(tier.totalManufacturingCost).toBeCloseTo(119.6, 4);
  });
});

// ---------------------------------------------------------------------------
// Test 3: Multiple volume tiers
// ---------------------------------------------------------------------------
describe('Test 3: Multiple volume tiers', () => {
  const multiTierInput: CostingEngineInput = {
    ...BASE_INPUT,
    annualVolumes: [
      { volume: 1000, tierLabel: 'Low' },
      { volume: 10000, tierLabel: 'Medium' },
      { volume: 50000, tierLabel: 'High' },
    ],
  };

  it('returns a result for each volume tier', () => {
    const result = calculateCost(multiTierInput);
    expect(result.volumeTiers).toHaveLength(3);
  });

  it('setupCostPerPiece is higher for lower volume tiers', () => {
    const result = calculateCost(multiTierInput);
    const low = result.volumeTiers[0].setupCostPerPiece;    // 50000/1000  = 50
    const med = result.volumeTiers[1].setupCostPerPiece;    // 50000/10000 = 5
    const high = result.volumeTiers[2].setupCostPerPiece;   // 50000/50000 = 1
    expect(low).toBeCloseTo(50, 4);
    expect(med).toBeCloseTo(5, 4);
    expect(high).toBeCloseTo(1, 4);
    expect(low).toBeGreaterThan(med);
    expect(med).toBeGreaterThan(high);
  });

  it('totalCostPerPiece decreases as volume increases (due to lower setup amortization)', () => {
    const result = calculateCost(multiTierInput);
    const costs = result.volumeTiers.map((t) => t.totalCostPerPiece);
    expect(costs[0]).toBeGreaterThan(costs[1]);
    expect(costs[1]).toBeGreaterThan(costs[2]);
  });

  it('totalAnnualValue equals sum of all tier annual values', () => {
    const result = calculateCost(multiTierInput);
    const sum = result.volumeTiers.reduce((acc, t) => acc + t.annualValue, 0);
    expect(result.totalAnnualValue).toBeCloseTo(sum, 4);
  });

  it('each tier has correct volume field', () => {
    const result = calculateCost(multiTierInput);
    expect(result.volumeTiers[0].volume).toBe(1000);
    expect(result.volumeTiers[1].volume).toBe(10000);
    expect(result.volumeTiers[2].volume).toBe(50000);
  });
});

// ---------------------------------------------------------------------------
// Test 4: Missing / zero material rate throws structured error
// ---------------------------------------------------------------------------
describe('Test 4: Missing or zero material rate throws structured CostingError', () => {
  it('throws CostingError with code MISSING_RATE when materialRatePerKg is 0', () => {
    const input: CostingEngineInput = { ...BASE_INPUT, materialRatePerKg: 0 };
    expect(() => calculateCost(input)).toThrow(CostingError);
    try {
      calculateCost(input);
    } catch (e) {
      expect(e).toBeInstanceOf(CostingError);
      expect((e as CostingError).code).toBe('MISSING_RATE');
    }
  });

  it('throws CostingError with code MISSING_RATE when materialRatePerKg is negative', () => {
    const input: CostingEngineInput = { ...BASE_INPUT, materialRatePerKg: -10 };
    expect(() => calculateCost(input)).toThrow(CostingError);
    try {
      calculateCost(input);
    } catch (e) {
      expect((e as CostingError).code).toBe('MISSING_RATE');
    }
  });

  it('throws CostingError with code MISSING_RATE when a process ratePerHour is 0', () => {
    const input: CostingEngineInput = {
      ...BASE_INPUT,
      processes: [
        { processCode: 'TURNING', processName: 'Turning', ratePerHour: 0, cycleTimeSeconds: 60 },
      ],
    };
    expect(() => calculateCost(input)).toThrow(CostingError);
    try {
      calculateCost(input);
    } catch (e) {
      expect((e as CostingError).code).toBe('MISSING_RATE');
    }
  });
});

// ---------------------------------------------------------------------------
// Test 5: Zero volume throws error
// ---------------------------------------------------------------------------
describe('Test 5: Zero volume throws CostingError', () => {
  it('throws CostingError with code INVALID_VOLUME when volume is 0', () => {
    const input: CostingEngineInput = {
      ...BASE_INPUT,
      annualVolumes: [{ volume: 0, tierLabel: 'Zero' }],
    };
    expect(() => calculateCost(input)).toThrow(CostingError);
    try {
      calculateCost(input);
    } catch (e) {
      expect(e).toBeInstanceOf(CostingError);
      expect((e as CostingError).code).toBe('INVALID_VOLUME');
    }
  });

  it('throws CostingError when annualVolumes array is empty', () => {
    const input: CostingEngineInput = { ...BASE_INPUT, annualVolumes: [] };
    expect(() => calculateCost(input)).toThrow(CostingError);
    try {
      calculateCost(input);
    } catch (e) {
      expect(e).toBeInstanceOf(CostingError);
      expect((e as CostingError).code).toBe('INVALID_VOLUME');
    }
  });
});

// ---------------------------------------------------------------------------
// Test 6: Negative volume throws error
// ---------------------------------------------------------------------------
describe('Test 6: Negative volume throws CostingError', () => {
  it('throws CostingError with code INVALID_VOLUME when volume is negative', () => {
    const input: CostingEngineInput = {
      ...BASE_INPUT,
      annualVolumes: [{ volume: -500, tierLabel: 'Negative' }],
    };
    expect(() => calculateCost(input)).toThrow(CostingError);
    try {
      calculateCost(input);
    } catch (e) {
      expect(e).toBeInstanceOf(CostingError);
      expect((e as CostingError).code).toBe('INVALID_VOLUME');
    }
  });

  it('throws for mixed valid and negative volumes', () => {
    const input: CostingEngineInput = {
      ...BASE_INPUT,
      annualVolumes: [
        { volume: 1000, tierLabel: 'Valid' },
        { volume: -100, tierLabel: 'Invalid' },
      ],
    };
    expect(() => calculateCost(input)).toThrow(CostingError);
  });
});

// ---------------------------------------------------------------------------
// Test 7: Decimal precision
// ---------------------------------------------------------------------------
describe('Test 7: Decimal precision — results correct to 4 decimal places', () => {
  it('handles non-integer rates and weights without floating point drift', () => {
    // Using a rate that would cause classic JS floating-point issues
    const input: CostingEngineInput = {
      ...BASE_INPUT,
      materialRatePerKg: 185.75,
      weightKg: 0.333,
      scrapRatePercent: 7.5,
    };
    const result = calculateCost(input);
    const tier = result.volumeTiers[0];

    // Expected: 185.75 * 0.333 * 1.075 = 185.75 * 0.333 * 1.075
    const expected = 185.75 * 0.333 * 1.075;
    expect(tier.materialCostPerPiece).toBeCloseTo(expected, 4);
  });

  it('handles 1/3 cycle time without infinite precision loss', () => {
    // 1 hour = 3600 sec; 1200 sec = 1/3 hour → rate * 1/3
    const input: CostingEngineInput = {
      ...BASE_INPUT,
      processes: [
        { processCode: 'TURNING', processName: 'Turning', ratePerHour: 450, cycleTimeSeconds: 1200 },
      ],
    };
    const result = calculateCost(input);
    // 450 * 1200/3600 = 450 * 1/3 = 150
    expect(result.volumeTiers[0].conversionCostPerPiece).toBeCloseTo(150, 4);
  });

  it('sellingPrice is computed with >= 4 decimal place precision', () => {
    const result = calculateCost(BASE_INPUT);
    const tier = result.volumeTiers[0];
    // 128.1 / 0.85 = 150.70588235294...
    // The 4th decimal place is 5 (150.7059)
    const diff = Math.abs(tier.sellingPricePerPiece - 150.70588235294117);
    expect(diff).toBeLessThan(0.0001);
  });
});

// ---------------------------------------------------------------------------
// Test 8: Approval threshold exceeded
// ---------------------------------------------------------------------------
describe('Test 8: Approval threshold — exceeded', () => {
  it('sets requiresApproval=true when any tier totalCostPerPiece > approvalThreshold', () => {
    // BASE_INPUT totalCostPerPiece = 128.1, threshold = 200 → NOT exceeded
    // Set a low threshold so it IS exceeded
    const input: CostingEngineInput = { ...BASE_INPUT, approvalThreshold: 100 };
    const result = calculateCost(input);
    expect(result.requiresApproval).toBe(true);
  });

  it('reports the approvalThreshold in output', () => {
    const input: CostingEngineInput = { ...BASE_INPUT, approvalThreshold: 100 };
    const result = calculateCost(input);
    expect(result.approvalThreshold).toBe(100);
  });

  it('requires approval when high-volume tier has high total cost', () => {
    // Low volume means high setup amortization → higher cost per piece
    const input: CostingEngineInput = {
      ...BASE_INPUT,
      setupCostTotal: 1_000_000,
      annualVolumes: [{ volume: 100, tierLabel: 'VeryLow' }],
      approvalThreshold: 500,
    };
    const result = calculateCost(input);
    // setupCostPerPiece = 1,000,000 / 100 = 10,000 → totalCostPerPiece >> 500
    expect(result.requiresApproval).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Test 9: Approval threshold NOT exceeded
// ---------------------------------------------------------------------------
describe('Test 9: Approval threshold — not exceeded', () => {
  it('sets requiresApproval=false when all tiers totalCostPerPiece <= approvalThreshold', () => {
    // BASE_INPUT totalCostPerPiece = 128.1, threshold = 200 → NOT exceeded
    const result = calculateCost(BASE_INPUT);
    expect(result.requiresApproval).toBe(false);
  });

  it('sets requiresApproval=false when approvalThreshold is not provided', () => {
    const input: CostingEngineInput = { ...BASE_INPUT, approvalThreshold: undefined };
    const result = calculateCost(input);
    expect(result.requiresApproval).toBe(false);
  });

  it('sets requiresApproval=false when totalCostPerPiece exactly equals threshold', () => {
    // totalCostPerPiece = 128.1; threshold = 128.1 → boundary: NOT exceeded (> not >=)
    const input: CostingEngineInput = { ...BASE_INPUT, approvalThreshold: 128.1 };
    const result = calculateCost(input);
    expect(result.requiresApproval).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Test 10: No margin provided — sellingPrice equals totalCostPerPiece
// ---------------------------------------------------------------------------
describe('Test 10: No margin — sellingPrice equals totalCostPerPiece', () => {
  it('sets sellingPricePerPiece = totalCostPerPiece when targetMarginPercent is undefined', () => {
    const input: CostingEngineInput = { ...BASE_INPUT, targetMarginPercent: undefined };
    const result = calculateCost(input);
    const tier = result.volumeTiers[0];
    expect(tier.sellingPricePerPiece).toBeCloseTo(tier.totalCostPerPiece, 4);
  });

  it('sets sellingPricePerPiece = totalCostPerPiece when targetMarginPercent is 0', () => {
    const input: CostingEngineInput = { ...BASE_INPUT, targetMarginPercent: 0 };
    const result = calculateCost(input);
    const tier = result.volumeTiers[0];
    expect(tier.sellingPricePerPiece).toBeCloseTo(tier.totalCostPerPiece, 4);
  });
});

// ---------------------------------------------------------------------------
// Test 11: GST at 0% and 28%
// ---------------------------------------------------------------------------
describe('Test 11: GST edge cases', () => {
  it('gstAmount is 0 when gstRatePercent is 0', () => {
    const input: CostingEngineInput = { ...BASE_INPUT, gstRatePercent: 0 };
    const result = calculateCost(input);
    expect(result.volumeTiers[0].gstAmount).toBeCloseTo(0, 4);
  });

  it('calculates gstAmount correctly at 28%', () => {
    const input: CostingEngineInput = { ...BASE_INPUT, gstRatePercent: 28 };
    const result = calculateCost(input);
    const tier = result.volumeTiers[0];
    const expectedGst = tier.sellingPricePerPiece * 0.28;
    expect(tier.gstAmount).toBeCloseTo(expectedGst, 4);
  });
});

// ---------------------------------------------------------------------------
// Test 12: Single process
// ---------------------------------------------------------------------------
describe('Test 12: Single process input', () => {
  it('calculates conversionCost for a single process correctly', () => {
    const input: CostingEngineInput = {
      ...BASE_INPUT,
      processes: [
        { processCode: 'TURNING', processName: 'Turning', ratePerHour: 600, cycleTimeSeconds: 120 },
      ],
    };
    const result = calculateCost(input);
    // 600 * 120/3600 = 600 * 1/30 = 20
    expect(result.volumeTiers[0].conversionCostPerPiece).toBeCloseTo(20, 4);
  });
});

// ---------------------------------------------------------------------------
// Test 13: annualValue is sellingPricePerPiece * volume per tier
// ---------------------------------------------------------------------------
describe('Test 13: annualValue per tier', () => {
  it('annualValue = sellingPricePerPiece * volume for each tier', () => {
    const input: CostingEngineInput = {
      ...BASE_INPUT,
      annualVolumes: [
        { volume: 500, tierLabel: 'T1' },
        { volume: 2000, tierLabel: 'T2' },
      ],
    };
    const result = calculateCost(input);
    for (const tier of result.volumeTiers) {
      const expected = tier.sellingPricePerPiece * tier.volume;
      expect(tier.annualValue).toBeCloseTo(expected, 4);
    }
  });
});
