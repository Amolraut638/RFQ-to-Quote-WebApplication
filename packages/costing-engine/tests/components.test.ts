import { describe, it, expect } from 'vitest';
import { calculateCostComponents, validateCostingInput } from '../src';
import type { CostingInput } from '../src';
import { REFERENCE_INPUT, SETUP_INPUT, withInput } from './fixtures';

const components = (input: CostingInput) => calculateCostComponents(validateCostingInput(input));

describe('Material cost', () => {
  it('= gross weight × material rate (0.61 × 70 = 42.70)', () => {
    expect(components(REFERENCE_INPUT).materialCost.toString()).toBe('42.7');
  });

  it('is exact in decimal arithmetic where JS floats drift (0.1 × 0.2 = 0.02)', () => {
    expect(0.1 * 0.2).not.toBe(0.02); // documents why we never use floats
    const c = components(withInput(REFERENCE_INPUT, { grossWeightKg: 0.1, materialRatePerKg: 0.2 }));
    expect(c.materialCost.toString()).toBe('0.02');
  });
});

describe('Scrap cost', () => {
  it('= material cost × scrap % (42.70 × 4% = 1.708)', () => {
    expect(components(REFERENCE_INPUT).scrapCost.toString()).toBe('1.708');
  });

  it('is zero when scrap % is zero (explicit zero, not a default)', () => {
    expect(components(withInput(REFERENCE_INPUT, { scrapPct: 0 })).scrapCost.toString()).toBe('0');
  });
});

describe('Conversion cost', () => {
  it('= cycle time / 60 × machine hour rate (3.2 min @ ₹850 = 45.3333…)', () => {
    const c = components(REFERENCE_INPUT);
    expect(c.conversionCost.toDecimalPlaces(10).toString()).toBe('45.3333333333');
  });

  it('sums any number of routing operations', () => {
    const c = components(
      withInput(REFERENCE_INPUT, {
        routingOperations: [
          { operationName: 'Turning', machine: 'CNC Turning', cycleTimeMinutes: 3.2, machineHourRate: 850 },
          { operationName: 'Milling', machine: 'VMC', cycleTimeMinutes: 1.5, machineHourRate: 1600 }, // 40
          { operationName: 'Grinding', machine: 'Grinder', cycleTimeMinutes: 0.75, machineHourRate: 800 }, // 10
        ],
      })
    );
    expect(c.conversionCost.toDecimalPlaces(6).toString()).toBe('95.333333');
  });

  it('keeps full precision for 1/3-hour cycle times (20 min @ ₹100)', () => {
    const c = components(
      withInput(REFERENCE_INPUT, {
        routingOperations: [
          { operationName: 'Op', machine: 'M', cycleTimeMinutes: 20, machineHourRate: 100 },
        ],
      })
    );
    expect(c.conversionCost.toDecimalPlaces(12).toString()).toBe('33.333333333333');
  });

  it('accepts decimal strings (as carried from Decimal128)', () => {
    const c = components(
      withInput(REFERENCE_INPUT, {
        routingOperations: [
          { operationName: 'Op', machine: 'M', cycleTimeMinutes: '3.2', machineHourRate: '850.00' },
        ],
      })
    );
    expect(c.conversionCost.toDecimalPlaces(4).toString()).toBe('45.3333');
  });
});

describe('Overhead', () => {
  it('= (material + scrap + conversion) × overhead % (reference ≈ 7.1793)', () => {
    expect(components(REFERENCE_INPUT).overheadCost.toDecimalPlaces(4).toString()).toBe('7.1793');
  });

  it('excludes packing/freight and setup from the overhead basis', () => {
    const low = components(withInput(SETUP_INPUT, { packingFreightPerPiece: 0, setupCostPerPart: 0 }));
    const high = components(withInput(SETUP_INPUT, { packingFreightPerPiece: 999, setupCostPerPart: 777777 }));
    // (102 + 5.1 + 10) × 25% = 29.275 in both cases
    expect(low.overheadCost.toString()).toBe('29.275');
    expect(high.overheadCost.toString()).toBe('29.275');
  });
});

describe('Packing/freight and base manufacturing cost', () => {
  it('passes packing/freight through unchanged', () => {
    expect(components(REFERENCE_INPUT).packingFreight.toString()).toBe('2.5');
  });

  it('base manufacturing = material + scrap + conversion + overhead (excludes packing & setup)', () => {
    // SETUP_INPUT: 102 + 5.1 + 10 + 29.275 = 146.375
    expect(components(SETUP_INPUT).baseManufacturingCost.toString()).toBe('146.375');
  });
});

