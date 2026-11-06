/**
 * Input validation for the costing engine.
 *
 * Rules:
 *  - Validation is EXHAUSTIVE: all issues are collected before throwing.
 *  - Missing / null / undefined fields → MISSING_RATE.
 *  - Non-finite / negative numeric fields → INVALID_INPUT.
 *  - Percentages out of range → INVALID_PERCENTAGE.
 *  - annualVolume not a positive integer → INVALID_VOLUME.
 *  - Empty or absent routingOperations → EMPTY_ROUTING.
 *  - The engine NEVER substitutes a default for a missing value.
 *
 * Returns ValidatedCostingInput with every field as a Decimal instance.
 */

import { D } from './decimal';
import type { Dec } from './decimal';
import { CostingError, type CostingIssue } from './errors';
import type { CostingInput, DecimalInput } from './types';

export interface ValidatedOperation {
  operationName: string;
  machine: string;
  cycleTimeMinutes: Dec;
  machineHourRate: Dec;
}

export interface ValidatedCostingInput {
  grossWeightKg: Dec;
  materialRatePerKg: Dec;
  scrapPct: Dec;
  operations: ValidatedOperation[];
  overheadPct: Dec;
  packingFreightPerPiece: Dec;
  setupCostPerPart: Dec;
  annualVolume: number;
  defaultMarginPct: Dec;
  gstPct: Dec;
}

export const PERCENT_MAX = {
  scrapPct: 100,
  overheadPct: 1000,
  defaultMarginPct: 100,
  gstPct: 100,
} as const;

/** Returns true if `v` is null, undefined, or empty string — a "missing" rate. */
function isMissing(v: unknown): boolean {
  return v === null || v === undefined || v === '';
}

/**
 * Try to convert a DecimalInput value to a Decimal.
 * Returns null if the value is non-finite, NaN, or cannot be parsed
 * (e.g. 'abc', true, {}, []).
 */
function toDecimal(v: unknown): Dec | null {
  if (isMissing(v)) return null;
  // Only accept numbers and strings
  if (typeof v !== 'number' && typeof v !== 'string') return null;
  try {
    const d = new D(v as number | string);
    if (!d.isFinite()) return null;
    return d;
  } catch {
    return null;
  }
}

/**
 * Validate a mandatory non-negative decimal field.
 * Pushes onto `issues` and returns null on failure.
 */
function validateNonNegativeDecimal(
  v: unknown,
  field: string,
  issues: CostingIssue[],
): Dec | null {
  if (isMissing(v)) {
    issues.push({ code: 'MISSING_RATE', field, message: `${field} is required but was not provided` });
    return null;
  }
  const d = toDecimal(v);
  if (d === null) {
    issues.push({ code: 'INVALID_INPUT', field, message: `${field} must be a finite number, got ${JSON.stringify(v)}` });
    return null;
  }
  if (d.isNegative()) {
    issues.push({ code: 'INVALID_INPUT', field, message: `${field} must be ≥ 0, got ${d.toString()}` });
    return null;
  }
  return d;
}

/**
 * Validate a mandatory POSITIVE decimal field (> 0).
 * Used for gross weight. Zero is explicitly rejected as it would silently
 * produce a zero material cost with no visible error.
 */
function validatePositiveDecimal(
  v: unknown,
  field: string,
  issues: CostingIssue[],
): Dec | null {
  if (isMissing(v)) {
    issues.push({ code: 'INVALID_INPUT', field, message: `${field} is required but was not provided` });
    return null;
  }
  const d = toDecimal(v);
  if (d === null) {
    issues.push({ code: 'INVALID_INPUT', field, message: `${field} must be a finite number, got ${JSON.stringify(v)}` });
    return null;
  }
  // isPositive() returns false for zero, so this catches both zero and negative
  if (d.isZero() || d.isNegative()) {
    issues.push({ code: 'INVALID_INPUT', field, message: `${field} must be > 0, got ${d.toString()}` });
    return null;
  }
  return d;
}

/**
 * Validate a mandatory rate that may be missing (null/undefined/'') but once
 * present must be non-negative.
 */
function validateRate(
  v: unknown,
  field: string,
  issues: CostingIssue[],
): Dec | null {
  if (isMissing(v)) {
    issues.push({ code: 'MISSING_RATE', field, message: `${field} is required but was not provided` });
    return null;
  }
  const d = toDecimal(v);
  if (d === null) {
    issues.push({ code: 'INVALID_INPUT', field, message: `${field} must be a finite number, got ${JSON.stringify(v)}` });
    return null;
  }
  if (d.isNegative()) {
    issues.push({ code: 'INVALID_INPUT', field, message: `${field} must be ≥ 0, got ${d.toString()}` });
    return null;
  }
  return d;
}

/**
 * Validate a percentage field.
 * Percentages may be 0; they must be in [0, max].
 */
function validatePercentage(
  v: unknown,
  field: string,
  max: number,
  issues: CostingIssue[],
): Dec | null {
  if (isMissing(v)) {
    issues.push({ code: 'MISSING_RATE', field, message: `${field} is required but was not provided` });
    return null;
  }
  const d = toDecimal(v);
  if (d === null) {
    issues.push({ code: 'INVALID_PERCENTAGE', field, message: `${field} must be a finite number, got ${JSON.stringify(v)}` });
    return null;
  }
  if (d.isNegative() || d.greaterThan(max)) {
    issues.push({
      code: 'INVALID_PERCENTAGE',
      field,
      message: `${field} must be in [0, ${max}], got ${d.toString()}`,
    });
    return null;
  }
  return d;
}

export function validateCostingInput(input: CostingInput): ValidatedCostingInput {
  const issues: CostingIssue[] = [];

  // --- grossWeightKg (must be strictly positive) ---
  const grossWeightKg = validatePositiveDecimal((input as unknown as Record<string, unknown>).grossWeightKg, 'grossWeightKg', issues);

  // --- materialRatePerKg (may be missing → MISSING_RATE; negative → INVALID_INPUT) ---
  const rawMat = (input as unknown as Record<string, unknown>).materialRatePerKg as DecimalInput | null | undefined;
  const materialRatePerKg = validateRate(rawMat, 'materialRatePerKg', issues);

  // --- scrapPct [0, 100] ---
  const scrapPct = validatePercentage((input as unknown as Record<string, unknown>).scrapPct, 'scrapPct', PERCENT_MAX.scrapPct, issues);

  // --- overheadPct [0, 1000] ---
  const overheadPct = validatePercentage((input as unknown as Record<string, unknown>).overheadPct, 'overheadPct', PERCENT_MAX.overheadPct, issues);

  // --- packingFreightPerPiece (non-negative, may be zero) ---
  const packingFreightPerPiece = validateNonNegativeDecimal((input as unknown as Record<string, unknown>).packingFreightPerPiece, 'packingFreightPerPiece', issues);

  // --- setupCostPerPart (non-negative, may be zero; missing → MISSING_RATE) ---
  const rawSetup = (input as unknown as Record<string, unknown>).setupCostPerPart;
  const setupCostPerPart = validateRate(rawSetup, 'setupCostPerPart', issues);

  // --- defaultMarginPct [0, 100] ---
  const defaultMarginPct = validatePercentage((input as unknown as Record<string, unknown>).defaultMarginPct, 'defaultMarginPct', PERCENT_MAX.defaultMarginPct, issues);

  // --- gstPct [0, 100] (missing → MISSING_RATE) ---
  const rawGst = (input as unknown as Record<string, unknown>).gstPct;
  if (isMissing(rawGst)) {
    issues.push({ code: 'MISSING_RATE', field: 'gstPct', message: 'gstPct is required but was not provided' });
  }
  const gstPct = isMissing(rawGst) ? null : validatePercentage(rawGst, 'gstPct', PERCENT_MAX.gstPct, issues);

  // --- annualVolume (must be a positive integer typeof number) ---
  const rawVolume = (input as unknown as Record<string, unknown>).annualVolume;
  let annualVolume: number | null = null;
  if (
    typeof rawVolume !== 'number' ||
    !Number.isFinite(rawVolume) ||
    !Number.isInteger(rawVolume) ||
    rawVolume <= 0
  ) {
    issues.push({ code: 'INVALID_VOLUME', field: 'annualVolume', message: `annualVolume must be a positive integer, got ${JSON.stringify(rawVolume)}` });
  } else {
    annualVolume = rawVolume;
  }

  // --- routingOperations ---
  const rawOps = (input as unknown as Record<string, unknown>).routingOperations;
  const operations: ValidatedOperation[] = [];

  if (!Array.isArray(rawOps) || rawOps.length === 0) {
    issues.push({ code: 'EMPTY_ROUTING', field: 'routingOperations', message: 'routingOperations must be a non-empty array' });
  } else {
    for (let i = 0; i < rawOps.length; i++) {
      const op = rawOps[i] as Record<string, unknown>;
      const prefix = `routingOperations[${i}]`;

      // machine name
      if (!op.machine || typeof op.machine !== 'string' || (op.machine as string).trim() === '') {
        issues.push({ code: 'INVALID_INPUT', field: `${prefix}.machine`, message: `${prefix}.machine must be a non-empty string` });
      }

      // cycleTimeMinutes (non-negative; zero would produce zero conversion cost but is technically valid)
      const cycleTime = validateNonNegativeDecimal(op.cycleTimeMinutes, `${prefix}.cycleTimeMinutes`, issues);

      // machineHourRate (may be missing → MISSING_RATE; negative → INVALID_INPUT)
      const hourRate = validateRate(op.machineHourRate, `${prefix}.machineHourRate`, issues);

      if (typeof op.machine === 'string' && op.machine.trim() !== '' && cycleTime !== null && hourRate !== null) {
        operations.push({
          operationName: typeof op.operationName === 'string' ? op.operationName : String(op.operationName ?? ''),
          machine: op.machine as string,
          cycleTimeMinutes: cycleTime,
          machineHourRate: hourRate,
        });
      }
    }
  }

  if (issues.length > 0) {
    throw new CostingError(issues);
  }

  return {
    grossWeightKg: grossWeightKg!,
    materialRatePerKg: materialRatePerKg!,
    scrapPct: scrapPct!,
    operations,
    overheadPct: overheadPct!,
    packingFreightPerPiece: packingFreightPerPiece!,
    setupCostPerPart: setupCostPerPart!,
    annualVolume: annualVolume!,
    defaultMarginPct: defaultMarginPct!,
    gstPct: gstPct!,
  };
}
