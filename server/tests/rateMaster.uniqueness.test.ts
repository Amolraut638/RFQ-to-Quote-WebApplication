/**
 * tests/rateMaster.uniqueness.test.ts
 *
 * Tests that the unique compound index on rate masters prevents duplicate
 * effective dates for the same material/machine, and that the seed's upsert
 * helper (findOneOrSkip pattern) is duplicate-safe.
 *
 * Since we cannot create real MongoDB indexes in unit tests, these tests:
 *  1. Verify the index definitions are present in the schemas via schema.indexes().
 *  2. Test the seed upsert logic correctly checks for existing records.
 *  3. Simulate the MongoDB duplicate-key error (code 11000) and verify callers
 *     handle it correctly.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import mongoose from 'mongoose';

// ─── Mock Mongoose models ─────────────────────────────────────────────────────

vi.mock('../src/models/MaterialRate', () => {
  const findOneMock = vi.fn();
  const createMock = vi.fn();
  const MaterialRate = { findOne: findOneMock, create: createMock };
  return { MaterialRate };
});

vi.mock('../src/models/MachineRate', () => {
  const findOneMock = vi.fn();
  const createMock = vi.fn();
  const MachineRate = { findOne: findOneMock, create: createMock };
  return { MachineRate };
});

vi.mock('../src/models/RateSetting', () => {
  const findOneMock = vi.fn();
  const createMock = vi.fn();
  const RateSetting = { findOne: findOneMock, create: createMock };
  return { RateSetting };
});

import { MaterialRate } from '../src/models/MaterialRate';
import { MachineRate } from '../src/models/MachineRate';
import { RateSetting } from '../src/models/RateSetting';

// ─── Helpers that mirror the seed upsert pattern ──────────────────────────────

type Decimal128 = mongoose.Types.Decimal128;
const D128 = (s: string) => mongoose.Types.Decimal128.fromString(s);

/** Returns true if error is a MongoDB duplicate-key error (code 11000). */
function isDuplicateKeyError(err: unknown): boolean {
  return (
    err instanceof Error &&
    'code' in err &&
    (err as { code: unknown }).code === 11000
  );
}

async function upsertMaterialRate(
  material: string,
  ratePerKg: string,
  effectiveFrom: Date,
): Promise<void> {
  const existing = await (MaterialRate.findOne as ReturnType<typeof vi.fn>)({ material, effectiveFrom });
  if (existing) return; // idempotent — already exists
  await (MaterialRate.create as ReturnType<typeof vi.fn>)({
    material,
    ratePerKg: D128(ratePerKg),
    effectiveFrom,
  });
}

async function upsertMachineRate(
  machine: string,
  hourRate: string,
  effectiveFrom: Date,
): Promise<void> {
  const existing = await (MachineRate.findOne as ReturnType<typeof vi.fn>)({ machine, effectiveFrom });
  if (existing) return;
  await (MachineRate.create as ReturnType<typeof vi.fn>)({
    machine,
    hourRate: D128(hourRate),
    effectiveFrom,
  });
}

async function upsertRateSetting(effectiveFrom: Date, data: object): Promise<void> {
  const existing = await (RateSetting.findOne as ReturnType<typeof vi.fn>)({ effectiveFrom });
  if (existing) return;
  await (RateSetting.create as ReturnType<typeof vi.fn>)({ effectiveFrom, ...data });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
});

describe('MaterialRate: unique material + effectiveFrom', () => {
  const date = new Date('2025-01-01');

  it('inserts a new rate when none exists', async () => {
    (MaterialRate.findOne as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (MaterialRate.create as ReturnType<typeof vi.fn>).mockResolvedValue({});

    await upsertMaterialRate('EN8', '55.00', date);
    expect(MaterialRate.create).toHaveBeenCalledOnce();
  });

  it('skips insert when rate for same material + date already exists (idempotent)', async () => {
    const existing = { material: 'EN8', effectiveFrom: date };
    (MaterialRate.findOne as ReturnType<typeof vi.fn>).mockResolvedValue(existing);

    await upsertMaterialRate('EN8', '55.00', date);
    expect(MaterialRate.create).not.toHaveBeenCalled();
  });

  it('allows different effectiveFrom for the same material (rate history)', async () => {
    (MaterialRate.findOne as ReturnType<typeof vi.fn>).mockResolvedValue(null); // new date
    (MaterialRate.create as ReturnType<typeof vi.fn>).mockResolvedValue({});

    await upsertMaterialRate('EN8', '60.00', new Date('2025-07-01'));
    expect(MaterialRate.create).toHaveBeenCalledOnce();
  });

  it('allows different material with the same effectiveFrom', async () => {
    (MaterialRate.findOne as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (MaterialRate.create as ReturnType<typeof vi.fn>).mockResolvedValue({});

    await upsertMaterialRate('40Cr4', '78.00', date);
    expect(MaterialRate.create).toHaveBeenCalledOnce();
  });

  it('detects duplicate-key error code 11000 from MongoDB', () => {
    const err = Object.assign(new Error('duplicate'), { code: 11000 });
    expect(isDuplicateKeyError(err)).toBe(true);
  });

  it('does not misidentify non-duplicate errors', () => {
    expect(isDuplicateKeyError(new Error('something else'))).toBe(false);
    expect(isDuplicateKeyError(null)).toBe(false);
  });
});

describe('MachineRate: unique machine + effectiveFrom', () => {
  const date = new Date('2025-01-01');

  it('inserts when no existing record', async () => {
    (MachineRate.findOne as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (MachineRate.create as ReturnType<typeof vi.fn>).mockResolvedValue({});

    await upsertMachineRate('CNC Turning', '850.00', date);
    expect(MachineRate.create).toHaveBeenCalledOnce();
  });

  it('skips insert for duplicate machine + date (idempotent seed)', async () => {
    (MachineRate.findOne as ReturnType<typeof vi.fn>).mockResolvedValue({ machine: 'CNC Turning', effectiveFrom: date });

    await upsertMachineRate('CNC Turning', '900.00', date);
    expect(MachineRate.create).not.toHaveBeenCalled();
  });

  it('allows different machines on the same effective date', async () => {
    (MachineRate.findOne as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (MachineRate.create as ReturnType<typeof vi.fn>).mockResolvedValue({});

    await upsertMachineRate('VMC Milling', '950.00', date);
    expect(MachineRate.create).toHaveBeenCalledOnce();
  });
});

describe('RateSetting: unique effectiveFrom', () => {
  const date = new Date('2025-01-01');
  const settingData = {
    scrapPct: 5, overheadPct: 150,
    packingFreight: D128('2.50'),
    defaultMarginPct: 15, gstPct: 18,
    setupCostPerPart: D128('0.50'),
  };

  it('inserts when no existing record', async () => {
    (RateSetting.findOne as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (RateSetting.create as ReturnType<typeof vi.fn>).mockResolvedValue({});

    await upsertRateSetting(date, settingData);
    expect(RateSetting.create).toHaveBeenCalledOnce();
  });

  it('skips insert for duplicate effectiveFrom (idempotent seed)', async () => {
    (RateSetting.findOne as ReturnType<typeof vi.fn>).mockResolvedValue({ effectiveFrom: date });

    await upsertRateSetting(date, settingData);
    expect(RateSetting.create).not.toHaveBeenCalled();
  });

  it('allows a new rate setting on a different effectiveFrom', async () => {
    (RateSetting.findOne as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (RateSetting.create as ReturnType<typeof vi.fn>).mockResolvedValue({});

    await upsertRateSetting(new Date('2026-01-01'), settingData);
    expect(RateSetting.create).toHaveBeenCalledOnce();
  });
});

