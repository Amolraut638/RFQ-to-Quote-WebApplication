import { describe, it, expect } from 'vitest';
import { calculateCosting, CostingError } from '../src';
import type { CostingInput, CostingResult } from '../src';
import { REFERENCE_INPUT, SETUP_INPUT, withInput } from './fixtures';

const MONEY = /^\d+\.\d{2}$/;

function moneyFields(result: CostingResult): string[] {
  const { breakdown, volumeTiers } = result;
  return [
    ...Object.values(breakdown),
    ...volumeTiers.flatMap((t) => [
      t.setupAllocationPerPiece,
      t.totalCostPerPiece,
      t.sellingPriceExGst,
      t.gstAmount,
      t.sellingPriceIncludingGst,
    ]),
    result.annualQuotationValue,
  ];
}

describe('Reference test: client brief worked example (Rear wheel spindle)', () => {
  const result = calculateCosting(REFERENCE_INPUT);
  const b = result.breakdown;

  it('Material = ₹42.70', () => expect(b.materialCost).toBe('42.70'));
  it('Scrap = ₹1.71 (1.708)', () => expect(b.scrapCost).toBe('1.71'));
  it('Conversion = ₹45.33', () => expect(b.conversionCost).toBe('45.33'));
  it('Overhead = ₹7.18 (7.1793)', () => expect(b.overheadCost).toBe('7.18'));
  it('Packing/freight = ₹2.50', () => expect(b.packingFreight).toBe('2.50'));
  it('Base manufacturing cost = ₹96.92', () => expect(b.baseManufacturingCost).toBe('96.92'));
  it('Setup allocation = ₹0.00 (setup is zero)', () => expect(b.setupAllocationPerPiece).toBe('0.00'));
  it('Total cost = ₹99.42', () => expect(b.totalCost).toBe('99.42'));
  it('Selling price ex GST ≈ ₹111.35 (99.4206 × 1.12 = 111.3511)', () => {
    expect(b.sellingPriceExGst).toBe('111.35');
  });
  it('GST @18% is calculated separately on the selling price (₹20.04)', () => {
    expect(b.gstAmount).toBe('20.04');
    expect(b.sellingPriceIncludingGst).toBe('131.39');
  });
  it('Annual quotation value = 111.35 × 180,000 = ₹2,00,43,000.00', () => {
    expect(result.annualQuotationValue).toBe('20043000.00');
  });
});

describe('Zero setup cost', () => {
  it('every tier has zero setup allocation and identical per-piece cost', () => {
    const { volumeTiers } = calculateCosting(REFERENCE_INPUT);
    for (const t of volumeTiers) {
      expect(t.setupAllocationPerPiece).toBe('0.00');
      expect(t.totalCostPerPiece).toBe('99.42');
      expect(t.sellingPriceExGst).toBe('111.35');
    }
  });
});

describe('Three volume tiers (non-zero setup ₹50,000, annual volume 10,000)', () => {
  const result = calculateCosting(SETUP_INPUT);
  const [low, base, high] = result.volumeTiers;

  it('returns exactly three tiers named Low / Base / High at 50 / 100 / 150 %', () => {
    expect(result.volumeTiers.map((t) => [t.tierName, t.tierPercentage])).toEqual([
      ['Low', 50],
      ['Base', 100],
      ['High', 150],
    ]);
  });

  it('tier volumes are 5,000 / 10,000 / 15,000', () => {
    expect([low.tierVolume, base.tierVolume, high.tierVolume]).toEqual([5000, 10000, 15000]);
  });

  it('setup allocation per piece = setup / tier volume (10.00 / 5.00 / 3.33)', () => {
    expect([low.setupAllocationPerPiece, base.setupAllocationPerPiece, high.setupAllocationPerPiece]).toEqual([
      '10.00',
      '5.00',
      '3.33',
    ]);
  });

  it('tier cost per piece = components + packing + setup allocation', () => {
    // 146.375 + 3.5 = 149.875 ; + 10 = 159.875 ; + 5 = 154.875 ; + 3.3333… = 153.2083…
    expect([low.totalCostPerPiece, base.totalCostPerPiece, high.totalCostPerPiece]).toEqual([
      '159.88',
      '154.88',
      '153.21',
    ]);
  });

  it('tier selling price = tier cost × (1 + 15%), same margin for all tiers', () => {
    // 159.875×1.15 = 183.85625 ; 154.875×1.15 = 178.10625 ; 153.2083…×1.15 = 176.1895…
    expect([low.sellingPriceExGst, base.sellingPriceExGst, high.sellingPriceExGst]).toEqual([
      '183.86',
      '178.11',
      '176.19',
    ]);
  });

  it('GST is separate and computed from the rounded selling price', () => {
    // 183.86×18% = 33.0948 ; 178.11×18% = 32.0598 ; 176.19×18% = 31.7142
    expect([low.gstAmount, base.gstAmount, high.gstAmount]).toEqual(['33.09', '32.06', '31.71']);
    expect([low.sellingPriceIncludingGst, base.sellingPriceIncludingGst, high.sellingPriceIncludingGst]).toEqual([
      '216.95',
      '210.17',
      '207.90',
    ]);
  });

  it('per-piece cost falls as volume rises', () => {
    expect(Number(low.totalCostPerPiece)).toBeGreaterThan(Number(base.totalCostPerPiece));
    expect(Number(base.totalCostPerPiece)).toBeGreaterThan(Number(high.totalCostPerPiece));
  });

  it('breakdown equals the 100% tier (no second copy of the formulas)', () => {
    expect(result.breakdown.totalCost).toBe(base.totalCostPerPiece);
    expect(result.breakdown.sellingPriceExGst).toBe(base.sellingPriceExGst);
    expect(result.breakdown.gstAmount).toBe(base.gstAmount);
    expect(result.breakdown.sellingPriceIncludingGst).toBe(base.sellingPriceIncludingGst);
    expect(result.breakdown.setupAllocationPerPiece).toBe(base.setupAllocationPerPiece);
  });

  it('breakdown components are rounded half-up for display (29.275 → 29.28, 146.375 → 146.38)', () => {
    expect(result.breakdown.materialCost).toBe('102.00');
    expect(result.breakdown.scrapCost).toBe('5.10');
    expect(result.breakdown.conversionCost).toBe('10.00');
    expect(result.breakdown.overheadCost).toBe('29.28');
    expect(result.breakdown.baseManufacturingCost).toBe('146.38');
  });
});

describe('Annual value uses the 100% tier only', () => {
  it('= base-tier selling price × annual volume (178.11 × 10,000)', () => {
    expect(calculateCosting(SETUP_INPUT).annualQuotationValue).toBe('1781100.00');
  });

  it('is unaffected by the 50% / 150% tiers', () => {
    const r = calculateCosting(SETUP_INPUT);
    const base = r.volumeTiers[1];
    expect(r.annualQuotationValue).toBe((Number(base.sellingPriceExGst) * 10000).toFixed(2));
  });
});

describe('Fractional tier volumes', () => {
  it('annual 101 → 50.5 → 51, 101, 151.5 → 152 (half-up, whole pieces)', () => {
    const r = calculateCosting(withInput(SETUP_INPUT, { annualVolume: 101 }));
    expect(r.volumeTiers.map((t) => t.tierVolume)).toEqual([51, 101, 152]);
  });
});

describe('Rounding policy', () => {
  const tiny: CostingInput = {
    grossWeightKg: 1,
    materialRatePerKg: '0.125',
    scrapPct: 0,
    routingOperations: [{ operationName: 'Op', machine: 'M', cycleTimeMinutes: 1, machineHourRate: 0 }],
    overheadPct: 0,
    packingFreightPerPiece: 0,
    setupCostPerPart: 0,
    annualVolume: 1000,
    defaultMarginPct: 0,
    gstPct: 0,
  };

  it('rounds half UP at 2 dp: 0.125 → 0.13 (banker\'s rounding would give 0.12)', () => {
    const r = calculateCosting(tiny);
    expect(r.breakdown.materialCost).toBe('0.13');
    expect(r.breakdown.totalCost).toBe('0.13');
  });

  it('zero margin → selling price equals cost; zero GST → GST 0.00 and inclusive = exclusive', () => {
    const r = calculateCosting(tiny);
    expect(r.breakdown.sellingPriceExGst).toBe(r.breakdown.totalCost);
    expect(r.breakdown.gstAmount).toBe('0.00');
    expect(r.breakdown.sellingPriceIncludingGst).toBe(r.breakdown.sellingPriceExGst);
  });

  it('GST at 28%: 111.35 × 28% = 31.178 → 31.18 ; inclusive 142.53', () => {
    const r = calculateCosting(withInput(REFERENCE_INPUT, { gstPct: 28 }));
    expect(r.breakdown.gstAmount).toBe('31.18');
    expect(r.breakdown.sellingPriceIncludingGst).toBe('142.53');
  });

  it('exclusive + GST always equals inclusive to the paisa (all tiers)', () => {
    for (const input of [REFERENCE_INPUT, SETUP_INPUT, withInput(SETUP_INPUT, { gstPct: 12.5, annualVolume: 777 })]) {
      for (const t of calculateCosting(input).volumeTiers) {
        const sum = (Math.round(Number(t.sellingPriceExGst) * 100) + Math.round(Number(t.gstAmount) * 100)) / 100;
        expect(t.sellingPriceIncludingGst).toBe(sum.toFixed(2));
      }
    }
  });
});

describe('Output contract', () => {
  it('every monetary output is a fixed 2-dp string, never a number or Decimal', () => {
    for (const input of [REFERENCE_INPUT, SETUP_INPUT]) {
      for (const m of moneyFields(calculateCosting(input))) {
        expect(typeof m).toBe('string');
        expect(m).toMatch(MONEY);
      }
    }
  });

  it('survives a JSON round trip unchanged (serialisable at the module boundary)', () => {
    const r = calculateCosting(SETUP_INPUT);
    expect(JSON.parse(JSON.stringify(r))).toEqual(r);
  });

  it('is deterministic and does not mutate its input', () => {
    const input = structuredClone(SETUP_INPUT);
    const frozen = JSON.stringify(input);
    const a = calculateCosting(input);
    const b = calculateCosting(input);
    expect(a).toEqual(b);
    expect(JSON.stringify(input)).toBe(frozen);
  });

  it('accepts the same values as strings or numbers with identical results', () => {
    const asStrings: CostingInput = {
      grossWeightKg: '0.61',
      materialRatePerKg: '70',
      scrapPct: '4',
      routingOperations: [{ operationName: 'Turning', machine: 'CNC Turning', cycleTimeMinutes: '3.2', machineHourRate: '850' }],
      overheadPct: '8',
      packingFreightPerPiece: '2.50',
      setupCostPerPart: '0',
      annualVolume: 180000,
      defaultMarginPct: '12',
      gstPct: '18',
    };
    expect(calculateCosting(asStrings)).toEqual(calculateCosting(REFERENCE_INPUT));
  });
});

describe('Invalid volumes never produce a result', () => {
  it.each([0, -1, -180000])('annualVolume %d is rejected with INVALID_VOLUME', (v) => {
    expect(() => calculateCosting(withInput(REFERENCE_INPUT, { annualVolume: v }))).toThrow(CostingError);
    try {
      calculateCosting(withInput(REFERENCE_INPUT, { annualVolume: v }));
    } catch (e) {
      expect((e as CostingError).code).toBe('INVALID_VOLUME');
    }
  });
});

