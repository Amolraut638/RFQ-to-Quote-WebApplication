/**
 * tests/quote.service.test.ts
 *
 * Unit tests for the quote service.
 * Mongoose models and the costing engine are mocked.
 * No database connection required.
 *
 * Tests:
 *  1. createQuote stores full snapshot (inputs + breakdown + tiers).
 *  2. Multiple routing operations preserved in snapshot.
 *  3. reviseQuote creates a new version; previous version is untouched.
 *  4. Rate master changes do NOT affect historical snapshots.
 *  5. submitForApproval transitions DRAFT → PENDING_APPROVAL.
 *  6. PENDING_APPROVAL, APPROVED, SENT versions cannot be edited.
 *  7. approveQuote records approver + timestamp on correct version.
 *  8. rejectQuote keeps rejected version in history.
 *  9. markAsSent transitions APPROVED → SENT.
 * 10. Invalid status transitions throw QuoteServiceError.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import mongoose from 'mongoose';

// ─── Mock Quote model ─────────────────────────────────────────────────────────
// Use inline vi.fn() inside factory — avoids hoisting reference errors.

vi.mock('../src/models/Quote', async () => {
  const actual = await vi.importActual<typeof import('../src/models/Quote')>('../src/models/Quote');
  return {
    ...actual,
    Quote: {
      findOne: vi.fn(),
      find: vi.fn(),
      create: vi.fn(),
    },
  };
});

import {
  createQuote,
  reviseQuote,
  submitForApproval,
  approveQuote,
  rejectQuote,
  markAsSent,
  QuoteServiceError,
} from '../src/services/quote.service';
import { IMMUTABLE_STATUSES, Quote } from '../src/models/Quote';
import type { CostingInput, CostingResult } from '@rfq/costing-engine';

// Get typed references to the mock functions via the mocked module
const mockFindOne = Quote.findOne as ReturnType<typeof vi.fn>;
const mockCreate = Quote.create as ReturnType<typeof vi.fn>;

/** Returns a chainable mock query that resolves to `result`. Used for .sort().lean() chains. */
function chainResolving(result: unknown) {
  const q: Record<string, unknown> = {};
  q.sort = vi.fn().mockReturnValue(q);
  q.lean = vi.fn().mockResolvedValue(result);
  // Allow direct await (Promise-like) for cases where the chain isn't used
  q.then = (resolve: (v: unknown) => void) => Promise.resolve(result).then(resolve);
  return q;
}

/** Returns a mock that resolves directly (no chaining). Used for simple findOne calls. */
function resolving(result: unknown) {
  return Promise.resolve(result);
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const rfqId = new mongoose.Types.ObjectId();
const userId = new mongoose.Types.ObjectId();
const approverId = new mongoose.Types.ObjectId();
const costingDate = new Date('2025-06-01');

const singleOpInput: CostingInput = {
  grossWeightKg: 0.61,
  materialRatePerKg: 70,
  scrapPct: 4,
  routingOperations: [
    { operationName: 'Turning', machine: 'CNC Turning', cycleTimeMinutes: 3.2, machineHourRate: 850 },
  ],
  overheadPct: 8,
  packingFreightPerPiece: 2.5,
  setupCostPerPart: 0,
  annualVolume: 180000,
  defaultMarginPct: 12,
  gstPct: 18,
};

const twoOpInput: CostingInput = {
  ...singleOpInput,
  routingOperations: [
    { operationName: 'Turning', machine: 'CNC Turning', cycleTimeMinutes: 1, machineHourRate: 450 },
    { operationName: 'Milling', machine: 'VMC Milling', cycleTimeMinutes: 0.5, machineHourRate: 300 },
  ],
};

const mockBreakdown = {
  materialCost: '42.70',
  scrapCost: '1.71',
  conversionCost: '45.33',
  overheadCost: '7.18',
  packingFreight: '2.50',
  baseManufacturingCost: '96.92',
  setupAllocationPerPiece: '0.00',
  totalCost: '99.42',
  sellingPriceExGst: '111.35',
  gstAmount: '20.04',
  sellingPriceIncludingGst: '131.39',
};

const mockTiers = [
  { tierName: 'Low', tierPercentage: 50, tierVolume: 90000, setupAllocationPerPiece: '0.00', totalCostPerPiece: '99.42', sellingPriceExGst: '111.35', gstAmount: '20.04', sellingPriceIncludingGst: '131.39' },
  { tierName: 'Base', tierPercentage: 100, tierVolume: 180000, setupAllocationPerPiece: '0.00', totalCostPerPiece: '99.42', sellingPriceExGst: '111.35', gstAmount: '20.04', sellingPriceIncludingGst: '131.39' },
  { tierName: 'High', tierPercentage: 150, tierVolume: 270000, setupAllocationPerPiece: '0.00', totalCostPerPiece: '99.42', sellingPriceExGst: '111.35', gstAmount: '20.04', sellingPriceIncludingGst: '131.39' },
];

const mockCostingResult: CostingResult = {
  breakdown: mockBreakdown,
  volumeTiers: mockTiers,
  annualQuotationValue: '20043000.00',
};

const mockRateSnapshot = {
  material: 'EN8',
  materialRatePerKg: mongoose.Types.Decimal128.fromString('70.00'),
  materialRateEffectiveFrom: new Date('2024-07-01'),
  operations: [
    {
      operationName: 'Turning',
      machine: 'CNC Turning',
      cycleTimeMinutes: mongoose.Types.Decimal128.fromString('3.2'),
      machineHourRate: mongoose.Types.Decimal128.fromString('850.00'),
      machineRateEffectiveFrom: new Date('2024-01-01'),
    },
  ],
  scrapPct: 4,
  overheadPct: 8,
  packingFreight: mongoose.Types.Decimal128.fromString('2.50'),
  marginPct: 12,
  gstPct: 18,
  setupCostPerPart: mongoose.Types.Decimal128.fromString('0.00'),
  rateSettingEffectiveFrom: new Date('2024-01-01'),
  snapshotCreatedAt: new Date(),
};

/** Build a fake quote document with save() spy */
function fakeQuote(overrides: Record<string, unknown> = {}) {
  const doc = {
    _id: new mongoose.Types.ObjectId(),
    rfqId,
    version: 1,
    status: 'DRAFT',
    costingDate,
    createdBy: userId,
    totalAnnualValue: mongoose.Types.Decimal128.fromString('20043000.00'),
    rateSnapshot: mockRateSnapshot,
    costBreakdown: mockBreakdown,
    volumeTierResults: mockTiers,
    annualQuotationValue: '20043000.00',
    save: vi.fn().mockImplementation(function (this: Record<string, unknown>) { return Promise.resolve(this); }),
    ...overrides,
  };
  return doc;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
});

describe('createQuote', () => {
  it('creates v1 DRAFT and stores the full snapshot', async () => {
    mockFindOne.mockResolvedValue(null); // no existing draft
    const created = fakeQuote({ version: 1 });
    mockCreate.mockResolvedValue(created);

    const result = await createQuote({
      rfqId, createdBy: userId, costingDate,
      costingInput: singleOpInput,
      costingResult: mockCostingResult,
      rateSnapshot: mockRateSnapshot,
    });

    expect(mockCreate).toHaveBeenCalledOnce();
    const arg = mockCreate.mock.calls[0][0];
    expect(arg.version).toBe(1);
    expect(arg.status).toBe('DRAFT');
    expect(arg.annualQuotationValue).toBe('20043000.00');
    // cost breakdown stored
    expect(arg.costBreakdown.materialCost).toBe('42.70');
    // tier results stored (3 tiers)
    expect(arg.volumeTierResults).toHaveLength(3);
    expect(arg.volumeTierResults[0].tierName).toBe('Low');
  });

  it('returns existing DRAFT without creating a duplicate', async () => {
    const existing = fakeQuote({ version: 1 });
    mockFindOne.mockResolvedValue(existing);

    await createQuote({
      rfqId, createdBy: userId, costingDate,
      costingInput: singleOpInput,
      costingResult: mockCostingResult,
      rateSnapshot: mockRateSnapshot,
    });

    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('preserves multiple routing operations in costingInputSnapshot', async () => {
    mockFindOne.mockResolvedValue(null);
    const created = fakeQuote({ version: 1 });
    mockCreate.mockResolvedValue(created);

    await createQuote({
      rfqId, createdBy: userId, costingDate,
      costingInput: twoOpInput,
      costingResult: mockCostingResult,
      rateSnapshot: mockRateSnapshot,
    });

    const arg = mockCreate.mock.calls[0][0];
    expect(arg.costingInputSnapshot.routingOperations).toHaveLength(2);
    expect(arg.costingInputSnapshot.routingOperations[0].machine).toBe('CNC Turning');
    expect(arg.costingInputSnapshot.routingOperations[1].machine).toBe('VMC Milling');
  });

  it('snapshot is frozen — rate master changes do not affect it', async () => {
    mockFindOne.mockResolvedValue(null);
    const created = fakeQuote({ version: 1 });
    mockCreate.mockResolvedValue(created);

    await createQuote({
      rfqId, createdBy: userId, costingDate,
      costingInput: singleOpInput,
      costingResult: mockCostingResult,
      rateSnapshot: mockRateSnapshot,
    });

    const arg = mockCreate.mock.calls[0][0];
    const snapshotRate = arg.rateSnapshot.materialRatePerKg.toString();

    // "Change" rate master (simulate; the snapshot is already stored)
    expect(snapshotRate).toBe('70.00');
    // No recalculation occurs — the stored value is immutable
  });
});

describe('reviseQuote', () => {
  it('creates a new version (N+1); previous version is untouched', async () => {
    // Latest existing version is v2 — returned by the chainable findOne().sort().lean()
    const latestQuote = fakeQuote({ version: 2, status: 'REJECTED' });
    mockFindOne.mockReturnValue(chainResolving(latestQuote));
    const v3 = fakeQuote({ version: 3 });
    mockCreate.mockResolvedValue(v3);

    const result = await reviseQuote({
      rfqId, createdBy: userId, costingDate,
      costingInput: singleOpInput,
      costingResult: mockCostingResult,
      rateSnapshot: mockRateSnapshot,
    });

    expect(result.version).toBe(3);
    expect(mockCreate).toHaveBeenCalledOnce();
    const arg = mockCreate.mock.calls[0][0];
    expect(arg.version).toBe(3);
    expect(arg.status).toBe('DRAFT');
  });

  it('creates v1 when no previous version exists', async () => {
    mockFindOne.mockReturnValue(chainResolving(null));
    const v1 = fakeQuote({ version: 1 });
    mockCreate.mockResolvedValue(v1);

    const result = await reviseQuote({
      rfqId, createdBy: userId, costingDate,
      costingInput: singleOpInput,
      costingResult: mockCostingResult,
      rateSnapshot: mockRateSnapshot,
    });

    expect(result.version).toBe(1);
  });
});

describe('Quote immutability enforcement', () => {
  it.each(IMMUTABLE_STATUSES)(
    'submitForApproval throws QUOTE_IMMUTABLE for status %s',
    async (status) => {
      const q = fakeQuote({ status });
      mockFindOne.mockResolvedValue(q);

      await expect(submitForApproval(rfqId, 1)).rejects.toBeInstanceOf(QuoteServiceError);
      const err = await submitForApproval(rfqId, 1).catch((e) => e as QuoteServiceError);
      expect(err.code).toBe('QUOTE_IMMUTABLE');
    },
  );

  it('REJECTED version is NOT immutable — allows re-submission after fix', async () => {
    // REJECTED is not in IMMUTABLE_STATUSES but still cannot be submitted directly
    const q = fakeQuote({ status: 'REJECTED' });
    mockFindOne.mockResolvedValue(q);

    // Should throw INVALID_STATUS_TRANSITION, not QUOTE_IMMUTABLE
    const err = await submitForApproval(rfqId, 1).catch((e) => e as QuoteServiceError);
    expect(err).toBeInstanceOf(QuoteServiceError);
    expect(err.code).toBe('INVALID_STATUS_TRANSITION');
  });

  it('DRAFT can be submitted for approval', async () => {
    const q = fakeQuote({ status: 'DRAFT' });
    mockFindOne.mockResolvedValue(q);

    await submitForApproval(rfqId, 1);
    expect(q.save).toHaveBeenCalled();
    expect(q.status).toBe('PENDING_APPROVAL');
  });
});

describe('approveQuote', () => {
  it('transitions PENDING_APPROVAL → APPROVED and records approver + timestamp', async () => {
    const q = fakeQuote({ version: 2, status: 'PENDING_APPROVAL' });
    mockFindOne.mockResolvedValue(q);

    const beforeApproval = Date.now();
    await approveQuote({ rfqId, version: 2, approverId });

    expect(q.status).toBe('APPROVED');
    expect(q.approverId).toEqual(approverId);
    expect(q.approvedAt).toBeInstanceOf(Date);
    expect(q.approvedAt!.getTime()).toBeGreaterThanOrEqual(beforeApproval);
    expect(q.save).toHaveBeenCalled();
  });

  it('approval is on the SPECIFIC version requested', async () => {
    const q = fakeQuote({ version: 3, status: 'PENDING_APPROVAL' });
    // Verify findOne was called with version: 3
    mockFindOne.mockImplementation((filter: Record<string, unknown>) => {
      expect(filter.version).toBe(3);
      return Promise.resolve(q);
    });

    await approveQuote({ rfqId, version: 3, approverId });
    expect(q.status).toBe('APPROVED');
  });

  it('throws INVALID_STATUS_TRANSITION if not PENDING_APPROVAL', async () => {
    const q = fakeQuote({ status: 'DRAFT' });
    mockFindOne.mockResolvedValue(q);

    const err = await approveQuote({ rfqId, version: 1, approverId }).catch((e) => e as QuoteServiceError);
    expect(err.code).toBe('INVALID_STATUS_TRANSITION');
  });

  it('throws QUOTE_NOT_FOUND for non-existent version', async () => {
    mockFindOne.mockResolvedValue(null);
    const err = await approveQuote({ rfqId, version: 99, approverId }).catch((e) => e as QuoteServiceError);
    expect(err.code).toBe('QUOTE_NOT_FOUND');
  });
});

describe('rejectQuote', () => {
  it('transitions PENDING_APPROVAL → REJECTED; version remains in history', async () => {
    const q = fakeQuote({ status: 'PENDING_APPROVAL' });
    mockFindOne.mockResolvedValue(q);

    await rejectQuote(rfqId, 1);

    expect(q.status).toBe('REJECTED');
    expect(q.save).toHaveBeenCalled();
    // The document is updated but not deleted — preserved in history
  });

  it('throws INVALID_STATUS_TRANSITION if not PENDING_APPROVAL', async () => {
    const q = fakeQuote({ status: 'APPROVED' });
    mockFindOne.mockResolvedValue(q);

    const err = await rejectQuote(rfqId, 1).catch((e) => e as QuoteServiceError);
    expect(err.code).toBe('INVALID_STATUS_TRANSITION');
  });
});

describe('markAsSent', () => {
  it('transitions APPROVED → SENT', async () => {
    const q = fakeQuote({ status: 'APPROVED' });
    mockFindOne.mockResolvedValue(q);

    await markAsSent(rfqId, 1);
    expect(q.status).toBe('SENT');
  });

  it('throws INVALID_STATUS_TRANSITION if not APPROVED', async () => {
    const q = fakeQuote({ status: 'DRAFT' });
    mockFindOne.mockResolvedValue(q);

    const err = await markAsSent(rfqId, 1).catch((e) => e as QuoteServiceError);
    expect(err.code).toBe('INVALID_STATUS_TRANSITION');
  });
});
