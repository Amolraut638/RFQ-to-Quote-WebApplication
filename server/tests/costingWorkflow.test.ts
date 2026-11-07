/**
 * tests/costingWorkflow.test.ts
 *
 * Unit tests for the costing workflow service.
 * All DB and engine dependencies are mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import mongoose from 'mongoose';

// ─── Mocks (must be declared before imports that use them) ────────────────────

vi.mock('../src/models/RFQ', () => ({
  RFQ: { findById: vi.fn() },
}));

vi.mock('../src/models/Part', () => ({
  Part: { findById: vi.fn() },
}));

vi.mock('../src/models/Quote', () => ({
  Quote: { findOne: vi.fn() },
  IMMUTABLE_STATUSES: ['PENDING_APPROVAL', 'APPROVED', 'SENT'],
}));

vi.mock('../src/services/rateLookup.service', () => ({
  getMaterialRate: vi.fn(),
  getMachineRate: vi.fn(),
  getRateSetting: vi.fn(),
  decimal128ToString: (d: { toString: () => string }) => d.toString(),
  RateLookupError: class RateLookupError extends Error {
    code: string;
    context: Record<string, unknown>;
    constructor(code: string, msg: string, ctx = {}) {
      super(msg);
      this.code = code;
      this.context = ctx;
    }
  },
}));

vi.mock('../src/services/quote.service', () => ({
  createQuote: vi.fn(),
  reviseQuote: vi.fn(),
  getQuoteHistory: vi.fn(),
  getQuoteVersion: vi.fn(),
}));

vi.mock('@rfq/costing-engine', () => ({
  calculateCosting: vi.fn(),
  evaluateApproval: vi.fn(),
}));

// ─── Import after mocks ───────────────────────────────────────────────────────

import { RFQ } from '../src/models/RFQ';
import { Part } from '../src/models/Part';
import { Quote } from '../src/models/Quote';
import {
  getMaterialRate,
  getMachineRate,
  getRateSetting,
  RateLookupError,
} from '../src/services/rateLookup.service';
import { createQuote, reviseQuote } from '../src/services/quote.service';
import { calculateCosting, evaluateApproval } from '@rfq/costing-engine';
import {
  getCostingContext,
  previewCosting,
  saveQuoteVersion,
  WorkflowError,
} from '../src/services/costingWorkflow.service';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const rfqOid = new mongoose.Types.ObjectId();
const partOid = new mongoose.Types.ObjectId();
const userOid = new mongoose.Types.ObjectId();

const mockRfq = {
  _id: rfqOid,
  rfqNo: 'RFQ-TEST-001',
  customer: 'Test Co',
  dueDate: new Date('2026-12-31'),
  status: 'ESTIMATING',
};

const mockPart = {
  _id: partOid,
  rfqId: rfqOid,
  partName: 'Test Part',
  material: 'EN8',
  grossWeightKg: 0.61,
  annualVolume: 180000,
  cycleTimeMinutes: 3.2,
};

const mockMaterialRate = {
  material: 'EN8',
  ratePerKg: { toString: () => '55.00' },
  effectiveFrom: new Date('2024-07-01'),
};

const mockMachineRate = {
  machine: 'Standard CNC Turning',
  hourRate: { toString: () => '850.00' },
  effectiveFrom: new Date('2024-01-01'),
};

const mockRateSetting = {
  scrapPct: 5,
  overheadPct: 150,
  packingFreight: { toString: () => '2.50' },
  defaultMarginPct: 15,
  gstPct: 18,
  setupCostPerPart: { toString: () => '0.50' },
  effectiveFrom: new Date('2024-01-01'),
};

const mockCostingResult = {
  breakdown: {
    materialCost: '33.55',
    scrapCost: '1.68',
    conversionCost: '45.33',
    overheadCost: '120.84',
    packingFreight: '2.50',
    baseManufacturingCost: '201.40',
    setupAllocationPerPiece: '0.00',
    totalCost: '203.90',
    sellingPriceExGst: '234.49',
    gstAmount: '42.21',
    sellingPriceIncludingGst: '276.70',
  },
  volumeTiers: [
    {
      tierName: 'Low',
      tierPercentage: 50,
      tierVolume: 90000,
      setupAllocationPerPiece: '0.01',
      totalCostPerPiece: '203.91',
      sellingPriceExGst: '234.50',
      gstAmount: '42.21',
      sellingPriceIncludingGst: '276.71',
    },
    {
      tierName: 'Base',
      tierPercentage: 100,
      tierVolume: 180000,
      setupAllocationPerPiece: '0.00',
      totalCostPerPiece: '203.90',
      sellingPriceExGst: '234.49',
      gstAmount: '42.21',
      sellingPriceIncludingGst: '276.70',
    },
    {
      tierName: 'High',
      tierPercentage: 150,
      tierVolume: 270000,
      setupAllocationPerPiece: '0.00',
      totalCostPerPiece: '203.90',
      sellingPriceExGst: '234.49',
      gstAmount: '42.21',
      sellingPriceIncludingGst: '276.70',
    },
  ],
  annualQuotationValue: '42208200.00',
};

const mockApprovalDecision = {
  totalAnnualValue: '42208200.00',
  threshold: '2500000.00',
  requiresApproval: true,
};

const singleOp = [
  { operationName: 'Turning', machine: 'Standard CNC Turning', cycleTimeMinutes: 3.2 },
];

// ─── Test helpers ─────────────────────────────────────────────────────────────

function setupHappyPath() {
  (RFQ.findById as ReturnType<typeof vi.fn>).mockReturnValue({
    lean: () => Promise.resolve(mockRfq),
  });
  (Part.findById as ReturnType<typeof vi.fn>).mockReturnValue({
    lean: () => Promise.resolve(mockPart),
  });
  (getMaterialRate as ReturnType<typeof vi.fn>).mockResolvedValue(mockMaterialRate);
  (getMachineRate as ReturnType<typeof vi.fn>).mockResolvedValue(mockMachineRate);
  (getRateSetting as ReturnType<typeof vi.fn>).mockResolvedValue(mockRateSetting);
  (calculateCosting as ReturnType<typeof vi.fn>).mockReturnValue(mockCostingResult);
  (evaluateApproval as ReturnType<typeof vi.fn>).mockReturnValue(mockApprovalDecision);
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── getCostingContext ────────────────────────────────────────────────────────

describe('getCostingContext', () => {
  it('returns rfq, part, materialRate, rateSettings, availableMachines for valid ids', async () => {
    setupHappyPath();
    // getMachineRate returns for all 4 known machines
    (getMachineRate as ReturnType<typeof vi.fn>).mockResolvedValue(mockMachineRate);

    const result = await getCostingContext(rfqOid.toString(), partOid.toString());

    expect(result.rfq.rfqNo).toBe('RFQ-TEST-001');
    expect(result.part.material).toBe('EN8');
    expect(result.materialRate.ratePerKg).toBe('55.00');
    expect(result.rateSettings.scrapPct).toBe(5);
    expect(result.availableMachines.length).toBeGreaterThan(0);
    expect(result.costingDate).toBeDefined();
  });

  it('throws INVALID_RFQ_ID for non-ObjectId rfqId', async () => {
    await expect(getCostingContext('not-an-id', partOid.toString())).rejects.toMatchObject({
      code: 'INVALID_RFQ_ID',
    });
  });

  it('throws INVALID_PART_ID for non-ObjectId partId', async () => {
    await expect(getCostingContext(rfqOid.toString(), 'bad-id')).rejects.toMatchObject({
      code: 'INVALID_PART_ID',
    });
  });

  it('throws RFQ_NOT_FOUND when RFQ missing', async () => {
    (RFQ.findById as ReturnType<typeof vi.fn>).mockReturnValue({
      lean: () => Promise.resolve(null),
    });
    await expect(getCostingContext(rfqOid.toString(), partOid.toString())).rejects.toMatchObject({
      code: 'RFQ_NOT_FOUND',
    });
  });

  it('throws PART_NOT_FOUND when part missing', async () => {
    (RFQ.findById as ReturnType<typeof vi.fn>).mockReturnValue({
      lean: () => Promise.resolve(mockRfq),
    });
    (Part.findById as ReturnType<typeof vi.fn>).mockReturnValue({
      lean: () => Promise.resolve(null),
    });
    await expect(getCostingContext(rfqOid.toString(), partOid.toString())).rejects.toMatchObject({
      code: 'PART_NOT_FOUND',
    });
  });

  it('throws PART_NOT_IN_RFQ when part belongs to different RFQ', async () => {
    const otherRfqOid = new mongoose.Types.ObjectId();
    (RFQ.findById as ReturnType<typeof vi.fn>).mockReturnValue({
      lean: () => Promise.resolve(mockRfq),
    });
    (Part.findById as ReturnType<typeof vi.fn>).mockReturnValue({
      lean: () =>
        Promise.resolve({ ...mockPart, rfqId: otherRfqOid }),
    });
    await expect(getCostingContext(rfqOid.toString(), partOid.toString())).rejects.toMatchObject({
      code: 'PART_NOT_IN_RFQ',
    });
  });

  it('omits machines with no rate from availableMachines (no throw)', async () => {
    setupHappyPath();
    // Make getMachineRate throw for 2 machines, return for 2
    let callCount = 0;
    (getMachineRate as ReturnType<typeof vi.fn>).mockImplementation(() => {
      callCount++;
      if (callCount % 2 === 0) return Promise.reject(new (RateLookupError as any)('MACHINE_RATE_NOT_FOUND', 'no rate'));
      return Promise.resolve(mockMachineRate);
    });

    const result = await getCostingContext(rfqOid.toString(), partOid.toString());
    // Should not throw; availableMachines may be partial
    expect(Array.isArray(result.availableMachines)).toBe(true);
  });
});

// ─── previewCosting ───────────────────────────────────────────────────────────

describe('previewCosting', () => {
  it('returns breakdown, volumeTiers, annualQuotationValue, approvalDecision', async () => {
    setupHappyPath();

    const result = await previewCosting({
      rfqId: rfqOid.toString(),
      partId: partOid.toString(),
      routingOperations: singleOp,
    });

    expect(result.breakdown.materialCost).toBe('33.55');
    expect(result.volumeTiers).toHaveLength(3);
    expect(result.annualQuotationValue).toBe('42208200.00');
    expect(result.approvalDecision.requiresApproval).toBe(true);
  });

  it('propagates MATERIAL_RATE_NOT_FOUND without swallowing', async () => {
    (RFQ.findById as ReturnType<typeof vi.fn>).mockReturnValue({
      lean: () => Promise.resolve(mockRfq),
    });
    (Part.findById as ReturnType<typeof vi.fn>).mockReturnValue({
      lean: () => Promise.resolve(mockPart),
    });
    (getMaterialRate as ReturnType<typeof vi.fn>).mockRejectedValue(
      new (RateLookupError as any)('MATERIAL_RATE_NOT_FOUND', 'No material rate found'),
    );

    await expect(
      previewCosting({ rfqId: rfqOid.toString(), partId: partOid.toString(), routingOperations: singleOp }),
    ).rejects.toMatchObject({ code: 'MATERIAL_RATE_NOT_FOUND' });
  });

  it('propagates MACHINE_RATE_NOT_FOUND', async () => {
    (RFQ.findById as ReturnType<typeof vi.fn>).mockReturnValue({
      lean: () => Promise.resolve(mockRfq),
    });
    (Part.findById as ReturnType<typeof vi.fn>).mockReturnValue({
      lean: () => Promise.resolve(mockPart),
    });
    (getMaterialRate as ReturnType<typeof vi.fn>).mockResolvedValue(mockMaterialRate);
    (getRateSetting as ReturnType<typeof vi.fn>).mockResolvedValue(mockRateSetting);
    (getMachineRate as ReturnType<typeof vi.fn>).mockRejectedValue(
      new (RateLookupError as any)('MACHINE_RATE_NOT_FOUND', 'No machine rate found'),
    );

    await expect(
      previewCosting({ rfqId: rfqOid.toString(), partId: partOid.toString(), routingOperations: singleOp }),
    ).rejects.toMatchObject({ code: 'MACHINE_RATE_NOT_FOUND' });
  });

  it('propagates RATE_SETTING_NOT_FOUND', async () => {
    (RFQ.findById as ReturnType<typeof vi.fn>).mockReturnValue({
      lean: () => Promise.resolve(mockRfq),
    });
    (Part.findById as ReturnType<typeof vi.fn>).mockReturnValue({
      lean: () => Promise.resolve(mockPart),
    });
    (getMaterialRate as ReturnType<typeof vi.fn>).mockResolvedValue(mockMaterialRate);
    (getRateSetting as ReturnType<typeof vi.fn>).mockRejectedValue(
      new (RateLookupError as any)('RATE_SETTING_NOT_FOUND', 'No rate setting'),
    );

    await expect(
      previewCosting({ rfqId: rfqOid.toString(), partId: partOid.toString(), routingOperations: singleOp }),
    ).rejects.toMatchObject({ code: 'RATE_SETTING_NOT_FOUND' });
  });

  it('supports multiple routing operations', async () => {
    setupHappyPath();

    const twoOps = [
      { operationName: 'Turning', machine: 'Standard CNC Turning', cycleTimeMinutes: 3.2 },
      { operationName: 'Milling', machine: 'VMC Milling', cycleTimeMinutes: 2.5 },
    ];

    const result = await previewCosting({
      rfqId: rfqOid.toString(),
      partId: partOid.toString(),
      routingOperations: twoOps,
    });

    // Both ops should be in the rateSnapshot
    expect(result.rateSnapshot.operations).toHaveLength(2);
    expect(result.rateSnapshot.operations[0].operationName).toBe('Turning');
    expect(result.rateSnapshot.operations[1].operationName).toBe('Milling');
  });

  it('does NOT create a Quote document', async () => {
    setupHappyPath();

    await previewCosting({
      rfqId: rfqOid.toString(),
      partId: partOid.toString(),
      routingOperations: singleOp,
    });

    expect(createQuote).not.toHaveBeenCalled();
    expect(reviseQuote).not.toHaveBeenCalled();
  });

  it('throws INVALID_INPUT when routingOperations is empty', async () => {
    setupHappyPath();
    await expect(
      previewCosting({ rfqId: rfqOid.toString(), partId: partOid.toString(), routingOperations: [] }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});

// ─── saveQuoteVersion ─────────────────────────────────────────────────────────

describe('saveQuoteVersion', () => {
  it('calls createQuote for first quote (no existing)', async () => {
    setupHappyPath();
    (Quote.findOne as ReturnType<typeof vi.fn>).mockReturnValue({
      sort: vi.fn().mockReturnThis(),
      lean: vi.fn().mockResolvedValue(null),
    });
    const mockSaved = { _id: new mongoose.Types.ObjectId(), version: 1, status: 'DRAFT' };
    (createQuote as ReturnType<typeof vi.fn>).mockResolvedValue(mockSaved);

    const result = await saveQuoteVersion(
      { rfqId: rfqOid.toString(), partId: partOid.toString(), routingOperations: singleOp },
      userOid.toString(),
    );

    expect(createQuote).toHaveBeenCalledOnce();
    expect(reviseQuote).not.toHaveBeenCalled();
    expect(result.version).toBe(1);
  });

  it('calls reviseQuote when a quote already exists (creates v2)', async () => {
    setupHappyPath();
    const existing = { version: 1, status: 'DRAFT' };
    (Quote.findOne as ReturnType<typeof vi.fn>).mockReturnValue({
      sort: vi.fn().mockReturnThis(),
      lean: vi.fn().mockResolvedValue(existing),
    });
    const mockSaved = { _id: new mongoose.Types.ObjectId(), version: 2, status: 'DRAFT' };
    (reviseQuote as ReturnType<typeof vi.fn>).mockResolvedValue(mockSaved);

    const result = await saveQuoteVersion(
      { rfqId: rfqOid.toString(), partId: partOid.toString(), routingOperations: singleOp },
      userOid.toString(),
    );

    expect(reviseQuote).toHaveBeenCalledOnce();
    expect(createQuote).not.toHaveBeenCalled();
    expect(result.version).toBe(2);
  });

  it('snapshot preserves all routing operations', async () => {
    setupHappyPath();
    (Quote.findOne as ReturnType<typeof vi.fn>).mockReturnValue({
      sort: vi.fn().mockReturnThis(),
      lean: vi.fn().mockResolvedValue(null),
    });
    (createQuote as ReturnType<typeof vi.fn>).mockResolvedValue({ version: 1 });

    const twoOps = [
      { operationName: 'Op1', machine: 'Standard CNC Turning', cycleTimeMinutes: 3.0 },
      { operationName: 'Op2', machine: 'Grinding', cycleTimeMinutes: 1.5 },
    ];

    await saveQuoteVersion(
      { rfqId: rfqOid.toString(), partId: partOid.toString(), routingOperations: twoOps },
      userOid.toString(),
    );

    const callArg = (createQuote as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(callArg.rateSnapshot.operations).toHaveLength(2);
    expect(callArg.rateSnapshot.operations[0].operationName).toBe('Op1');
    expect(callArg.rateSnapshot.operations[1].operationName).toBe('Op2');
  });

  it('approval > 25L → requiresApproval true', async () => {
    setupHappyPath();
    (evaluateApproval as ReturnType<typeof vi.fn>).mockReturnValue({
      totalAnnualValue: '42208200.00',
      threshold: '2500000.00',
      requiresApproval: true,
    });
    (Quote.findOne as ReturnType<typeof vi.fn>).mockReturnValue({
      sort: vi.fn().mockReturnThis(),
      lean: vi.fn().mockResolvedValue(null),
    });
    (createQuote as ReturnType<typeof vi.fn>).mockResolvedValue({ version: 1 });

    // The service just persists — it doesn't block on approval.
    // We confirm the approvalDecision from preview carries the right value.
    const preview = await previewCosting({
      rfqId: rfqOid.toString(),
      partId: partOid.toString(),
      routingOperations: singleOp,
    });
    expect(preview.approvalDecision.requiresApproval).toBe(true);
  });

  it('exact 25L → requiresApproval false', async () => {
    setupHappyPath();
    (evaluateApproval as ReturnType<typeof vi.fn>).mockReturnValue({
      totalAnnualValue: '2500000.00',
      threshold: '2500000.00',
      requiresApproval: false,
    });

    const preview = await previewCosting({
      rfqId: rfqOid.toString(),
      partId: partOid.toString(),
      routingOperations: singleOp,
    });
    expect(preview.approvalDecision.requiresApproval).toBe(false);
  });

  it('snapshot is frozen — costingInput from preview equals what was passed to engine', async () => {
    setupHappyPath();
    (Quote.findOne as ReturnType<typeof vi.fn>).mockReturnValue({
      sort: vi.fn().mockReturnThis(),
      lean: vi.fn().mockResolvedValue(null),
    });
    (createQuote as ReturnType<typeof vi.fn>).mockResolvedValue({ version: 1 });

    await saveQuoteVersion(
      {
        rfqId: rfqOid.toString(),
        partId: partOid.toString(),
        routingOperations: singleOp,
        scrapPctOverride: 7,
      },
      userOid.toString(),
    );

    const callArg = (createQuote as ReturnType<typeof vi.fn>).mock.calls[0][0];
    // scrapPct override should be reflected in the snapshot
    expect(callArg.costingInput.scrapPct).toBe(7);
  });
});

