import { describe, it, expect } from 'vitest';
import { CostingError, calculateCosting, validateCostingInput } from '../src';
import type { CostingErrorCode } from '../src';
import { REFERENCE_INPUT, withInput } from './fixtures';

/** Asserts that `fn` throws a structured CostingError containing (code, field). */
function expectIssue(fn: () => unknown, code: CostingErrorCode, field: string) {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught, `expected a CostingError for ${field}`).toBeInstanceOf(CostingError);
  const err = caught as CostingError;
  expect(err.issues).toContainEqual(expect.objectContaining({ code, field }));
}

const op = (patch: Record<string, unknown> = {}) => ({
  operationName: 'Turning',
  machine: 'CNC Turning',
  cycleTimeMinutes: 3.2,
  machineHourRate: 850,
  ...patch,
});

describe('Valid input is accepted unchanged', () => {
  it('the reference input validates', () => {
    expect(() => validateCostingInput(REFERENCE_INPUT)).not.toThrow();
  });

  it('explicit zeros are valid (zero setup, zero scrap, zero margin, zero GST, zero packing)', () => {
    const input = withInput(REFERENCE_INPUT, {
      setupCostPerPart: 0,
      scrapPct: 0,
      defaultMarginPct: 0,
      gstPct: 0,
      packingFreightPerPiece: 0,
    });
    expect(() => validateCostingInput(input)).not.toThrow();
  });
});

describe('Weight', () => {
  it('rejects negative weight', () => {
    expectIssue(() => calculateCosting(withInput(REFERENCE_INPUT, { grossWeightKg: -0.5 })), 'INVALID_INPUT', 'grossWeightKg');
  });
  it('rejects zero weight (would silently produce zero material cost)', () => {
    expectIssue(() => calculateCosting(withInput(REFERENCE_INPUT, { grossWeightKg: 0 })), 'INVALID_INPUT', 'grossWeightKg');
  });
  it('rejects missing weight', () => {
    expectIssue(() => calculateCosting(withInput(REFERENCE_INPUT, { grossWeightKg: undefined })), 'INVALID_INPUT', 'grossWeightKg');
  });
});

describe('Rates: negative and missing', () => {
  it('rejects negative material rate', () => {
    expectIssue(() => calculateCosting(withInput(REFERENCE_INPUT, { materialRatePerKg: -1 })), 'INVALID_INPUT', 'materialRatePerKg');
  });
  it.each([undefined, null, ''])('reports a missing material rate (%j) as MISSING_RATE', (missing) => {
    expectIssue(() => calculateCosting(withInput(REFERENCE_INPUT, { materialRatePerKg: missing })), 'MISSING_RATE', 'materialRatePerKg');
  });
  it('rejects negative machine rate, naming the operation index', () => {
    const input = withInput(REFERENCE_INPUT, { routingOperations: [op(), op({ machineHourRate: -5 })] });
    expectIssue(() => calculateCosting(input), 'INVALID_INPUT', 'routingOperations[1].machineHourRate');
  });
  it('reports a missing machine rate as MISSING_RATE, naming the operation index', () => {
    const input = withInput(REFERENCE_INPUT, { routingOperations: [op({ machineHourRate: undefined })] });
    expectIssue(() => calculateCosting(input), 'MISSING_RATE', 'routingOperations[0].machineHourRate');
  });
  it('reports missing packing/freight, setup and GST as MISSING_RATE (never defaulted)', () => {
    expectIssue(() => calculateCosting(withInput(REFERENCE_INPUT, { packingFreightPerPiece: undefined })), 'MISSING_RATE', 'packingFreightPerPiece');
    expectIssue(() => calculateCosting(withInput(REFERENCE_INPUT, { setupCostPerPart: null })), 'MISSING_RATE', 'setupCostPerPart');
    expectIssue(() => calculateCosting(withInput(REFERENCE_INPUT, { gstPct: undefined })), 'MISSING_RATE', 'gstPct');
  });
  it('rejects negative packing/freight and negative setup', () => {
    expectIssue(() => calculateCosting(withInput(REFERENCE_INPUT, { packingFreightPerPiece: -1 })), 'INVALID_INPUT', 'packingFreightPerPiece');
    expectIssue(() => calculateCosting(withInput(REFERENCE_INPUT, { setupCostPerPart: -1 })), 'INVALID_INPUT', 'setupCostPerPart');
  });
});

describe('Routing operations', () => {
  it('rejects an empty routing', () => {
    expectIssue(() => calculateCosting(withInput(REFERENCE_INPUT, { routingOperations: [] })), 'EMPTY_ROUTING', 'routingOperations');
  });
  it('rejects a non-array routing', () => {
    expectIssue(() => calculateCosting(withInput(REFERENCE_INPUT, { routingOperations: undefined })), 'EMPTY_ROUTING', 'routingOperations');
  });
  it('rejects negative cycle time', () => {
    const input = withInput(REFERENCE_INPUT, { routingOperations: [op({ cycleTimeMinutes: -1 })] });
    expectIssue(() => calculateCosting(input), 'INVALID_INPUT', 'routingOperations[0].cycleTimeMinutes');
  });
  it('rejects a missing machine name', () => {
    const input = withInput(REFERENCE_INPUT, { routingOperations: [op({ machine: '' })] });
    expectIssue(() => calculateCosting(input), 'INVALID_INPUT', 'routingOperations[0].machine');
  });
});

describe('Percentages', () => {
  it.each([
    ['scrapPct', -1],
    ['scrapPct', 101],
    ['overheadPct', -0.01],
    ['overheadPct', 1001],
    ['defaultMarginPct', -5],
    ['defaultMarginPct', 100.5],
    ['gstPct', -18],
    ['gstPct', 101],
  ])('rejects %s = %d as INVALID_PERCENTAGE', (field, value) => {
    expectIssue(() => calculateCosting(withInput(REFERENCE_INPUT, { [field]: value })), 'INVALID_PERCENTAGE', field);
  });

  it('accepts the inclusive upper bounds (scrap 100, margin 100, GST 100, overhead 1000)', () => {
    const input = withInput(REFERENCE_INPUT, { scrapPct: 100, defaultMarginPct: 100, gstPct: 100, overheadPct: 1000 });
    expect(() => validateCostingInput(input)).not.toThrow();
  });
});

describe('Non-numeric input is never coerced to zero', () => {
  it.each([NaN, Infinity, 'abc', '12abc', {}, [], true])('rejects weight %j', (bad) => {
    expectIssue(() => calculateCosting(withInput(REFERENCE_INPUT, { grossWeightKg: bad })), 'INVALID_INPUT', 'grossWeightKg');
  });
  it('rejects NaN percentage as INVALID_PERCENTAGE', () => {
    expectIssue(() => calculateCosting(withInput(REFERENCE_INPUT, { scrapPct: NaN })), 'INVALID_PERCENTAGE', 'scrapPct');
  });
});

describe('Annual volume', () => {
  it.each([0, -1, -500, 1.5, NaN, Infinity, undefined, null, '1000'])('rejects annualVolume %j as INVALID_VOLUME', (bad) => {
    expectIssue(() => calculateCosting(withInput(REFERENCE_INPUT, { annualVolume: bad })), 'INVALID_VOLUME', 'annualVolume');
  });

  it('accepts Number.MAX_SAFE_INTEGER as annual volume', () => {
    expect(() => validateCostingInput(withInput(REFERENCE_INPUT, { annualVolume: Number.MAX_SAFE_INTEGER }))).not.toThrow();
  });

  it('rejects Number.MAX_SAFE_INTEGER + 1 as INVALID_VOLUME (unsafe integer)', () => {
    expectIssue(
      () => calculateCosting(withInput(REFERENCE_INPUT, { annualVolume: Number.MAX_SAFE_INTEGER + 1 })),
      'INVALID_VOLUME',
      'annualVolume',
    );
  });

  it('rejects fractional volume 100.5 as INVALID_VOLUME', () => {
    expectIssue(
      () => calculateCosting(withInput(REFERENCE_INPUT, { annualVolume: 100.5 })),
      'INVALID_VOLUME',
      'annualVolume',
    );
  });
});

describe('All problems are reported together', () => {
  it('collects every issue instead of stopping at the first', () => {
    const input = withInput(REFERENCE_INPUT, { grossWeightKg: -1, materialRatePerKg: undefined, gstPct: 500, annualVolume: 0 });
    let err: CostingError | undefined;
    try {
      calculateCosting(input);
    } catch (e) {
      err = e as CostingError;
    }
    expect(err).toBeInstanceOf(CostingError);
    const fields = err!.issues.map((i) => i.field).sort();
    expect(fields).toEqual(['annualVolume', 'grossWeightKg', 'gstPct', 'materialRatePerKg']);
  });
});

