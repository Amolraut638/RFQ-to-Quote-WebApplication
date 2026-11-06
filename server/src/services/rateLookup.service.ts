/**
 * services/rateLookup.service.ts
 *
 * Fetches the effective rate record from MongoDB for a given costing date.
 *
 * Lookup rule:
 *   "Select the latest record where effectiveFrom <= costingDate."
 *   i.e. Model.findOne({ ..., effectiveFrom: { $lte: costingDate } })
 *            .sort({ effectiveFrom: -1 })
 *
 * NEVER substitutes a default for a missing rate.
 * Returns a structured error when no applicable record is found.
 * Rejects invalid dates before hitting the database.
 *
 * These functions are ASYNC and USE Mongoose. They are intentionally
 * separate from the costing engine, which is pure and synchronous.
 */

import mongoose from 'mongoose';
import { MaterialRate, type IMaterialRate } from '../models/MaterialRate';
import { MachineRate, type IMachineRate } from '../models/MachineRate';
import { RateSetting, type IRateSetting } from '../models/RateSetting';

// ─── Error types ─────────────────────────────────────────────────────────────

export type RateLookupErrorCode =
  | 'MATERIAL_RATE_NOT_FOUND'
  | 'MACHINE_RATE_NOT_FOUND'
  | 'RATE_SETTING_NOT_FOUND'
  | 'INVALID_COSTING_DATE';

export class RateLookupError extends Error {
  public readonly code: RateLookupErrorCode;
  public readonly context: Record<string, unknown>;

  constructor(code: RateLookupErrorCode, message: string, context: Record<string, unknown> = {}) {
    super(message);
    this.name = 'RateLookupError';
    this.code = code;
    this.context = context;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Convert a Mongoose Decimal128 to a plain string suitable for passing to the
 * costing engine (which accepts DecimalInput = number | string).
 */
export function decimal128ToString(d128: mongoose.Types.Decimal128): string {
  return d128.toString();
}

/**
 * Validate that `d` is a real Date object with a valid time value.
 * Throws RateLookupError(INVALID_COSTING_DATE) for null, undefined,
 * non-Date values, and Invalid Date objects (NaN internal timestamp).
 */
function assertValidDate(d: unknown, label: string): asserts d is Date {
  if (d === null || d === undefined) {
    throw new RateLookupError(
      'INVALID_COSTING_DATE',
      `${label} is required but was ${d === null ? 'null' : 'undefined'}`,
      { [label]: d },
    );
  }
  if (!(d instanceof Date)) {
    throw new RateLookupError(
      'INVALID_COSTING_DATE',
      `${label} must be a Date instance, got ${typeof d}`,
      { [label]: d },
    );
  }
  if (isNaN(d.getTime())) {
    throw new RateLookupError(
      'INVALID_COSTING_DATE',
      `${label} is an Invalid Date (NaN timestamp)`,
      { [label]: String(d) },
    );
  }
}

// ─── Material rate ────────────────────────────────────────────────────────────

/**
 * Get the material rate (₹/kg) applicable on `costingDate`.
 *
 * @returns The rate record. The caller should use `.ratePerKg.toString()` to
 *          pass the value to the costing engine.
 * @throws  RateLookupError(INVALID_COSTING_DATE) for invalid/missing dates.
 * @throws  RateLookupError(MATERIAL_RATE_NOT_FOUND) when no record applies.
 */
export async function getMaterialRate(
  material: string,
  costingDate: Date,
): Promise<IMaterialRate> {
  assertValidDate(costingDate, 'costingDate');

  const record = await MaterialRate.findOne({
    material,
    effectiveFrom: { $lte: costingDate },
  })
    .sort({ effectiveFrom: -1 })
    .lean<IMaterialRate>();

  if (!record) {
    throw new RateLookupError(
      'MATERIAL_RATE_NOT_FOUND',
      `No material rate found for "${material}" on or before ${costingDate.toISOString()}`,
      { material, costingDate },
    );
  }

  return record;
}

// ─── Machine rate ─────────────────────────────────────────────────────────────

/**
 * Get the machine hour rate (₹/hr) applicable on `costingDate`.
 *
 * @returns The rate record. The caller should use `.hourRate.toString()` to
 *          pass the value to the costing engine.
 * @throws  RateLookupError(INVALID_COSTING_DATE) for invalid/missing dates.
 * @throws  RateLookupError(MACHINE_RATE_NOT_FOUND) when no record applies.
 */
export async function getMachineRate(
  machine: string,
  costingDate: Date,
): Promise<IMachineRate> {
  assertValidDate(costingDate, 'costingDate');

  const record = await MachineRate.findOne({
    machine,
    effectiveFrom: { $lte: costingDate },
  })
    .sort({ effectiveFrom: -1 })
    .lean<IMachineRate>();

  if (!record) {
    throw new RateLookupError(
      'MACHINE_RATE_NOT_FOUND',
      `No machine rate found for "${machine}" on or before ${costingDate.toISOString()}`,
      { machine, costingDate },
    );
  }

  return record;
}

// ─── Rate setting ─────────────────────────────────────────────────────────────

/**
 * Get the global rate setting (scrap, overhead, packing, margin, GST, setup)
 * applicable on `costingDate`.
 *
 * @returns The rate setting document.
 * @throws  RateLookupError(INVALID_COSTING_DATE) for invalid/missing dates.
 * @throws  RateLookupError(RATE_SETTING_NOT_FOUND) when no record applies.
 */
export async function getRateSetting(costingDate: Date): Promise<IRateSetting> {
  assertValidDate(costingDate, 'costingDate');

  const record = await RateSetting.findOne({
    effectiveFrom: { $lte: costingDate },
  })
    .sort({ effectiveFrom: -1 })
    .lean<IRateSetting>();

  if (!record) {
    throw new RateLookupError(
      'RATE_SETTING_NOT_FOUND',
      `No rate setting found on or before ${costingDate.toISOString()}`,
      { costingDate },
    );
  }

  return record;
}
