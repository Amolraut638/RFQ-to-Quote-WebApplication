/**
 * tests/routingSuggestion.test.ts
 *
 * Automated unit tests for AI-assisted historical routing suggestions:
 *  1. Matching historical material & similar weight -> retrieves operations from Quote snapshot.
 *  2. Valid historical source selection by AI -> returns suggestedOperations + historical attribution.
 *  3. Invalid source rejection -> throws AI_INVALID_RESPONSE if AI invents a candidateId.
 *  4. No historical match -> returns hasSuggestion: false without calling AI.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import mongoose from 'mongoose';

const mockTargetPartId = new mongoose.Types.ObjectId();
const mockHistPart1Id = new mongoose.Types.ObjectId();
const mockHistPart2Id = new mongoose.Types.ObjectId();
const mockHistRfq1Id = new mongoose.Types.ObjectId();
const mockHistRfq2Id = new mongoose.Types.ObjectId();

let storedParts: any[] = [];
let storedQuotes: any[] = [];
let storedRfqs: any[] = [];

vi.mock('../src/models/Part', () => ({
  Part: {
    findById: vi.fn((id: any) => ({
      lean: async () => storedParts.find((p) => String(p._id) === String(id)) ?? null,
    })),
    find: vi.fn((filter: any) => ({
      lean: async () =>
        storedParts.filter(
          (p) =>
            String(p._id) !== String(filter._id?.$ne) &&
            (filter.material instanceof RegExp ? filter.material.test(p.material) : true),
        ),
    })),
  },
}));

vi.mock('../src/models/Quote', () => ({
  Quote: {
    findOne: vi.fn((filter: any) => ({
      sort: () => ({
        lean: async () =>
          storedQuotes
            .filter((q) => String(q.rfqId) === String(filter.rfqId))
            .sort((a, b) => b.version - a.version)[0] ?? null,
      }),
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

import { getRoutingSuggestionForPart } from '../src/services/intake/routingSuggestion.service';
import type { AIProvider } from '../src/services/ai/AIProvider';

beforeEach(() => {
  storedParts = [
    {
      _id: mockTargetPartId,
      rfqId: new mongoose.Types.ObjectId(),
      partName: 'Front Wheel Spindle',
      material: 'EN8',
      grossWeightKg: 0.64,
      annualVolume: 50000,
    },
    {
      _id: mockHistPart1Id,
      rfqId: mockHistRfq1Id,
      partName: 'Rear wheel spindle',
      material: 'EN8',
      grossWeightKg: 0.61,
      annualVolume: 180000,
    },
    {
      _id: mockHistPart2Id,
      rfqId: mockHistRfq2Id,
      partName: 'Heavy Coupling Hub',
      material: 'EN8',
      grossWeightKg: 4.5,
      annualVolume: 10000,
    },
  ];

  storedRfqs = [
    { _id: mockHistRfq1Id, rfqNo: 'RFQ-2611-014', customer: 'Company B' },
    { _id: mockHistRfq2Id, rfqNo: 'RFQ-2611-099', customer: 'Company Z' },
  ];

  storedQuotes = [
    {
      _id: new mongoose.Types.ObjectId(),
      rfqId: mockHistRfq1Id,
      version: 2,
      costingInputSnapshot: {
        routingOperations: [
          {
            operationName: 'Turning',
            machine: 'Standard CNC Turning',
            cycleTimeMinutes: mongoose.Types.Decimal128.fromString('3.2'),
          },
          {
            operationName: 'Grinding',
            machine: 'Grinding',
            cycleTimeMinutes: mongoose.Types.Decimal128.fromString('1.5'),
          },
        ],
      },
    },
  ];
});

describe('Historical routing suggestions', () => {
  it('retrieves historical routing from Quote snapshot and validates AI selection', async () => {
    const provider: AIProvider = {
      providerName: 'gemini',
      modelName: 'gemini-3.8-flash',
      generateJson: vi.fn().mockResolvedValue(
        JSON.stringify({
          selectedCandidateId: String(mockHistPart1Id),
          reason:
            'Rear wheel spindle uses the same EN8 material and has a nearly identical gross weight (0.61 kg vs 0.64 kg).',
        }),
      ),
    };

    const res = await getRoutingSuggestionForPart(String(mockTargetPartId), provider);
    expect(res.hasSuggestion).toBe(true);
    expect(res.basedOnPartId).toBe(String(mockHistPart1Id));
    expect(res.historicalPartName).toBe('Rear wheel spindle');
    expect(res.historicalRFQNo).toBe('RFQ-2611-014');
    expect(res.historicalQuoteVersion).toBe(2);
    expect(res.suggestedOperations).toEqual([
      { operationName: 'Turning', machine: 'Standard CNC Turning', cycleTimeMinutes: 3.2 },
      { operationName: 'Grinding', machine: 'Grinding', cycleTimeMinutes: 1.5 },
    ]);
  });

  it('rejects an AI selection that is not in the supplied candidate list', async () => {
    const provider: AIProvider = {
      providerName: 'gemini',
      modelName: 'gemini-3.8-flash',
      generateJson: vi.fn().mockResolvedValue(
        JSON.stringify({
          selectedCandidateId: String(new mongoose.Types.ObjectId()),
          reason: 'Hallucinated part id',
        }),
      ),
    };

    await expect(
      getRoutingSuggestionForPart(String(mockTargetPartId), provider),
    ).rejects.toMatchObject({ code: 'AI_INVALID_RESPONSE' });
  });

  it('returns hasSuggestion: false when no historical part shares the material', async () => {
    storedParts[0].material = 'Ti6Al4V';
    const spyGenerate = vi.fn();
    const provider: AIProvider = {
      providerName: 'gemini',
      modelName: 'gemini-3.8-flash',
      generateJson: spyGenerate,
    };

    const res = await getRoutingSuggestionForPart(String(mockTargetPartId), provider);
    expect(res.hasSuggestion).toBe(false);
    expect(res.suggestedOperations).toHaveLength(0);
    expect(spyGenerate).not.toHaveBeenCalled();
  });
});

