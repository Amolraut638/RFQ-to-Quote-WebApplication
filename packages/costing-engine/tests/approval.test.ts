import { describe, it, expect } from 'vitest';
import { CostingError, APPROVAL_THRESHOLD_INR, requiresApproval, sumAnnualValues, evaluateApproval } from '../src';

describe('Approval threshold constant', () => {
  it('is ₹25,00,000', () => {
    expect(APPROVAL_THRESHOLD_INR).toBe('2500000');
  });
});

describe('requiresApproval: annual value strictly greater than ₹25,00,000', () => {
  it('exactly ₹25,00,000 does NOT trigger approval', () => {
    expect(requiresApproval('2500000')).toBe(false);
    expect(requiresApproval(2500000)).toBe(false);
    expect(requiresApproval('2500000.00')).toBe(false);
  });

  it('one paisa above the threshold triggers approval', () => {
    expect(requiresApproval('2500000.01')).toBe(true);
  });

  it('one paisa below the threshold does not', () => {
    expect(requiresApproval('2499999.99')).toBe(false);
  });

  it('clearly above / clearly below', () => {
    expect(requiresApproval('20043000.00')).toBe(true);
    expect(requiresApproval('1000.00')).toBe(false);
    expect(requiresApproval(0)).toBe(false);
  });

  it('supports an explicit threshold override', () => {
    expect(requiresApproval('100.01', '100')).toBe(true);
    expect(requiresApproval('100', '100')).toBe(false);
  });

  it('is a pure function (same input, same output)', () => {
    expect(requiresApproval('2500000.01')).toBe(requiresApproval('2500000.01'));
  });

  it.each([-1, '-5', NaN, Infinity, 'abc', undefined, null, ''])('rejects invalid value %j', (bad) => {
    expect(() => requiresApproval(bad as never)).toThrow(CostingError);
  });

  it('rejects an invalid threshold', () => {
    expect(() => requiresApproval(100, -1)).toThrow(CostingError);
    expect(() => requiresApproval(100, 'abc')).toThrow(CostingError);
  });
});

describe('sumAnnualValues: RFQ total across parts', () => {
  it('sums decimal strings exactly', () => {
    expect(sumAnnualValues(['1000000.50', '1500000.00'])).toBe('2500000.50');
  });

  it('has no floating-point drift (0.1 + 0.2 = 0.30)', () => {
    expect(sumAnnualValues(['0.1', '0.2'])).toBe('0.30');
  });

  it('a single part is its own total', () => {
    expect(sumAnnualValues(['20043000.00'])).toBe('20043000.00');
  });

  it('rejects an empty list (a quotation with no parts has no value)', () => {
    expect(() => sumAnnualValues([])).toThrow(CostingError);
  });

  it('rejects a negative or invalid part value', () => {
    expect(() => sumAnnualValues(['100', '-1'])).toThrow(CostingError);
    expect(() => sumAnnualValues(['100', 'x'])).toThrow(CostingError);
  });
});

describe('evaluateApproval: total + decision', () => {
  it('RFQ total exactly ₹25,00,000 → no approval', () => {
    expect(evaluateApproval(['1000000', '1500000'])).toEqual({
      totalAnnualValue: '2500000.00',
      threshold: '2500000.00',
      requiresApproval: false,
    });
  });

  it('RFQ total above threshold only because parts are summed → approval', () => {
    // each part is below ₹25L on its own; together they exceed it
    const d = evaluateApproval(['1500000.00', '1000000.01']);
    expect(d.totalAnnualValue).toBe('2500000.01');
    expect(d.requiresApproval).toBe(true);
  });

  it('below-threshold quotation → no approval', () => {
    expect(evaluateApproval(['1000000', '1499999.99']).requiresApproval).toBe(false);
  });
});

