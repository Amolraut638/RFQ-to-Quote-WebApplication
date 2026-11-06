/**
 * tests/rateLookup.test.ts
 *
 * Unit tests for the rate lookup service.
 * Mongoose models are mocked; no database connection is required.
 *
 * Tests verify:
 *  1. Single matching rate is returned.
 *  2. Latest rate is selected when multiple historical records exist.
 *  3. A future-effective rate is excluded (effectiveFrom > costingDate).
 *  4. Exact effectiveFrom match is included (effectiveFrom == costingDate).
 *  5. Missing rate → structured RateLookupError (never a default).
 *  6. Multiple machines: each returns its own rate independently.
 *  7. Missing rate setting → structured RateLookupError.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock the Mongoose models before importing the service ────────────────────
// vitest.mock is hoisted so this runs before imports below.

vi.mock('../src/models/MaterialRate', () => {
  const findOneMock = vi.fn();
  const MaterialRate = {
    findOne: findOneMock,
  };
  return { MaterialRate };
});

vi.mock('../src/models/MachineRate', () => {
  const findOneMock = vi.fn();
  const MachineRate = {
    findOne: findOneMock,
  };
  return { MachineRate };
});

vi.mock('../src/models/RateSetting', () => {
  const findOneMock = vi.fn();
  const RateSetting = {
    findOne: findOneMock,
  };
  return { RateSetting };
});

// ─── Imports (after mocks are hoisted) ───────────────────────────────────────

import {
  getMaterialRate,
  getMachineRate,
  getRateSetting,
  RateLookupError,
} from '../src/services/rateLookup.service';
import { MaterialRate } from '../src/models/MaterialRate';
import { MachineRate } from '../src/models/MachineRate';
import { RateSetting } from '../src/models/RateSetting';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Build a fake Decimal128-like object (toString returns the string). */
function fakeDecimal128(value: string) {
  return { toString: () => value } as unknown as import('mongoose').Types.Decimal128;
}

/** Build a mock Mongoose query chain that resolves to `result`. */
function chainResolving(result: unknown) {
  const query = {
    sort: vi.fn().mockReturnThis(),
    lean: vi.fn().mockResolvedValue(result),
  };
  return query;
}

// ─── Material rate tests ──────────────────────────────────────────────────────

describe('getMaterialRate', () => {
  const costingDate = new Date('2025-01-15');

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the matching rate record', async () => {
    const fakeRate = {
      material: 'SS316L',
      ratePerKg: fakeDecimal128('350.00'),
      effectiveFrom: new Date('2025-01-01'),
    };
    (MaterialRate.findOne as ReturnType<typeof vi.fn>).mockReturnValue(chainResolving(fakeRate));

    const result = await getMaterialRate('SS316L', costingDate);
    expect(result.material).toBe('SS316L');
    expect(result.ratePerKg.toString()).toBe('350.00');
  });

  it('selects the LATEST rate when multiple historical records exist', async () => {
    // The service sends effectiveFrom: { $lte: costingDate }, sort({ effectiveFrom: -1 })
    // MongoDB returns the latest first; we simulate that by returning one record
    const latestRate = {
      material: 'EN8',
      ratePerKg: fakeDecimal128('95.50'),
      effectiveFrom: new Date('2024-12-01'), // latest applicable
    };
    (MaterialRate.findOne as ReturnType<typeof vi.fn>).mockReturnValue(chainResolving(latestRate));

    const result = await getMaterialRate('EN8', costingDate);
    expect(result.ratePerKg.toString()).toBe('95.50');

    // Verify that sort was called with effectiveFrom descending
    const mockCall = (MaterialRate.findOne as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(mockCall.sort).toHaveBeenCalledWith({ effectiveFrom: -1 });
  });

  it('excludes a future-effective rate — returns null → throws RateLookupError', async () => {
    // future-only rate; query returns null because $lte filters it out
    (MaterialRate.findOne as ReturnType<typeof vi.fn>).mockReturnValue(chainResolving(null));

    await expect(getMaterialRate('EN8', costingDate)).rejects.toBeInstanceOf(RateLookupError);
    const err = await getMaterialRate('EN8', costingDate).catch((e) => e as RateLookupError);
    expect(err.code).toBe('MATERIAL_RATE_NOT_FOUND');
  });

  it('includes a rate whose effectiveFrom exactly equals the costing date', async () => {
    const exactMatch = {
      material: 'Aluminium',
      ratePerKg: fakeDecimal128('220.00'),
      effectiveFrom: costingDate, // exact match
    };
    (MaterialRate.findOne as ReturnType<typeof vi.fn>).mockReturnValue(chainResolving(exactMatch));

    const result = await getMaterialRate('Aluminium', costingDate);
    expect(result.ratePerKg.toString()).toBe('220.00');
  });

  it('throws RateLookupError with MATERIAL_RATE_NOT_FOUND when no record applies', async () => {
    (MaterialRate.findOne as ReturnType<typeof vi.fn>).mockReturnValue(chainResolving(null));

    await expect(getMaterialRate('Unknown', costingDate)).rejects.toBeInstanceOf(RateLookupError);
  });

  it('passes the correct query filter — material and $lte date', async () => {
    (MaterialRate.findOne as ReturnType<typeof vi.fn>).mockReturnValue(chainResolving(null));

    await getMaterialRate('SS316L', costingDate).catch(() => { /* expected */ });

    expect(MaterialRate.findOne).toHaveBeenCalledWith({
      material: 'SS316L',
      effectiveFrom: { $lte: costingDate },
    });
  });
});

// ─── Machine rate tests ───────────────────────────────────────────────────────

describe('getMachineRate', () => {
  const costingDate = new Date('2025-03-01');

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the matching machine rate record', async () => {
    const fakeRate = {
      machine: 'CNC Turning',
      hourRate: fakeDecimal128('850.00'),
      effectiveFrom: new Date('2025-01-01'),
    };
    (MachineRate.findOne as ReturnType<typeof vi.fn>).mockReturnValue(chainResolving(fakeRate));

    const result = await getMachineRate('CNC Turning', costingDate);
    expect(result.hourRate.toString()).toBe('850.00');
  });

  it('throws MACHINE_RATE_NOT_FOUND when no record applies', async () => {
    (MachineRate.findOne as ReturnType<typeof vi.fn>).mockReturnValue(chainResolving(null));

    const err = await getMachineRate('Unknown Machine', costingDate).catch((e) => e as RateLookupError);
    expect(err).toBeInstanceOf(RateLookupError);
    expect(err.code).toBe('MACHINE_RATE_NOT_FOUND');
    expect(err.context).toMatchObject({ machine: 'Unknown Machine' });
  });

  it('looks up two different machines independently', async () => {
    // First call: CNC Turning
    (MachineRate.findOne as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce(chainResolving({ machine: 'CNC Turning', hourRate: fakeDecimal128('850.00'), effectiveFrom: new Date('2025-01-01') }))
      .mockReturnValueOnce(chainResolving({ machine: 'VMC Milling', hourRate: fakeDecimal128('1200.00'), effectiveFrom: new Date('2025-01-01') }));

    const r1 = await getMachineRate('CNC Turning', costingDate);
    const r2 = await getMachineRate('VMC Milling', costingDate);

    expect(r1.hourRate.toString()).toBe('850.00');
    expect(r2.hourRate.toString()).toBe('1200.00');
    expect(MachineRate.findOne).toHaveBeenCalledTimes(2);
  });

  it('sorts by effectiveFrom descending to get the latest rate', async () => {
    (MachineRate.findOne as ReturnType<typeof vi.fn>).mockReturnValue(chainResolving(null));
    await getMachineRate('CNC Turning', costingDate).catch(() => { /* expected */ });

    const chain = (MachineRate.findOne as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(chain.sort).toHaveBeenCalledWith({ effectiveFrom: -1 });
  });
});

// ─── Rate setting tests ───────────────────────────────────────────────────────

describe('getRateSetting', () => {
  const costingDate = new Date('2025-06-01');

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the applicable rate setting', async () => {
    const fakeSetting = {
      scrapPct: 4,
      overheadPct: 8,
      packingFreight: fakeDecimal128('2.50'),
      defaultMarginPct: 12,
      gstPct: 18,
      setupCostPerPart: fakeDecimal128('0.00'),
      effectiveFrom: new Date('2025-01-01'),
    };
    (RateSetting.findOne as ReturnType<typeof vi.fn>).mockReturnValue(chainResolving(fakeSetting));

    const result = await getRateSetting(costingDate);
    expect(result.scrapPct).toBe(4);
    expect(result.packingFreight.toString()).toBe('2.50');
  });

  it('throws RATE_SETTING_NOT_FOUND when no record applies', async () => {
    (RateSetting.findOne as ReturnType<typeof vi.fn>).mockReturnValue(chainResolving(null));

    const err = await getRateSetting(costingDate).catch((e) => e as RateLookupError);
    expect(err).toBeInstanceOf(RateLookupError);
    expect(err.code).toBe('RATE_SETTING_NOT_FOUND');
  });

  it('sorts by effectiveFrom descending to get the latest setting', async () => {
    (RateSetting.findOne as ReturnType<typeof vi.fn>).mockReturnValue(chainResolving(null));
    await getRateSetting(costingDate).catch(() => { /* expected */ });

    const chain = (RateSetting.findOne as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(chain.sort).toHaveBeenCalledWith({ effectiveFrom: -1 });
  });

  it('never returns a default — always throws when nothing matches', async () => {
    // A costingDate far in the past — before any seeded rate
    (RateSetting.findOne as ReturnType<typeof vi.fn>).mockReturnValue(chainResolving(null));

    await expect(getRateSetting(new Date('2000-01-01'))).rejects.toBeInstanceOf(RateLookupError);
  });
});

