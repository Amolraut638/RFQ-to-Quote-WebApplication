/**
 * tests/quoteRevisionComparison.test.ts
 *
 * Automated unit tests for the Quote Revision Comparison feature (Phase 5):
 *  1. Comparing two valid versions belonging to the same RFQ and part.
 *  2. Rejecting versions from different RFQs or non-existent versions.
 *  3. Rejecting versions from different parts within the same RFQ.
 *  4. Missing or malformed snapshots fail safely (SNAPSHOT_INCOMPLETE).
 *  5. Material rate changes (and material grade changes) from frozen snapshots.
 *  6. Machine rate changes across revisions.
 *  7. Added and removed routing operations.
 *  8. Cycle-time changes and total cycle-time diff.
 *  9. Three-tier financial comparisons (50%, 100%, 150%) and separate GST rows.
 * 10. Zero-value percentage differences (safe null without division-by-zero).
 * 11. Approval/rejection metadata and QuoteEvent audit history.
 * 12. Authentication & role authorization enforcement.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import mongoose from 'mongoose';

// ─── Mock Mongoose Models ────────────────────────────────────────────────────

let storedQuotes: any[] = [];
let storedRfqs: any[] = [];
let storedParts: any[] = [];
let storedUsers: any[] = [];
let storedEvents: any[] = [];

vi.mock('../src/models/Quote', () => ({
  Quote: {
    findById: vi.fn((id: any) => ({
      lean: async () => storedQuotes.find((q) => String(q._id) === String(id)) ?? null,
    })),
    findOne: vi.fn((filter: any) => ({
      lean: async () =>
        storedQuotes.find(
          (q) =>
            String(q.rfqId) === String(filter.rfqId) &&
            Number(q.version) === Number(filter.version),
        ) ?? null,
    })),
  },
}));

vi.mock('../src/models/RFQ', () => ({
  RFQ: {
    findById: vi.fn((id: any) => ({
      lean: async () => storedRfqs.find((r) => String(r._id) === String(id)) ?? null,
    })),
  },
}));

vi.mock('../src/models/Part', () => ({
  Part: {
    find: vi.fn((filter: any) => ({
      lean: async () =>
        storedParts.filter((p) => String(p.rfqId) === String(filter.rfqId)),
    })),
  },
}));

vi.mock('../src/models/User', () => ({
  User: {
    find: vi.fn((filter: any) => ({
      select: () => ({
        lean: async () => {
          const ids = (filter?._id?.$in ?? []).map((x: any) => String(x));
          return storedUsers.filter((u) => ids.includes(String(u._id)));
        },
      }),
    })),
  },
}));

vi.mock('../src/models/QuoteEvent', () => ({
  QuoteEvent: {
    find: vi.fn((filter: any) => ({
      sort: () => ({
        lean: async () => {
          const qIds = (filter?.quoteId?.$in ?? []).map((x: any) => String(x));
          return storedEvents
            .filter((e) => qIds.includes(String(e.quoteId)))
            .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
        },
      }),
    })),
  },
}));

import {
  compareQuoteRevisions,
  isCompleteQuoteRevisionSnapshot,
} from '../src/services/quoteRevisionComparison.service';
import { compareQuoteRevisionsHandler } from '../src/controllers/quoteRevisionComparison.controller';
import { authenticate } from '../src/middleware/authenticate';
import { authorizeRoles } from '../src/middleware/authorizeRoles';

// ─── Fixtures & Helpers ──────────────────────────────────────────────────────

const dec = (val: string | number) => mongoose.Types.Decimal128.fromString(String(val));

const rfq1Id = new mongoose.Types.ObjectId();
const rfq2Id = new mongoose.Types.ObjectId();
const part1Id = new mongoose.Types.ObjectId();
const part2Id = new mongoose.Types.ObjectId();

const estimatorId = new mongoose.Types.ObjectId();
const salesHeadId = new mongoose.Types.ObjectId();

const quoteV1Id = new mongoose.Types.ObjectId();
const quoteV2Id = new mongoose.Types.ObjectId();
const quoteDifferentPartId = new mongoose.Types.ObjectId();
const quoteOtherRfqId = new mongoose.Types.ObjectId();

function buildSnapshotVersion(opts: {
  material?: string;
  materialRatePerKg?: string;
  grossWeightKg?: string;
  annualVolume?: number;
  scrapPct?: number;
  overheadPct?: number;
  packingFreight?: string;
  setupCostPerPart?: string;
  marginPct?: number;
  gstPct?: number;
  operations?: Array<{
    operationName: string;
    machine: string;
    cycleTimeMinutes: string;
    machineHourRate: string;
  }>;
  materialCost?: string;
  scrapCost?: string;
  conversionCost?: string;
  overheadCost?: string;
  baseManufacturingCost?: string;
  setupAllocation100?: string;
  totalCost100?: string;
  sellingPriceExGst100?: string;
  gstAmount100?: string;
  sellingPriceInclGst100?: string;
  setupAllocation50?: string;
  totalCost50?: string;
  sellingPriceExGst50?: string;
  gstAmount50?: string;
  sellingPriceInclGst50?: string;
  setupAllocation150?: string;
  totalCost150?: string;
  sellingPriceExGst150?: string;
  gstAmount150?: string;
  sellingPriceInclGst150?: string;
  annualQuotationValue?: string;
}) {
  const o = {
    material: 'EN8',
    materialRatePerKg: '55.00',
    grossWeightKg: '0.610',
    annualVolume: 100000,
    scrapPct: 5,
    overheadPct: 150,
    packingFreight: '2.50',
    setupCostPerPart: '5000.00',
    marginPct: 15,
    gstPct: 18,
    operations: [
      {
        operationName: 'Turning',
        machine: 'Standard CNC Turning',
        cycleTimeMinutes: '3.20',
        machineHourRate: '850.00',
      },
      {
        operationName: 'Grinding',
        machine: 'Grinding',
        cycleTimeMinutes: '1.50',
        machineHourRate: '900.00',
      },
    ],
    materialCost: '33.55',
    scrapCost: '1.68',
    conversionCost: '67.83',
    overheadCost: '101.75',
    baseManufacturingCost: '204.81',
    setupAllocation100: '0.05',
    totalCost100: '207.36',
    sellingPriceExGst100: '238.46',
    gstAmount100: '42.92',
    sellingPriceInclGst100: '281.38',
    setupAllocation50: '0.10',
    totalCost50: '207.41',
    sellingPriceExGst50: '238.52',
    gstAmount50: '42.93',
    sellingPriceInclGst50: '281.45',
    setupAllocation150: '0.03',
    totalCost150: '207.34',
    sellingPriceExGst150: '238.44',
    gstAmount150: '42.92',
    sellingPriceInclGst150: '281.36',
    annualQuotationValue: '23846000.00',
    ...opts,
  };

  return {
    totalAnnualValue: dec(o.annualQuotationValue),
    annualQuotationValue: o.annualQuotationValue,
    rateSnapshot: {
      material: o.material,
      materialRatePerKg: dec(o.materialRatePerKg),
      materialRateEffectiveFrom: new Date('2026-01-01T00:00:00Z'),
      operations: o.operations.map((op) => ({
        operationName: op.operationName,
        machine: op.machine,
        cycleTimeMinutes: dec(op.cycleTimeMinutes),
        machineHourRate: dec(op.machineHourRate),
        machineRateEffectiveFrom: new Date('2026-01-01T00:00:00Z'),
      })),
      scrapPct: o.scrapPct,
      overheadPct: o.overheadPct,
      packingFreight: dec(o.packingFreight),
      marginPct: o.marginPct,
      gstPct: o.gstPct,
      setupCostPerPart: dec(o.setupCostPerPart),
      rateSettingEffectiveFrom: new Date('2026-01-01T00:00:00Z'),
      snapshotCreatedAt: new Date('2026-08-01T00:00:00Z'),
    },
    costingInputSnapshot: {
      grossWeightKg: dec(o.grossWeightKg),
      materialRatePerKg: dec(o.materialRatePerKg),
      scrapPct: o.scrapPct,
      routingOperations: o.operations.map((op) => ({
        operationName: op.operationName,
        machine: op.machine,
        cycleTimeMinutes: dec(op.cycleTimeMinutes),
        machineHourRate: dec(op.machineHourRate),
      })),
      overheadPct: o.overheadPct,
      packingFreightPerPiece: dec(o.packingFreight),
      setupCostPerPart: dec(o.setupCostPerPart),
      annualVolume: o.annualVolume,
      defaultMarginPct: o.marginPct,
      gstPct: o.gstPct,
    },
    costBreakdown: {
      materialCost: o.materialCost,
      scrapCost: o.scrapCost,
      conversionCost: o.conversionCost,
      overheadCost: o.overheadCost,
      packingFreight: o.packingFreight,
      baseManufacturingCost: o.baseManufacturingCost,
      setupAllocationPerPiece: o.setupAllocation100,
      totalCost: o.totalCost100,
      sellingPriceExGst: o.sellingPriceExGst100,
      gstAmount: o.gstAmount100,
      sellingPriceIncludingGst: o.sellingPriceInclGst100,
    },
    volumeTierResults: [
      {
        tierName: 'Low',
        tierPercentage: 50,
        tierVolume: Math.round(o.annualVolume * 0.5),
        setupAllocationPerPiece: o.setupAllocation50,
        totalCostPerPiece: o.totalCost50,
        sellingPriceExGst: o.sellingPriceExGst50,
        gstAmount: o.gstAmount50,
        sellingPriceIncludingGst: o.sellingPriceInclGst50,
      },
      {
        tierName: 'Base',
        tierPercentage: 100,
        tierVolume: o.annualVolume,
        setupAllocationPerPiece: o.setupAllocation100,
        totalCostPerPiece: o.totalCost100,
        sellingPriceExGst: o.sellingPriceExGst100,
        gstAmount: o.gstAmount100,
        sellingPriceIncludingGst: o.sellingPriceInclGst100,
      },
      {
        tierName: 'High',
        tierPercentage: 150,
        tierVolume: Math.round(o.annualVolume * 1.5),
        setupAllocationPerPiece: o.setupAllocation150,
        totalCostPerPiece: o.totalCost150,
        sellingPriceExGst: o.sellingPriceExGst150,
        gstAmount: o.gstAmount150,
        sellingPriceIncludingGst: o.sellingPriceInclGst150,
      },
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();

  storedUsers = [
    { _id: estimatorId, name: 'Ravi Estimator', email: 'estimator@company.com', role: 'ESTIMATOR' },
    { _id: salesHeadId, name: 'Priya Sales Head', email: 'saleshead@company.com', role: 'SALES_HEAD' },
  ];

  storedRfqs = [
    { _id: rfq1Id, rfqNo: 'RFQ-2611-014', customer: 'Tata Motors' },
    { _id: rfq2Id, rfqNo: 'RFQ-2611-099', customer: 'Bajaj Auto' },
  ];

  storedParts = [
    {
      _id: part1Id,
      rfqId: rfq1Id,
      partName: 'Rear Wheel Spindle',
      drawingNumber: 'DWG-SP-014',
      material: 'EN8',
      grossWeightKg: 0.61,
      annualVolume: 100000,
    },
    {
      _id: part2Id,
      rfqId: rfq1Id,
      partName: 'Brake Caliper Bracket',
      drawingNumber: 'DWG-BRK-014',
      material: 'EN24',
      grossWeightKg: 1.45,
      annualVolume: 50000,
    },
  ];

  // v1: REJECTED by Sales Head ("Margin too high; optimize cycle time")
  // v2: APPROVED by Sales Head after cycle time & margin revision
  storedQuotes = [
    {
      _id: quoteV1Id,
      rfqId: rfq1Id,
      partId: part1Id,
      version: 1,
      status: 'REJECTED',
      costingDate: new Date('2026-10-01T00:00:00Z'),
      createdAt: new Date('2026-10-01T09:00:00Z'),
      createdBy: estimatorId,
      submittedBy: estimatorId,
      submittedAt: new Date('2026-10-01T09:30:00Z'),
      rejectedBy: salesHeadId,
      rejectedAt: new Date('2026-10-01T14:00:00Z'),
      rejectionComment: 'Margin too high; please optimize Turning cycle time.',
      ...buildSnapshotVersion({
        material: 'EN8',
        materialRatePerKg: '55.00',
        grossWeightKg: '0.610',
        annualVolume: 100000,
        marginPct: 15,
      }),
    },
    {
      _id: quoteV2Id,
      rfqId: rfq1Id,
      partId: part1Id,
      version: 2,
      status: 'APPROVED',
      costingDate: new Date('2026-10-05T00:00:00Z'),
      createdAt: new Date('2026-10-05T10:00:00Z'),
      createdBy: estimatorId,
      submittedBy: estimatorId,
      submittedAt: new Date('2026-10-05T10:15:00Z'),
      approverId: salesHeadId,
      approvedAt: new Date('2026-10-05T15:00:00Z'),
      ...buildSnapshotVersion({
        material: 'EN8',
        materialRatePerKg: '60.50', // +5.50 (+10.00%)
        grossWeightKg: '0.610',
        annualVolume: 100000,
        marginPct: 12, // -3.00 (-20.00%)
        operations: [
          {
            operationName: 'Turning',
            machine: 'Heavy CNC Turning', // machine changed
            cycleTimeMinutes: '2.80', // -0.40 min (-12.50%)
            machineHourRate: '935.00', // +85.00 (+10.00%)
          },
          // 'Grinding' removed
          // 'Deburring' added
          {
            operationName: 'Deburring',
            machine: 'VMC',
            cycleTimeMinutes: '0.80',
            machineHourRate: '750.00',
          },
        ],
        materialCost: '36.91',
        scrapCost: '1.85',
        conversionCost: '53.63',
        overheadCost: '80.45',
        baseManufacturingCost: '172.84',
        setupAllocation100: '0.05',
        totalCost100: '175.39',
        sellingPriceExGst100: '196.44',
        gstAmount100: '35.36',
        sellingPriceInclGst100: '231.80',
        setupAllocation50: '0.10',
        totalCost50: '175.44',
        sellingPriceExGst50: '196.49',
        gstAmount50: '35.37',
        sellingPriceInclGst50: '231.86',
        setupAllocation150: '0.03',
        totalCost150: '175.37',
        sellingPriceExGst150: '196.41',
        gstAmount150: '35.35',
        sellingPriceInclGst150: '231.76',
        annualQuotationValue: '19644000.00',
      }),
    },
    // Version 3 on rfq1Id but for a different part (part2Id)
    {
      _id: quoteDifferentPartId,
      rfqId: rfq1Id,
      partId: part2Id,
      version: 3,
      status: 'DRAFT',
      costingDate: new Date('2026-10-08T00:00:00Z'),
      createdAt: new Date('2026-10-08T10:00:00Z'),
      createdBy: estimatorId,
      ...buildSnapshotVersion({ material: 'EN24', grossWeightKg: '1.450' }),
    },
    // Version 1 on a different RFQ (rfq2Id)
    {
      _id: quoteOtherRfqId,
      rfqId: rfq2Id,
      version: 1,
      status: 'APPROVED',
      costingDate: new Date('2026-09-01T00:00:00Z'),
      createdAt: new Date('2026-09-01T10:00:00Z'),
      createdBy: estimatorId,
      ...buildSnapshotVersion({}),
    },
  ];

  storedEvents = [
    {
      _id: new mongoose.Types.ObjectId(),
      quoteId: quoteV1Id,
      rfqId: rfq1Id,
      version: 1,
      action: 'SUBMITTED',
      actorId: estimatorId,
      timestamp: new Date('2026-10-01T09:30:00Z'),
    },
    {
      _id: new mongoose.Types.ObjectId(),
      quoteId: quoteV1Id,
      rfqId: rfq1Id,
      version: 1,
      action: 'REJECTED',
      actorId: salesHeadId,
      timestamp: new Date('2026-10-01T14:00:00Z'),
      comment: 'Margin too high; please optimize Turning cycle time.',
    },
    {
      _id: new mongoose.Types.ObjectId(),
      quoteId: quoteV2Id,
      rfqId: rfq1Id,
      version: 2,
      action: 'SUBMITTED',
      actorId: estimatorId,
      timestamp: new Date('2026-10-05T10:15:00Z'),
    },
    {
      _id: new mongoose.Types.ObjectId(),
      quoteId: quoteV2Id,
      rfqId: rfq1Id,
      version: 2,
      action: 'APPROVED',
      actorId: salesHeadId,
      timestamp: new Date('2026-10-05T15:00:00Z'),
    },
  ];
});

// ─── Test Suite ──────────────────────────────────────────────────────────────

describe('Quote Revision Comparison — Phase 5 Automated Suite', () => {
  // 1. Comparing two valid versions
  it('1. compares two valid quote versions belonging to the same RFQ and part using frozen snapshots', async () => {
    const res = await compareQuoteRevisions({
      quoteId: String(quoteV2Id),
      versionA: 1,
      versionB: 2,
    });

    expect(res.rfq.rfqNo).toBe('RFQ-2611-014');
    expect(res.part.partName).toBe('Rear Wheel Spindle');
    expect(res.versionA.version).toBe(1);
    expect(res.versionB.version).toBe(2);

    // Overall sellingPriceExGst: 238.46 -> 196.44 (-42.02, -17.62%)
    expect(res.summary.sellingPriceExGst.valueA).toBe('238.46');
    expect(res.summary.sellingPriceExGst.valueB).toBe('196.44');
    expect(res.summary.sellingPriceExGst.absoluteDifference).toBe('-42.02');
    expect(res.summary.sellingPriceExGst.percentageDifference).toBe('-17.62');
    expect(res.summary.sellingPriceExGst.direction).toBe('DECREASED');
  });

  // 2. Rejecting versions from different RFQs or invalid version parameters
  it('2. rejects comparisons when a version does not exist on the RFQ, belongs to another RFQ, or compares a version against itself', async () => {
    // Version 99 does not exist on rfq1Id
    await expect(
      compareQuoteRevisions({
        quoteId: String(quoteV2Id),
        versionA: 1,
        versionB: 99,
      }),
    ).rejects.toThrow(/version v99 not found/i);

    // Same version v1 vs v1 rejected
    await expect(
      compareQuoteRevisions({
        quoteId: String(quoteV2Id),
        versionA: 1,
        versionB: 1,
      }),
    ).rejects.toThrow(/cannot compare version v1 against itself/i);

    // Corrupted cross-RFQ record rejected
    const corruptedQuote = storedQuotes.find((q) => q.version === 2);
    corruptedQuote.rfqId = rfq2Id; // mutate in-memory mock to simulate cross-RFQ mismatch
    await expect(
      compareQuoteRevisions({
        quoteId: String(quoteV1Id),
        versionA: 1,
        versionB: 2,
      }),
    ).rejects.toThrow(/not found for this RFQ|same RFQ/i);
  });

  // 3. Rejecting versions from different parts
  it('3. rejects comparing two versions that belong to different parts within the same RFQ', async () => {
    await expect(
      compareQuoteRevisions({
        quoteId: String(quoteV2Id),
        versionA: 1,
        versionB: 3, // version 3 belongs to part2Id (Brake Caliper Bracket)
      }),
    ).rejects.toThrow(/different parts/i);
  });

  // 4. Missing or malformed snapshots
  it('4. fails safely with SNAPSHOT_INCOMPLETE when either version has a missing or malformed snapshot', async () => {
    const brokenQuoteId = new mongoose.Types.ObjectId();
    storedQuotes.push({
      _id: brokenQuoteId,
      rfqId: rfq1Id,
      partId: part1Id,
      version: 4,
      status: 'DRAFT',
      costingDate: new Date(),
      createdAt: new Date(),
      createdBy: estimatorId,
      // Missing rateSnapshot & 50%/150% tiers
      costingInputSnapshot: { annualVolume: 100000 },
      costBreakdown: { sellingPriceExGst: '100.00' },
      volumeTierResults: [],
    });

    expect(
      isCompleteQuoteRevisionSnapshot(
        storedQuotes.find((q) => String(q._id) === String(brokenQuoteId)),
      ),
    ).toBe(false);

    await expect(
      compareQuoteRevisions({
        quoteId: String(quoteV2Id),
        versionA: 1,
        versionB: 4,
      }),
    ).rejects.toThrow(/incomplete or malformed costing snapshot/i);
  });

  // 5. Material rate changes
  it('5. accurately computes material rate and material cost changes from frozen snapshots', async () => {
    const res = await compareQuoteRevisions({
      quoteId: String(quoteV2Id),
      versionA: 1,
      versionB: 2,
    });

    const rowsByKey = Object.fromEntries(res.parameterRows.map((r) => [r.key, r]));

    // Material rate: 55.00 -> 60.50 (+5.50, +10.00%)
    expect(rowsByKey.materialRate.versionAValue).toBe('55.00');
    expect(rowsByKey.materialRate.versionBValue).toBe('60.50');
    expect(rowsByKey.materialRate.absoluteDifference).toBe('5.50');
    expect(rowsByKey.materialRate.percentageDifference).toBe('10.00');
    expect(rowsByKey.materialRate.direction).toBe('INCREASED');

    // Material cost: 33.55 -> 36.91 (+3.36, +10.01%)
    expect(rowsByKey.materialCost.versionAValue).toBe('33.55');
    expect(rowsByKey.materialCost.versionBValue).toBe('36.91');
    expect(rowsByKey.materialCost.absoluteDifference).toBe('3.36');
    expect(rowsByKey.materialCost.percentageDifference).toBe('10.01');
  });

  // 6. Machine rate changes
  it('6. detects machine changes and machine hourly rate deltas on routing operations', async () => {
    const res = await compareQuoteRevisions({
      quoteId: String(quoteV2Id),
      versionA: 1,
      versionB: 2,
    });

    const turningDiff = res.routingComparison.operations.find(
      (op) => op.operationName === 'Turning',
    );
    expect(turningDiff).toBeDefined();
    expect(turningDiff!.status).toBe('MODIFIED');
    expect(turningDiff!.machineChanged).toBe(true);
    expect(turningDiff!.machineA).toBe('Standard CNC Turning');
    expect(turningDiff!.machineB).toBe('Heavy CNC Turning');
    expect(turningDiff!.machineHourRateA).toBe('850.00');
    expect(turningDiff!.machineHourRateB).toBe('935.00');
    expect(turningDiff!.machineHourRateDiff).toBe('85.00');
    expect(turningDiff!.machineHourRatePctDiff).toBe('10.00');
  });

  // 7. Added and removed routing operations
  it('7. identifies ADDED, REMOVED, and MODIFIED routing operations accurately', async () => {
    const res = await compareQuoteRevisions({
      quoteId: String(quoteV2Id),
      versionA: 1,
      versionB: 2,
    });

    expect(res.routingComparison.modifiedCount).toBe(1); // Turning
    expect(res.routingComparison.removedCount).toBe(1); // Grinding
    expect(res.routingComparison.addedCount).toBe(1); // Deburring
    expect(res.routingComparison.unchangedCount).toBe(0);

    const grinding = res.routingComparison.operations.find(
      (op) => op.operationName === 'Grinding',
    );
    expect(grinding?.status).toBe('REMOVED');
    expect(grinding?.stepNumberA).toBe(2);
    expect(grinding?.stepNumberB).toBeNull();

    const deburring = res.routingComparison.operations.find(
      (op) => op.operationName === 'Deburring',
    );
    expect(deburring?.status).toBe('ADDED');
    expect(deburring?.stepNumberA).toBeNull();
    expect(deburring?.stepNumberB).toBe(2);
    expect(deburring?.machineB).toBe('VMC');
    expect(deburring?.cycleTimeMinutesB).toBe('0.80');
  });

  // 8. Cycle-time changes
  it('8. calculates per-operation and total cycle-time differences using decimal arithmetic', async () => {
    const res = await compareQuoteRevisions({
      quoteId: String(quoteV2Id),
      versionA: 1,
      versionB: 2,
    });

    const turningDiff = res.routingComparison.operations.find(
      (op) => op.operationName === 'Turning',
    )!;
    // 3.20 -> 2.80 (-0.40 min, -12.50%)
    expect(turningDiff.cycleTimeMinutesA).toBe('3.20');
    expect(turningDiff.cycleTimeMinutesB).toBe('2.80');
    expect(turningDiff.cycleTimeDiffMinutes).toBe('-0.40');
    expect(turningDiff.cycleTimePctDiff).toBe('-12.50');

    // Total cycle time: (3.20 + 1.50 = 4.70) -> (2.80 + 0.80 = 3.60), diff = -1.10 (-23.40%)
    expect(res.summary.totalCycleTimeMinutes.valueA).toBe('4.70');
    expect(res.summary.totalCycleTimeMinutes.valueB).toBe('3.60');
    expect(res.summary.totalCycleTimeMinutes.absoluteDifference).toBe('-1.10');
    expect(res.summary.totalCycleTimeMinutes.percentageDifference).toBe('-23.40');
  });

  // 9. Three-tier financial comparisons & separate GST display
  it('9. compares all three volume tiers (50%, 100%, 150%) and separates GST rows', async () => {
    const res = await compareQuoteRevisions({
      quoteId: String(quoteV2Id),
      versionA: 1,
      versionB: 2,
    });

    expect(res.tierComparisons).toHaveLength(3);
    const [t50, t100, t150] = res.tierComparisons;

    expect(t50.tierPercentage).toBe(50);
    expect(t50.sellingPriceExGst.valueA).toBe('238.52');
    expect(t50.sellingPriceExGst.valueB).toBe('196.49');
    expect(t50.sellingPriceExGst.absoluteDifference).toBe('-42.03');

    expect(t100.tierPercentage).toBe(100);
    expect(t100.sellingPriceExGst.valueA).toBe('238.46');
    expect(t100.sellingPriceExGst.valueB).toBe('196.44');
    expect(t100.tierAnnualQuoteValueExGst.valueA).toBe('23846000.00');
    expect(t100.tierAnnualQuoteValueExGst.valueB).toBe('19644000.00');
    expect(t100.tierAnnualQuoteValueExGst.absoluteDifference).toBe('-4202000.00');

    expect(t150.tierPercentage).toBe(150);
    expect(t150.sellingPriceExGst.valueA).toBe('238.44');
    expect(t150.sellingPriceExGst.valueB).toBe('196.41');
    expect(t150.sellingPriceExGst.absoluteDifference).toBe('-42.03');

    // GST displayed separately in gstRows
    expect(res.gstRows).toHaveLength(3);
    const gstByKey = Object.fromEntries(res.gstRows.map((r) => [r.key, r]));
    expect(gstByKey.gstPct.versionAValue).toBe('18.00');
    expect(gstByKey.gstPct.versionBValue).toBe('18.00');
    expect(gstByKey.gstAmountPerPiece.versionAValue).toBe('42.92');
    expect(gstByKey.gstAmountPerPiece.versionBValue).toBe('35.36');
    expect(gstByKey.gstAmountPerPiece.absoluteDifference).toBe('-7.56');
    expect(gstByKey.sellingPriceInclGst.versionAValue).toBe('281.38');
    expect(gstByKey.sellingPriceInclGst.versionBValue).toBe('231.80');
    expect(gstByKey.sellingPriceInclGst.absoluteDifference).toBe('-49.58');
  });

  // 10. Zero-value percentage differences
  it('10. safely returns percentageDifference: null when Version A has a zero value', async () => {
    const zeroV1Quote = storedQuotes.find((q) => q.version === 1);
    zeroV1Quote.rateSnapshot.scrapPct = 0;
    zeroV1Quote.costBreakdown.scrapCost = '0.00';
    zeroV1Quote.rateSnapshot.packingFreight = dec('0.00');
    zeroV1Quote.costBreakdown.packingFreight = '0.00';

    const res = await compareQuoteRevisions({
      quoteId: String(quoteV2Id),
      versionA: 1,
      versionB: 2,
    });

    const rowsByKey = Object.fromEntries(res.parameterRows.map((r) => [r.key, r]));
    expect(rowsByKey.scrapPct.versionAValue).toBe('0.00');
    expect(rowsByKey.scrapPct.versionBValue).toBe('5.00');
    expect(rowsByKey.scrapPct.absoluteDifference).toBe('5.00');
    expect(rowsByKey.scrapPct.percentageDifference).toBeNull();

    expect(rowsByKey.scrapCost.versionAValue).toBe('0.00');
    expect(rowsByKey.scrapCost.versionBValue).toBe('1.85');
    expect(rowsByKey.scrapCost.absoluteDifference).toBe('1.85');
    expect(rowsByKey.scrapCost.percentageDifference).toBeNull();

    expect(rowsByKey.packingFreight.versionAValue).toBe('0.00');
    expect(rowsByKey.packingFreight.versionBValue).toBe('2.50');
    expect(rowsByKey.packingFreight.absoluteDifference).toBe('2.50');
    expect(rowsByKey.packingFreight.percentageDifference).toBeNull();
  });

  // 11. Approval metadata & QuoteEvent history
  it('11. populates creator, approval/rejection metadata, and QuoteEvent audit history on both versions', async () => {
    const res = await compareQuoteRevisions({
      quoteId: String(quoteV2Id),
      versionA: 1,
      versionB: 2,
    });

    expect(res.versionA.status).toBe('REJECTED');
    expect((res.versionA.createdBy as any).name).toBe('Ravi Estimator');
    expect((res.versionA.rejectedBy as any).name).toBe('Priya Sales Head');
    expect(res.versionA.rejectionComment).toBe(
      'Margin too high; please optimize Turning cycle time.',
    );
    expect(res.versionA.events).toHaveLength(2);
    expect(res.versionA.events[1].action).toBe('REJECTED');

    expect(res.versionB.status).toBe('APPROVED');
    expect((res.versionB.createdBy as any).name).toBe('Ravi Estimator');
    expect((res.versionB.approvedBy as any).name).toBe('Priya Sales Head');
    expect(res.versionB.approvedAt).toBe('2026-10-05T15:00:00.000Z');
    expect(res.versionB.events).toHaveLength(2);
    expect(res.versionB.events[1].action).toBe('APPROVED');
  });

  // 12. Authorization & controller error mapping
  it('12. enforces authentication (401), role authorization (403), and controller status codes', async () => {
    const next = vi.fn();

    // 401 when no token cookie
    const req401: any = { cookies: {} };
    const res401: any = {
      statusCode: 200,
      status(c: number) {
        this.statusCode = c;
        return this;
      },
      json() {
        return this;
      },
    };
    authenticate(req401, res401, next);
    expect(res401.statusCode).toBe(401);

    // 403 when role is not ESTIMATOR or SALES_HEAD
    const req403: any = { user: { id: 'u1', email: 'x@y.com', role: 'GUEST' } };
    const res403: any = {
      statusCode: 200,
      status(c: number) {
        this.statusCode = c;
        return this;
      },
      json() {
        return this;
      },
    };
    authorizeRoles('ESTIMATOR', 'SALES_HEAD')(req403, res403, next);
    expect(res403.statusCode).toBe(403);

    // Controller returns 200 for valid request
    const req200: any = {
      params: { quoteId: String(quoteV2Id) },
      query: { versionA: '1', versionB: '2' },
    };
    const res200: any = {
      statusCode: 200,
      payload: null as any,
      status(c: number) {
        this.statusCode = c;
        return this;
      },
      json(body: any) {
        this.payload = body;
        return this;
      },
    };
    await compareQuoteRevisionsHandler(req200, res200, next);
    expect(res200.statusCode).toBe(200);
    expect(res200.payload.success).toBe(true);
    expect(res200.payload.data.versionA.version).toBe(1);
    expect(res200.payload.data.versionB.version).toBe(2);
  });
});
