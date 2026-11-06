/**
 * Approval logic.
 *
 * Rules:
 *  - The default approval threshold is ₹25,00,000 (₹2.5M).
 *  - Approval is required when the TOTAL annual value STRICTLY EXCEEDS the threshold.
 *    Exactly equal to the threshold → no approval required.
 *  - sumAnnualValues sums MoneyStrings exactly using Decimal.
 *  - evaluateApproval composes sum + requiresApproval into one decision object.
 *
 * All inputs are validated. Negative or non-finite values throw CostingError.
 */

import { D, toMoneyString } from './decimal';
import { CostingError } from './errors';
import type { ApprovalDecision, MoneyString } from './types';

/** Default approval threshold: ₹25,00,000. Stored as an unambiguous integer string. */
export const APPROVAL_THRESHOLD_INR = '2500000';

/**
 * Check whether a monetary value requires approval.
 *
 * @param value - Annual value (MoneyString or number).
 * @param threshold - Override threshold (default = APPROVAL_THRESHOLD_INR).
 * @returns true if value > threshold (strict greater-than).
 */
export function requiresApproval(
  value: MoneyString | number,
  threshold: MoneyString | number = APPROVAL_THRESHOLD_INR,
): boolean {
  // Validate value
  if (value === null || value === undefined || value === '') {
    throw new CostingError([{ code: 'INVALID_INPUT', field: 'value', message: 'value is required' }]);
  }
  let dValue: ReturnType<typeof D.prototype.plus> | null = null;
  try {
    dValue = new D(value as number | string);
  } catch {
    // fall through to null check
  }
  if (dValue === null || !dValue.isFinite() || dValue.isNegative()) {
    throw new CostingError([{
      code: 'INVALID_INPUT',
      field: 'value',
      message: `value must be a non-negative finite number, got ${JSON.stringify(value)}`,
    }]);
  }

  // Validate threshold
  let dThreshold: ReturnType<typeof D.prototype.plus> | null = null;
  if (threshold !== null && threshold !== undefined) {
    try {
      dThreshold = new D(threshold as number | string);
    } catch {
      // fall through
    }
  }
  if (dThreshold === null || !dThreshold.isFinite() || dThreshold.isNegative()) {
    throw new CostingError([{
      code: 'INVALID_INPUT',
      field: 'threshold',
      message: `threshold must be a non-negative finite number, got ${JSON.stringify(threshold)}`,
    }]);
  }

  // Strictly greater than (not ≥)
  return dValue.greaterThan(dThreshold);
}

/**
 * Sum an array of annual values (MoneyStrings).
 * Throws if the array is empty or contains any negative / invalid value.
 */
export function sumAnnualValues(values: (MoneyString | number)[]): MoneyString {
  if (!Array.isArray(values) || values.length === 0) {
    throw new CostingError([{
      code: 'INVALID_INPUT',
      field: 'values',
      message: 'sumAnnualValues requires at least one value',
    }]);
  }

  let total = D(0);
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    let d: ReturnType<typeof D.prototype.plus> | null = null;
    try {
      d = new D(v as number | string);
    } catch {
      // fall through
    }
    if (d === null || !d.isFinite()) {
      throw new CostingError([{
        code: 'INVALID_INPUT',
        field: `values[${i}]`,
        message: `values[${i}] must be a finite number, got ${JSON.stringify(v)}`,
      }]);
    }
    if (d.isNegative()) {
      throw new CostingError([{
        code: 'INVALID_INPUT',
        field: `values[${i}]`,
        message: `values[${i}] must be non-negative, got ${d.toString()}`,
      }]);
    }
    total = total.plus(d);
  }

  return toMoneyString(total);
}

/**
 * Evaluate whether a set of part annual values requires Sales Head approval.
 * Returns the total and the approval decision.
 */
export function evaluateApproval(
  partAnnualValues: (MoneyString | number)[],
  threshold: MoneyString | number = APPROVAL_THRESHOLD_INR,
): ApprovalDecision {
  const totalAnnualValue = sumAnnualValues(partAnnualValues);
  const needsApproval = requiresApproval(totalAnnualValue, threshold);

  let dThreshold: ReturnType<typeof D.prototype.plus>;
  try {
    dThreshold = new D(threshold as number | string);
  } catch {
    throw new CostingError([{ code: 'INVALID_INPUT', field: 'threshold', message: `Invalid threshold: ${JSON.stringify(threshold)}` }]);
  }

  return {
    totalAnnualValue,
    threshold: toMoneyString(dThreshold),
    requiresApproval: needsApproval,
  };
}
