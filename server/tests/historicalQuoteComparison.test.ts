/**
 * tests/historicalQuoteComparison.test.ts
 *
 * Automated unit tests for the Historical Quote Comparison feature:
 *  1. Exact drawing number matching.
 *  2. Material grade matching.
 *  3. Weight similarity (within vs outside explicit tolerance).
 *  4. Ranking of multiple historical matches (exact drawing > material + weight > name).
 *  5. Exclusion of DRAFT quotes.
 *  6. Exclusion of REJECTED quotes.
 *  7. Retrieval from immutable historical snapshots (not current rate masters).
 *  8. Missing or incomplete snapshot handling.
 *  9. Unauthorized access (401/403 enforcement on historical comparison routes).
 * 10. Price difference calculation (exact decimal arithmetic).
 * 11. Percentage difference calculation (exact decimal arithmetic with ROUND_HALF_UP).
 * 12. Different volume tier handling (50%, 100%, 150% + equivalence warnings).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import mongoose from 'mongoose';

// ─── Mock DB Models & Costing Preview ─────────────────────────────────────────

let storedParts: any[] = [];
let storedQuotes: any[] = [];
let storedRfqs: any[] = [];

vi.mock('../src/models/Part', () => ({
  Part: {
    findById: vi.fn((id: any) => ({
      lean: async () => storedParts.find((p) => String(p._id) === String(id)) ?? null,
    })),
    find: vi.fn((filter: any) => ({
      lean: async () => {
        if (filter?._id?.$in) {
          const ids = filter._id.$in.map((x: any) => String(x));
          return storedParts.filter((p) => ids.includes(String(p._id)));
        }
        if (filter?.rfqId?.$in) {
          const rfqIds = filter.rfqId.$in.map((x: any) => String(x));
          return storedParts.filter((p) => rfqIds.includes(String(p.rfqId)));
        }
        if (filter?.rfqId) {
          return storedParts.filter((p) => String(p.rfqId) === String(filter.rfqId));
        }
        return storedParts;
      },
    })),
  },
}));

vi.mock('../src/models/Quote', () => ({
  Quote: {
    find: vi.fn((filter: any) => ({
      sort: () => ({
        lean: async () => {
          const allowedStatuses: string[] = filter?.status?.$in ?? [];
          return storedQuotes
            .filter((q) =>
              allowedStatuses.length > 0 ? allowedStatuses.includes(q.status) : true,
            )
            .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        },
      }),
    })),
    findById: vi.fn((id: any) => ({
      lean: async () => storedQuotes.find((q) => String(q._id) === String(id)) ?? null,
    })),
  },
}));

vi.mock('../src/models/RFQ', () => ({
  RFQ: {
    findById: vi.fn((id: any) => ({
      lean: async () => storedRfqs.find((r) => String(r._id) === String(id)) ?? null,
    })),
    find: vi.fn((filter: any) => ({
      lean: async () => {
        if (filter?._id?.$in) {
          const ids = filter._id.$in.map((x: any) => String(x));
          return storedRfqs.filter((r) => ids.includes(String(r._id)));
        }
        return storedRfqs;
      },
    })),
  },
}));

const mockPreviewCosting = vi.fn();

vi.mock('../src/services/costingWorkflow.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/costingWorkflow.service')>();
  return {
    ...actual,
    previewCosting: (...args: any[]) => mockPreviewCosting(...args),
  };
});

import {
  searchHistoricalQuotesForPart,
  compareWithHistoricalQuote,
  scoreHistoricalCandidate,
  isUsableHistoricalSnapshot,
  ELIGIBLE_HISTORICAL_STATUSES,
} from '../src/services/historicalQuoteComparison.service';
import { authenticate } from '../src/middleware/authenticate';
import { authorizeRoles } from '../src/middleware/authorizeRoles';

// ─── Test Helpers & Fixtures ──────────────────────────────────────────────────

const dec = (val: string) => mongoose.Types.Decimal128.fromString(val);

function buildCompleteSnapshot(overrides?: {
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
  materialCost?: string;
  scrapCost?: string;
  conversionCost?: string;
  overheadCost?: string;
  baseManufacturingCost?: string;
  setupAllocation100?: string;
  totalCost100?: string;
  sellingPriceExGst100?: string;
  sellingPriceExGst50?: string;
  sellingPriceExGst150?: string;
  setupAllocation50?: string;
  setupAllocation150?: string;
  totalCost50?: string;
  totalCost150?: string;
}) {
  const o = {
    material: 'EN8',
    materialRatePerKg: '55.00',
    grossWeightKg: '0.61',
    annualVolume: 100000,
    scrapPct: 5,
    overheadPct: 150,
    packingFreight: '2.50',
    setupCostPerPart: '5000.00',
    marginPct: 15,
    gstPct: 18,
    materialCost: '33.55',
    scrapCost: '1.68',
    conversionCost: '45.33',
    overheadCost: '68.00',
    baseManufacturingCost: '148.56',
    setupAllocation100: '0.05',
    totalCost100: '151.11',
    sellingPriceExGst100: '173.78',
    setupAllocation50: '0.10',
    totalCost50: '151.16',
    sellingPriceExGst50: '173.83',
    setupAllocation150: '0.03',
    totalCost150: '151.09',
    sellingPriceExGst150: '173.75',
    ...overrides,
  };

  return {
    annualQuotationValue: dec('17378000.00'),
    totalAnnualValue: dec('17378000.00'),
    costingDate: new Date('2026-08-15T00:00:00Z'),
    rateSnapshot: {
      material: o.material,
      materialRatePerKg: dec(o.materialRatePerKg),
      materialEffectiveFrom: new Date('2024-01-01'),
      operations: [
        {
          operationName: 'Turning',
          machine: 'Standard CNC Turning',
          cycleTimeMinutes: dec('3.2'),
          machineHourRate: dec('850.00'),
          machineRateEffectiveFrom: new Date('2024-01-01'),
        },
      ],
      scrapPct: o.scrapPct,
      overheadPct: o.overheadPct,
      packingFreight: dec(o.packingFreight),
      marginPct: o.marginPct,
      gstPct: o.gstPct,
      setupCostPerPart: dec(o.setupCostPerPart),
      settingsEffectiveFrom: new Date('2024-01-01'),
    },
    costingInputSnapshot: {
      grossWeightKg: dec(o.grossWeightKg),
      annualVolume: o.annualVolume,
      routingOperations: [
        {
          operationName: 'Turning',
          machine: 'Standard CNC Turning',
          cycleTimeMinutes: dec('3.2'),
          machineHourRate: dec('850.00'),
        },
      ],
      scrapPct: o.scrapPct,
      overheadPct: o.overheadPct,
      packingFreight: dec(o.packingFreight),
      setupCost: dec(o.setupCostPerPart),
      marginPct: o.marginPct,
      gstPct: o.gstPct,
    },
    costBreakdown: {
      materialCost: dec(o.materialCost),
      scrapCost: dec(o.scrapCost),
      conversionCost: dec(o.conversionCost),
      overheadCost: dec(o.overheadCost),
      packingFreight: dec(o.packingFreight),
      baseManufacturingCost: dec(o.baseManufacturingCost),
      setupAllocationPerPiece: dec(o.setupAllocation100),
      totalCost: dec(o.totalCost100),
      sellingPriceExGst: dec(o.sellingPriceExGst100),
      gstAmount: dec('31.28'),
      sellingPriceIncludingGst: dec('205.06'),
    },
    volumeTierResults: [
      {
        tierName: '50% Volume',
        tierPercentage: 50,
        tierVolume: Math.round(o.annualVolume * 0.5),
        setupAllocationPerPiece: dec(o.setupAllocation50),
        totalCostPerPiece: dec(o.totalCost50),
        sellingPriceExGst: dec(o.sellingPriceExGst50),
        gstAmount: dec('31.29'),
        sellingPriceIncludingGst: dec('205.12'),
      },
      {
        tierName: '100% Volume',
        tierPercentage: 100,
        tierVolume: o.annualVolume,
        setupAllocationPerPiece: dec(o.setupAllocation100),
        totalCostPerPiece: dec(o.totalCost100),
        sellingPriceExGst: dec(o.sellingPriceExGst100),
        gstAmount: dec('31.28'),
        sellingPriceIncludingGst: dec('205.06'),
      },
      {
        tierName: '150% Volume',
        tierPercentage: 150,
        tierVolume: Math.round(o.annualVolume * 1.5),
        setupAllocationPerPiece: dec(o.setupAllocation150),
        totalCostPerPiece: dec(o.totalCost150),
        sellingPriceExGst: dec(o.sellingPriceExGst150),
        gstAmount: dec('31.28'),
        sellingPriceIncludingGst: dec('205.03'),
      },
    ],
  };
}

const currentRfqId = new mongoose.Types.ObjectId();
const currentPartId = new mongoose.Types.ObjectId();

const histRfq1Id = new mongoose.Types.ObjectId();
const histRfq2Id = new mongoose.Types.ObjectId();
const histRfq3Id = new mongoose.Types.ObjectId();
const histRfq4Id = new mongoose.Types.ObjectId();

const histPart1Id = new mongoose.Types.ObjectId();
const histPart2Id = new mongoose.Types.ObjectId();
const histPart3Id = new mongoose.Types.ObjectId();
const histPart4Id = new mongoose.Types.ObjectId();

const histQuote1Id = new mongoose.Types.ObjectId();
const histQuote2Id = new mongoose.Types.ObjectId();
const histQuote3Id = new mongoose.Types.ObjectId();
const draftQuoteId = new mongoose.Types.ObjectId();
const rejectedQuoteId = new mongoose.Types.ObjectId();

beforeEach(() => {
  vi.clearAllMocks();

  storedRfqs = [
    { _id: currentRfqId, rfqNo: 'RFQ-2611-200', customer: 'Apex Auto Ltd' },
    { _id: histRfq1Id, rfqNo: 'RFQ-2611-010', customer: 'Bajaj Auto' },
    { _id: histRfq2Id, rfqNo: 'RFQ-2611-014', customer: 'Tata Motors' },
    { _id: histRfq3Id, rfqNo: 'RFQ-2611-025', customer: 'Mahindra & Mahindra' },
    { _id: histRfq4Id, rfqNo: 'RFQ-2611-030', customer: 'Force Motors' },
  ];

  storedParts = [
    {
      _id: currentPartId,
      rfqId: currentRfqId,
      partName: 'Rear Wheel Spindle',
      drawingNumber: 'DWG-SP-900',
      material: 'EN8',
      grossWeightKg: 0.65,
      annualVolume: 100000,
    },
    // Part 1: Exact drawing number match + same material + similar weight
    {
      _id: histPart1Id,
      rfqId: histRfq1Id,
      partName: 'Rear Wheel Spindle Rev A',
      drawingNumber: 'dwg-sp-900', // case-insensitive exact match
      material: 'EN8',
      grossWeightKg: 0.61,
      annualVolume: 100000,
    },
    // Part 2: Different drawing number, same material + similar weight + similar name
    {
      _id: histPart2Id,
      rfqId: histRfq2Id,
      partName: 'Front Wheel Spindle',
      drawingNumber: 'DWG-SP-555',
      material: 'EN8',
      grossWeightKg: 0.63,
      annualVolume: 80000,
    },
    // Part 3: Different drawing number, different material, heavy weight, only partial name similarity
    {
      _id: histPart3Id,
      rfqId: histRfq3Id,
      partName: 'Rear Axle Spindle Shaft',
      drawingNumber: 'DWG-AX-101',
      material: 'SAE 8620',
      grossWeightKg: 4.5,
      annualVolume: 20000,
    },
    // Part 4: Completely unrelated part
    {
      _id: histPart4Id,
      rfqId: histRfq4Id,
      partName: 'Aluminum Housing Bracket',
      drawingNumber: 'DWG-BRK-001',
      material: 'AL6061',
      grossWeightKg: 2.2,
      annualVolume: 15000,
    },
  ];

  storedQuotes = [
    {
      _id: histQuote1Id,
      rfqId: histRfq1Id,
      partId: histPart1Id,
      version: 2,
      status: 'APPROVED',
      createdAt: new Date('2026-08-15T10:00:00Z'),
      ...buildCompleteSnapshot({
        material: 'EN8',
        materialRatePerKg: '55.00', // historical snapshot rate (even if current master rate changed to 62.00)
        grossWeightKg: '0.61',
        annualVolume: 100000,
      }),
    },
    {
      _id: histQuote2Id,
      rfqId: histRfq2Id,
      partId: histPart2Id,
      version: 1,
      status: 'SENT',
      createdAt: new Date('2026-09-10T10:00:00Z'),
      ...buildCompleteSnapshot({
        material: 'EN8',
        materialRatePerKg: '54.00',
        grossWeightKg: '0.63',
        annualVolume: 80000,
      }),
    },
    {
      _id: histQuote3Id,
      rfqId: histRfq3Id,
      partId: histPart3Id,
      version: 1,
      status: 'READY_FOR_SALES',
      createdAt: new Date('2026-10-01T10:00:00Z'),
      ...buildCompleteSnapshot({
        material: 'SAE 8620',
        materialRatePerKg: '95.00',
        grossWeightKg: '4.50',
        annualVolume: 20000,
      }),
    },
    // DRAFT quote (must be excluded)
    {
      _id: draftQuoteId,
      rfqId: histRfq1Id,
      partId: histPart1Id,
      version: 3,
      status: 'DRAFT',
      createdAt: new Date('2026-10-20T10:00:00Z'),
      ...buildCompleteSnapshot({ materialRatePerKg: '99.00' }),
    },
    // REJECTED quote (must be excluded)
    {
      _id: rejectedQuoteId,
      rfqId: histRfq1Id,
      partId: histPart1Id,
      version: 1,
      status: 'REJECTED',
      createdAt: new Date('2026-08-01T10:00:00Z'),
      ...buildCompleteSnapshot({ materialRatePerKg: '40.00' }),
    },
  ];
});

// ─── Test Suite ───────────────────────────────────────────────────────────────

describe('Historical Quote Comparison — Phase 5 Automated Suite', () => {
  // 1. Exact drawing number matching
  it('1. matches exact drawing number (case-insensitive, trimmed) with highest score (+1000)', () => {
    const score = scoreHistoricalCandidate(
      {
        partName: 'Custom Gear',
        drawingNumber: '  DWG-SP-900 ',
        material: 'SAE 4140',
        grossWeightKg: 5.0,
      },
      {
        partName: 'Old Part Name',
        drawingNumber: 'dwg-sp-900',
        material: 'EN24',
        grossWeightKg: 1.0,
      },
      35,
    );

    expect(score.matchFlags.exactDrawingMatch).toBe(true);
    expect(score.score).toBeGreaterThanOrEqual(1000);
    expect(score.matchReasons[0]).toContain('Exact drawing number match');
  });

  // 2. Material grade matching
  it('2. matches same material grade (case-insensitive, trimmed) with +300 score', () => {
    const score = scoreHistoricalCandidate(
      {
        partName: 'Pinion Shaft',
        drawingNumber: 'DWG-001',
        material: ' en8 ',
        grossWeightKg: 10.0,
      },
      {
        partName: 'Flange',
        drawingNumber: 'DWG-999',
        material: 'EN8',
        grossWeightKg: 1.0, // outside weight tolerance
      },
      25,
    );

    expect(score.matchFlags.sameMaterial).toBe(true);
    expect(score.matchFlags.exactDrawingMatch).toBe(false);
    expect(score.score).toBe(300);
    expect(score.matchReasons).toContain('Same material grade (EN8)');
  });

  // 3. Weight similarity within vs outside explicit tolerance
  it('3. scores similar weight within explicit tolerance and rejects weight outside tolerance', () => {
    const withinTol = scoreHistoricalCandidate(
      {
        partName: 'Alpha',
        drawingNumber: null,
        material: 'EN8',
        grossWeightKg: 1.0,
      },
      {
        partName: 'Beta',
        drawingNumber: null,
        material: 'SAE1018',
        grossWeightKg: 1.15, // 15% diff <= 25% tolerance
      },
      25,
    );

    expect(withinTol.matchFlags.similarWeight).toBe(true);
    expect(withinTol.weightDifferencePct).toBe(15);
    expect(withinTol.score).toBeGreaterThan(0);

    const outsideTol = scoreHistoricalCandidate(
      {
        partName: 'Alpha',
        drawingNumber: null,
        material: 'EN8',
        grossWeightKg: 1.0,
      },
      {
        partName: 'Beta',
        drawingNumber: null,
        material: 'SAE1018',
        grossWeightKg: 1.4, // 40% diff > 25% tolerance
      },
      25,
    );

    expect(outsideTol.matchFlags.similarWeight).toBe(false);
    expect(outsideTol.score).toBe(0);
  });

  // 4. Ranking of multiple historical matches
  it('4. ranks multiple matches deterministically: Exact Drawing > Same Material + Weight > Similar Name', async () => {
    const res = await searchHistoricalQuotesForPart({
      partId: String(currentPartId),
      limit: 10,
      weightTolerancePct: 35,
    });

    expect(res.matches.length).toBe(3);
    // Rank 1: histQuote1Id (Exact drawing DWG-SP-900 + same material EN8 + similar weight + similar name)
    expect(res.matches[0].quoteId).toBe(String(histQuote1Id));
    expect(res.matches[0].matchFlags.exactDrawingMatch).toBe(true);

    // Rank 2: histQuote2Id (Same material EN8 + similar weight + similar name, different drawing)
    expect(res.matches[1].quoteId).toBe(String(histQuote2Id));
    expect(res.matches[1].matchFlags.exactDrawingMatch).toBe(false);
    expect(res.matches[1].matchFlags.sameMaterial).toBe(true);
    expect(res.matches[1].matchFlags.similarWeight).toBe(true);

    // Rank 3: histQuote3Id (Only similar name "Rear ... Spindle", different material & heavy weight)
    expect(res.matches[2].quoteId).toBe(String(histQuote3Id));
    expect(res.matches[2].matchFlags.sameMaterial).toBe(false);
    expect(res.matches[2].matchFlags.similarName).toBe(true);

    expect(res.matches[0].similarityScore).toBeGreaterThan(res.matches[1].similarityScore);
    expect(res.matches[1].similarityScore).toBeGreaterThan(res.matches[2].similarityScore);
  });

  // 5. Exclusion of DRAFT quotes
  it('5. excludes DRAFT quotes from historical matches and snapshot eligibility', async () => {
    expect(ELIGIBLE_HISTORICAL_STATUSES).not.toContain('DRAFT');

    const draftQuote = storedQuotes.find((q) => String(q._id) === String(draftQuoteId));
    expect(isUsableHistoricalSnapshot(draftQuote)).toBe(false);

    const res = await searchHistoricalQuotesForPart({ partId: String(currentPartId) });
    const returnedIds = res.matches.map((m) => m.quoteId);
    expect(returnedIds).not.toContain(String(draftQuoteId));
  });

  // 6. Exclusion of REJECTED quotes
  it('6. excludes REJECTED quotes from historical matches and cannot compare against a REJECTED quote', async () => {
    expect(ELIGIBLE_HISTORICAL_STATUSES).not.toContain('REJECTED');

    const rejectedQuote = storedQuotes.find((q) => String(q._id) === String(rejectedQuoteId));
    expect(isUsableHistoricalSnapshot(rejectedQuote)).toBe(false);

    const res = await searchHistoricalQuotesForPart({ partId: String(currentPartId) });
    const returnedIds = res.matches.map((m) => m.quoteId);
    expect(returnedIds).not.toContain(String(rejectedQuoteId));

    await expect(
      compareWithHistoricalQuote({
        partId: String(currentPartId),
        historicalQuoteId: String(rejectedQuoteId),
        currentCostingInput: {
          rfqId: String(currentRfqId),
          routingOperations: [
            { operationName: 'Turning', machine: 'Standard CNC Turning', cycleTimeMinutes: 3.2 },
          ],
        },
      }),
    ).rejects.toThrow(/has status "REJECTED" and cannot be used/i);
  });

  // 7. Retrieval from immutable historical snapshots
  it('7. retrieves historical rates and prices strictly from the immutable quote snapshot', async () => {
    const res = await searchHistoricalQuotesForPart({ partId: String(currentPartId) });
    const topMatch = res.matches[0];

    // Must match frozen snapshot values in histQuote1Id
    expect(topMatch.historicalMaterialRate).toBe('55.00');
    expect(topMatch.historicalMachineRates).toEqual([
      {
        operationName: 'Turning',
        machine: 'Standard CNC Turning',
        machineHourRate: '850.00',
        effectiveFrom: '2024-01-01T00:00:00.000Z',
      },
    ]);
    expect(topMatch.historicalRoutingOperations).toEqual([
      {
        operationName: 'Turning',
        machine: 'Standard CNC Turning',
        cycleTimeMinutes: 3.2,
        machineHourRate: '850.00',
      },
    ]);
    expect(topMatch.historicalScrapPct).toBe(5);
    expect(topMatch.historicalOverheadPct).toBe(150);
    expect(topMatch.historicalMarginPct).toBe(15);
    expect(topMatch.historicalSetupCost).toBe('5000.00');
    expect(topMatch.historicalPricePerPieceExGst).toBe('173.78');
    expect(topMatch.historicalAnnualVolume).toBe(100000);
    expect(topMatch.historicalAnnualQuoteValue).toBe('17378000.00');
  });

  // 8. Missing or incomplete snapshot handling
  it('8. safely filters out incomplete quote snapshots and rejects comparison if snapshot is corrupted', async () => {
    const incompleteQuoteId = new mongoose.Types.ObjectId();
    storedQuotes.push({
      _id: incompleteQuoteId,
      rfqId: histRfq1Id,
      partId: histPart1Id,
      version: 4,
      status: 'APPROVED',
      createdAt: new Date('2026-10-25T10:00:00Z'),
      // Missing rateSnapshot and costBreakdown
      costingInputSnapshot: { annualVolume: 100000 },
      volumeTierResults: [],
    });

    expect(
      isUsableHistoricalSnapshot(
        storedQuotes.find((q) => String(q._id) === String(incompleteQuoteId)),
      ),
    ).toBe(false);

    const searchRes = await searchHistoricalQuotesForPart({ partId: String(currentPartId) });
    expect(searchRes.matches.map((m) => m.quoteId)).not.toContain(String(incompleteQuoteId));

    await expect(
      compareWithHistoricalQuote({
        partId: String(currentPartId),
        historicalQuoteId: String(incompleteQuoteId),
        currentCostingInput: {
          rfqId: String(currentRfqId),
          routingOperations: [
            { operationName: 'Turning', machine: 'Standard CNC Turning', cycleTimeMinutes: 3.2 },
          ],
        },
      }),
    ).rejects.toThrow(/does not have a complete costing snapshot/i);
  });

  // 9. Unauthorized access
  it('9. blocks unauthenticated requests (401) and unauthorized roles (403)', () => {
    const reqNoToken: any = { cookies: {} };
    const res401: any = {
      statusCode: 200,
      body: null,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(payload: unknown) {
        this.body = payload;
        return this;
      },
    };
    const next = vi.fn();

    authenticate(reqNoToken, res401, next);
    expect(res401.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();

    const reqInvalidRole: any = {
      user: { id: 'u1', email: 'guest@example.com', role: 'UNKNOWN_ROLE' },
    };
    const res403: any = {
      statusCode: 200,
      body: null,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(payload: unknown) {
        this.body = payload;
        return this;
      },
    };
    const roleMiddleware = authorizeRoles('ESTIMATOR', 'SALES_HEAD');
    roleMiddleware(reqInvalidRole, res403, next);
    expect(res403.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  // 10. Price difference calculation
  it('10. calculates exact decimal absolute price and cost differences across all 11 comparison rows', async () => {
    mockPreviewCosting.mockResolvedValue({
      rfqId: String(currentRfqId),
      partId: String(currentPartId),
      costingDate: '2026-11-08T00:00:00.000Z',
      costingInput: {
        grossWeightKg: '0.65',
        annualVolume: 100000,
        materialRatePerKg: '60.50',
        operations: [
          {
            operationName: 'Turning',
            machine: 'Standard CNC Turning',
            cycleTimeMinutes: '3.2',
            machineHourRate: '850.00',
          },
        ],
        scrapPct: '5',
        overheadPct: '150',
        packingFreight: '2.50',
        setupCostPerPart: '5000.00',
        defaultMarginPct: '18',
        gstPct: '18',
      },
      breakdown: {
        materialCost: '39.33',
        scrapCost: '1.97',
        conversionCost: '45.33',
        overheadCost: '68.00',
        packingFreight: '2.50',
        baseManufacturingCost: '154.63',
        setupAllocationPerPiece: '0.05',
        totalCost: '157.18',
        sellingPriceExGst: '180.76',
        gstAmount: '32.54',
        sellingPriceIncludingGst: '213.30',
      },
      volumeTiers: [
        {
          tierName: '50% Volume',
          tierPercentage: 50,
          tierVolume: 50000,
          setupAllocationPerPiece: '0.10',
          totalCostPerPiece: '157.23',
          sellingPriceExGst: '180.81',
          gstAmount: '32.55',
          sellingPriceIncludingGst: '213.36',
        },
        {
          tierName: '100% Volume',
          tierPercentage: 100,
          tierVolume: 100000,
          setupAllocationPerPiece: '0.05',
          totalCostPerPiece: '157.18',
          sellingPriceExGst: '180.76',
          gstAmount: '32.54',
          sellingPriceIncludingGst: '213.30',
        },
        {
          tierName: '150% Volume',
          tierPercentage: 150,
          tierVolume: 150000,
          setupAllocationPerPiece: '0.03',
          totalCostPerPiece: '157.16',
          sellingPriceExGst: '180.73',
          gstAmount: '32.53',
          sellingPriceIncludingGst: '213.26',
        },
      ],
      annualQuotationValue: '18076000.00',
      requiresApproval: true,
      suggestedStatus: 'PENDING_APPROVAL',
    });

    const comparison = await compareWithHistoricalQuote({
      partId: String(currentPartId),
      historicalQuoteId: String(histQuote1Id),
      currentCostingInput: {
        rfqId: String(currentRfqId),
        routingOperations: [
          { operationName: 'Turning', machine: 'Standard CNC Turning', cycleTimeMinutes: 3.2 },
        ],
      },
      tierPercentage: 100,
    });

    expect(comparison.rows).toHaveLength(11);
    const byKey = Object.fromEntries(comparison.rows.map((r) => [r.key, r]));

    expect(byKey.materialRate.currentValue).toBe('60.50');
    expect(byKey.materialRate.historicalValue).toBe('55.00');
    expect(byKey.materialRate.absoluteDifference).toBe('5.50');

    expect(byKey.materialCost.currentValue).toBe('39.33');
    expect(byKey.materialCost.historicalValue).toBe('33.55');
    expect(byKey.materialCost.absoluteDifference).toBe('5.78');

    expect(byKey.sellingPricePerPiece.currentValue).toBe('180.76');
    expect(byKey.sellingPricePerPiece.historicalValue).toBe('173.78');
    expect(byKey.sellingPricePerPiece.absoluteDifference).toBe('6.98');

    expect(byKey.annualQuoteValue.currentValue).toBe('18076000.00');
    expect(byKey.annualQuoteValue.historicalValue).toBe('17378000.00');
    expect(byKey.annualQuoteValue.absoluteDifference).toBe('698000.00');
  });

  // 11. Percentage difference calculation
  it('11. calculates exact decimal percentage differences with ROUND_HALF_UP to 2 decimal places', async () => {
    mockPreviewCosting.mockResolvedValue({
      rfqId: String(currentRfqId),
      partId: String(currentPartId),
      costingDate: '2026-11-08T00:00:00.000Z',
      costingInput: {
        grossWeightKg: '0.65',
        annualVolume: 100000,
        materialRatePerKg: '60.50',
        operations: [
          {
            operationName: 'Turning',
            machine: 'Standard CNC Turning',
            cycleTimeMinutes: '3.2',
            machineHourRate: '850.00',
          },
        ],
        scrapPct: '5',
        overheadPct: '150',
        packingFreight: '2.50',
        setupCostPerPart: '5000.00',
        defaultMarginPct: '18',
        gstPct: '18',
      },
      breakdown: {
        materialCost: '39.33',
        scrapCost: '1.97',
        conversionCost: '45.33',
        overheadCost: '68.00',
        packingFreight: '2.50',
        baseManufacturingCost: '154.63',
        setupAllocationPerPiece: '0.05',
        totalCost: '157.18',
        sellingPriceExGst: '180.76',
        gstAmount: '32.54',
        sellingPriceIncludingGst: '213.30',
      },
      volumeTiers: [
        {
          tierName: '50% Volume',
          tierPercentage: 50,
          tierVolume: 50000,
          setupAllocationPerPiece: '0.10',
          totalCostPerPiece: '157.23',
          sellingPriceExGst: '180.81',
          gstAmount: '32.55',
          sellingPriceIncludingGst: '213.36',
        },
        {
          tierName: '100% Volume',
          tierPercentage: 100,
          tierVolume: 100000,
          setupAllocationPerPiece: '0.05',
          totalCostPerPiece: '157.18',
          sellingPriceExGst: '180.76',
          gstAmount: '32.54',
          sellingPriceIncludingGst: '213.30',
        },
        {
          tierName: '150% Volume',
          tierPercentage: 150,
          tierVolume: 150000,
          setupAllocationPerPiece: '0.03',
          totalCostPerPiece: '157.16',
          sellingPriceExGst: '180.73',
          gstAmount: '32.53',
          sellingPriceIncludingGst: '213.26',
        },
      ],
      annualQuotationValue: '18076000.00',
      requiresApproval: true,
      suggestedStatus: 'PENDING_APPROVAL',
    });

    const comparison = await compareWithHistoricalQuote({
      partId: String(currentPartId),
      historicalQuoteId: String(histQuote1Id),
      currentCostingInput: {
        rfqId: String(currentRfqId),
        routingOperations: [
          { operationName: 'Turning', machine: 'Standard CNC Turning', cycleTimeMinutes: 3.2 },
        ],
      },
      tierPercentage: 100,
    });

    const byKey = Object.fromEntries(comparison.rows.map((r) => [r.key, r]));

    // (60.50 - 55.00) / 55.00 * 100 = 10.00%
    expect(byKey.materialRate.percentageDifference).toBe('10.00');
    // (39.33 - 33.55) / 33.55 * 100 = 17.2280... -> 17.23%
    expect(byKey.materialCost.percentageDifference).toBe('17.23');
    // (180.76 - 173.78) / 173.78 * 100 = 4.01657... -> 4.02%
    expect(byKey.sellingPricePerPiece.percentageDifference).toBe('4.02');
    // (18.00 - 15.00) / 15.00 * 100 = 20.00%
    expect(byKey.margin.percentageDifference).toBe('20.00');
    // (18076000.00 - 17378000.00) / 17378000.00 * 100 = 4.01657... -> 4.02%
    expect(byKey.annualQuoteValue.percentageDifference).toBe('4.02');
  });

  // 12. Different volume tier handling
  it('12. compares equivalent volume tiers (50% and 150%) and reports equivalence warnings when volumes or weights differ', async () => {
    mockPreviewCosting.mockResolvedValue({
      rfqId: String(currentRfqId),
      partId: String(currentPartId),
      costingDate: '2026-11-08T00:00:00.000Z',
      costingInput: {
        grossWeightKg: '0.65',
        annualVolume: 100000,
        materialRatePerKg: '55.00',
        operations: [
          {
            operationName: 'Turning',
            machine: 'Standard CNC Turning',
            cycleTimeMinutes: '3.2',
            machineHourRate: '850.00',
          },
        ],
        scrapPct: '5',
        overheadPct: '150',
        packingFreight: '2.50',
        setupCostPerPart: '5000.00',
        defaultMarginPct: '15',
        gstPct: '18',
      },
      breakdown: {
        materialCost: '35.75',
        scrapCost: '1.79',
        conversionCost: '45.33',
        overheadCost: '68.00',
        packingFreight: '2.50',
        baseManufacturingCost: '150.87',
        setupAllocationPerPiece: '0.05',
        totalCost: '153.42',
        sellingPriceExGst: '176.43',
        gstAmount: '31.76',
        sellingPriceIncludingGst: '208.19',
      },
      volumeTiers: [
        {
          tierName: '50% Volume',
          tierPercentage: 50,
          tierVolume: 50000,
          setupAllocationPerPiece: '0.10',
          totalCostPerPiece: '153.47',
          sellingPriceExGst: '176.49',
          gstAmount: '31.77',
          sellingPriceIncludingGst: '208.26',
        },
        {
          tierName: '100% Volume',
          tierPercentage: 100,
          tierVolume: 100000,
          setupAllocationPerPiece: '0.05',
          totalCostPerPiece: '153.42',
          sellingPriceExGst: '176.43',
          gstAmount: '31.76',
          sellingPriceIncludingGst: '208.19',
        },
        {
          tierName: '150% Volume',
          tierPercentage: 150,
          tierVolume: 150000,
          setupAllocationPerPiece: '0.03',
          totalCostPerPiece: '153.40',
          sellingPriceExGst: '176.41',
          gstAmount: '31.75',
          sellingPriceIncludingGst: '208.16',
        },
      ],
      annualQuotationValue: '17643000.00',
      requiresApproval: true,
      suggestedStatus: 'PENDING_APPROVAL',
    });

    // Compare against histQuote2Id (annualVolume = 80,000 -> 50% tier is 40,000 vs current 50,000)
    const comp50 = await compareWithHistoricalQuote({
      partId: String(currentPartId),
      historicalQuoteId: String(histQuote2Id),
      currentCostingInput: {
        rfqId: String(currentRfqId),
        routingOperations: [
          { operationName: 'Turning', machine: 'Standard CNC Turning', cycleTimeMinutes: 3.2 },
        ],
      },
      tierPercentage: 50,
    });

    expect(comp50.tierPercentage).toBe(50);
    expect(comp50.current.tierVolume).toBe(50000);
    expect(comp50.historical.comparedTierVolume).toBe(40000);
    expect(comp50.isDirectlyEquivalent).toBe(false);
    expect(comp50.equivalenceWarnings.some((w) => w.includes('Annual volume differs'))).toBe(
      true,
    );

    const byKey50 = Object.fromEntries(comp50.rows.map((r) => [r.key, r]));
    expect(byKey50.setupCost.currentValue).toBe('0.10');
    expect(byKey50.setupCost.historicalValue).toBe('0.10');
    expect(byKey50.sellingPricePerPiece.currentValue).toBe('176.49');
    expect(byKey50.sellingPricePerPiece.historicalValue).toBe('173.83');
    // 50,000 * 176.49 = 8,824,500.00 vs 40,000 * 173.83 = 6,953,200.00
    expect(byKey50.annualQuoteValue.currentValue).toBe('8824500.00');
    expect(byKey50.annualQuoteValue.historicalValue).toBe('6953200.00');
  });
});
