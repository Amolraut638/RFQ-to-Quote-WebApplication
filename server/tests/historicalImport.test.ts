/**
 * tests/historicalImport.test.ts
 *
 * Automated tests for Historical Quote Excel Import & 1,400-Row Synthetic Dataset:
 *  1. Complete records imported with deterministic costing engine snapshots.
 *  2. Incomplete records skipped without fabricating missing costing inputs.
 *  3. Duplicate records within the same file detected and skipped.
 *  4. Repeated imports against existing database records skipped idempotently.
 *  5. Historical quotation dates preserved across RFQ, Part, Quote, and rateSnapshot.
 *  6. Snapshot correctness & stated selling price discrepancy preservation/flagging.
 *  7. 1,400-row synthetic dataset import accuracy & performance.
 *  8. Historical Quote Comparison compatibility (isUsableHistoricalSnapshot + search).
 *  9. AI Routing Suggestion compatibility (getRoutingSuggestionForPart).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import * as XLSX from 'xlsx';

vi.mock('../src/models/RFQ', async () => {
  const actual = await vi.importActual<typeof import('../src/models/RFQ')>('../src/models/RFQ');
  return {
    ...actual,
    RFQ: {
      find: vi.fn(),
      findById: vi.fn(),
      insertMany: vi.fn(),
    },
  };
});

vi.mock('../src/models/Part', () => ({
  Part: {
    find: vi.fn(),
    findById: vi.fn(),
    insertMany: vi.fn(),
  },
}));

vi.mock('../src/models/Quote', async () => {
  const actual = await vi.importActual<typeof import('../src/models/Quote')>('../src/models/Quote');
  return {
    ...actual,
    Quote: {
      find: vi.fn(),
      findOne: vi.fn(),
      findById: vi.fn(),
      insertMany: vi.fn(),
    },
  };
});

import { RFQ } from '../src/models/RFQ';
import { Part } from '../src/models/Part';
import { Quote } from '../src/models/Quote';
import {
  importHistoricalQuotesFromBuffer,
  generateHistoricalImportTemplateBuffer,
  generateSynthetic1400HistoricalWorkbookBuffer,
} from '../src/services/historicalImport.service';
import {
  isUsableHistoricalSnapshot,
  searchHistoricalQuotesForPart,
} from '../src/services/historicalQuoteComparison.service';
import { getRoutingSuggestionForPart } from '../src/services/intake/routingSuggestion.service';
import type { AIProvider } from '../src/services/ai/AIProvider';

type Doc = Record<string, any>;

function setupInMemoryCollections() {
  const db = {
    rfqs: [] as Doc[],
    parts: [] as Doc[],
    quotes: [] as Doc[],
  };

  vi.mocked(RFQ.find).mockImplementation(((filter: Doc = {}) => {
    const res = db.rfqs.filter((r) => {
      if (filter.rfqNo?.$in) {
        return filter.rfqNo.$in.includes(r.rfqNo);
      }
      if (filter._id?.$in) {
        const ids = filter._id.$in.map(String);
        return ids.includes(String(r._id));
      }
      return true;
    });
    return {
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue(res),
      }),
      lean: vi.fn().mockResolvedValue(res),
    } as never;
  }) as never);

  vi.mocked(RFQ.findById).mockImplementation(((id: unknown) => {
    const found = db.rfqs.find((r) => String(r._id) === String(id)) ?? null;
    return {
      lean: vi.fn().mockResolvedValue(found),
    } as never;
  }) as never);

  vi.mocked(RFQ.insertMany).mockImplementation((async (docs: Doc[]) => {
    db.rfqs.push(...docs);
    return docs;
  }) as never);

  vi.mocked(Part.find).mockImplementation(((filter: Doc = {}) => {
    const res = db.parts.filter((p) => {
      if (filter.rfqId?.$in) {
        const ids = filter.rfqId.$in.map(String);
        return ids.includes(String(p.rfqId));
      }
      if (filter._id?.$ne) {
        if (String(p._id) === String(filter._id.$ne)) return false;
      }
      if (filter.material instanceof RegExp) {
        if (!filter.material.test(p.material)) return false;
      }
      return true;
    });
    return {
      lean: vi.fn().mockResolvedValue(res),
    } as never;
  }) as never);

  vi.mocked(Part.findById).mockImplementation(((id: unknown) => {
    const found = db.parts.find((p) => String(p._id) === String(id)) ?? null;
    return {
      lean: vi.fn().mockResolvedValue(found),
    } as never;
  }) as never);

  vi.mocked(Part.insertMany).mockImplementation((async (docs: Doc[]) => {
    db.parts.push(...docs);
    return docs;
  }) as never);

  vi.mocked(Quote.find).mockImplementation(((filter: Doc = {}) => {
    const res = db.quotes.filter((q) => {
      if (filter.externalRowKey?.$in) {
        return filter.externalRowKey.$in.includes(q.externalRowKey);
      }
      if (filter.rfqId?.$in) {
        const ids = filter.rfqId.$in.map(String);
        return ids.includes(String(q.rfqId));
      }
      if (filter.status?.$in) {
        return filter.status.$in.includes(q.status);
      }
      return true;
    });
    return {
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue(res),
      }),
      sort: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue(res),
      }),
      lean: vi.fn().mockResolvedValue(res),
    } as never;
  }) as never);

  vi.mocked(Quote.findOne).mockImplementation(((filter: Doc = {}) => {
    const matches = db.quotes.filter((q) => {
      if (filter.rfqId && String(q.rfqId) !== String(filter.rfqId)) return false;
      return true;
    });
    matches.sort((a, b) => b.version - a.version);
    const first = matches[0] ?? null;
    return {
      sort: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue(first),
      }),
    } as never;
  }) as never);

  vi.mocked(Quote.insertMany).mockImplementation((async (docs: Doc[]) => {
    db.quotes.push(...docs);
    return docs;
  }) as never);

  return db;
}

function buildWorkbookBuffer(rows: Array<Record<string, unknown>>): Buffer {
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Quotes');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

const actorId = String(new mongoose.Types.ObjectId());

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Historical Quote Excel Import', () => {
  it('1. Imports complete records and populates deterministic rateSnapshot, costingInputSnapshot, costBreakdown, and 3 volume tiers', async () => {
    const db = setupInMemoryCollections();
    const templateBuffer = generateHistoricalImportTemplateBuffer();

    const summary = await importHistoricalQuotesFromBuffer({
      buffer: templateBuffer,
      actorId,
      dryRun: false,
    });

    expect(summary.totalRowsRead).toBe(2);
    expect(summary.completeRowsCount).toBe(2);
    expect(summary.importedQuotesCount).toBe(2);
    expect(summary.createdRfqsCount).toBe(2);
    expect(summary.createdPartsCount).toBe(2);
    expect(summary.skippedIncompleteCount).toBe(0);
    expect(summary.failedValidationCount).toBe(0);

    expect(db.rfqs).toHaveLength(2);
    expect(db.parts).toHaveLength(2);
    expect(db.quotes).toHaveLength(2);

    const q1 = db.quotes[0];
    expect(q1.importSource).toBe('HISTORICAL_EXCEL');
    expect(q1.isSyntheticDemo).toBe(true);
    expect(q1.status).toBe('SENT');
    expect(q1.volumeTierResults).toHaveLength(3);
    expect(isUsableHistoricalSnapshot(q1)).toBe(true);
  });

  it('2. Skips incomplete records without fabricating missing costing inputs', async () => {
    const db = setupInMemoryCollections();
    const buf = buildWorkbookBuffer([
      {
        'RFQ No': 'RFQ-INC-001',
        Customer: 'Bajaj Auto (SYNTHETIC DEMO DATA)',
        'Quote Date': '2024-04-10',
        'Part Name': 'Incomplete Shaft',
        Material: 'EN8',
        'Gross Weight (kg)': 1.2,
        'Annual Volume': 50000,
        // Missing Material Rate, Overhead %, and Routing Machine/Cycle/Rate
        'Scrap %': 5,
        'Packing & Freight (INR/pc)': 2.0,
        'Setup Cost (INR)': 0.5,
        'Margin %': 15,
        'GST %': 18,
      },
    ]);

    const summary = await importHistoricalQuotesFromBuffer({
      buffer: buf,
      actorId,
      dryRun: false,
    });

    expect(summary.totalRowsRead).toBe(1);
    expect(summary.importedQuotesCount).toBe(0);
    expect(summary.skippedIncompleteCount).toBe(1);
    expect(db.quotes).toHaveLength(0);
    expect(summary.rowIssues[0].status).toBe('SKIPPED_INCOMPLETE');
    expect(summary.rowIssues[0].missingFields).toEqual(
      expect.arrayContaining(['materialRatePerKg', 'overheadPct']),
    );
  });

  it('3. Detects and skips duplicate records within the same file', async () => {
    const db = setupInMemoryCollections();
    const row = {
      'RFQ No': 'RFQ-DUP-101',
      Customer: 'Mahindra Tractor (SYNTHETIC DEMO DATA)',
      'Quote Date': '2024-05-01',
      'Part Name': 'Pinion Blank',
      Material: '20MnCr5',
      'Gross Weight (kg)': 1.5,
      'Annual Volume': 40000,
      'Quote Version': 1,
      'Material Rate (INR/kg)': 82,
      'Scrap %': 5,
      'Overhead %': 150,
      'Packing & Freight (INR/pc)': 3.0,
      'Setup Cost (INR)': 0.5,
      'Margin %': 15,
      'GST %': 18,
      'Op1 Name': 'CNC Turning',
      'Op1 Machine': 'Standard CNC Turning',
      'Op1 Cycle Time (min)': 3.0,
      'Op1 Hour Rate': 850,
    };

    const buf = buildWorkbookBuffer([row, { ...row }]);
    const summary = await importHistoricalQuotesFromBuffer({
      buffer: buf,
      actorId,
      dryRun: false,
    });

    expect(summary.totalRowsRead).toBe(2);
    expect(summary.importedQuotesCount).toBe(1);
    expect(summary.skippedDuplicateInFileCount).toBe(1);
    expect(db.quotes).toHaveLength(1);
  });

  it('4. Handles repeated imports idempotently against existing database records', async () => {
    setupInMemoryCollections();
    const templateBuffer = generateHistoricalImportTemplateBuffer();

    const firstRun = await importHistoricalQuotesFromBuffer({
      buffer: templateBuffer,
      actorId,
      dryRun: false,
    });
    expect(firstRun.importedQuotesCount).toBe(2);

    const secondRun = await importHistoricalQuotesFromBuffer({
      buffer: templateBuffer,
      actorId,
      dryRun: false,
    });
    expect(secondRun.importedQuotesCount).toBe(0);
    expect(secondRun.skippedAlreadyExistsCount).toBe(2);
    expect(secondRun.rowIssues.every((i) => i.status === 'SKIPPED_ALREADY_EXISTS')).toBe(true);
  });

  it('5. Preserves original historical quotation dates and flags stated price discrepancies without overwriting engine breakdown', async () => {
    const db = setupInMemoryCollections();
    const buf = buildWorkbookBuffer([
      {
        'RFQ No': 'RFQ-DATE-2023',
        Customer: 'Endurance Tech Chakan (SYNTHETIC DEMO DATA)',
        'Quote Date': '2023-08-19',
        'Due Date': '2023-09-02',
        'Part Name': 'Wheel Hub Spindle',
        Material: 'EN8',
        'Gross Weight (kg)': 0.61,
        'Annual Volume': 180000,
        'Material Rate (INR/kg)': 52.0,
        'Scrap %': 5,
        'Overhead %': 150,
        'Packing & Freight (INR/pc)': 2.5,
        'Setup Cost (INR)': 0.5,
        'Margin %': 15,
        'GST %': 18,
        'Op1 Name': 'CNC Turning',
        'Op1 Machine': 'Standard CNC Turning',
        'Op1 Cycle Time (min)': 3.2,
        'Op1 Hour Rate': 850,
        'Stated Selling Price Ex-GST': 199.99, // Deliberate discrepancy from calculated price
        'Data Classification': 'SYNTHETIC DEMO DATA',
      },
    ]);

    const summary = await importHistoricalQuotesFromBuffer({
      buffer: buf,
      actorId,
      dryRun: false,
    });

    expect(summary.importedQuotesCount).toBe(1);
    expect(summary.priceDiscrepancyCount).toBe(1);

    const q = db.quotes[0];
    expect(new Date(q.costingDate).toISOString().slice(0, 10)).toBe('2023-08-19');
    expect(new Date(q.rateSnapshot.materialRateEffectiveFrom).toISOString().slice(0, 10)).toBe(
      '2023-08-19',
    );
    expect(q.priceDiscrepancyFlag).toBe(true);
    expect(q.historicalStatedPriceExGst.toString()).toBe('199.99');
    // Engine breakdown remains deterministic and uncorrupted
    expect(Number(q.costBreakdown.sellingPriceExGst)).not.toBe(199.99);
  });

  it('6. Imports the 1,400-row synthetic Chakan automotive dataset with expected classifications and fast batch performance', async () => {
    const db = setupInMemoryCollections();
    const workbookBuffer = generateSynthetic1400HistoricalWorkbookBuffer();

    const summary = await importHistoricalQuotesFromBuffer({
      buffer: workbookBuffer,
      actorId,
      dryRun: false,
    });

    expect(summary.totalRowsRead).toBe(1400);
    expect(summary.completeRowsCount).toBe(1340);
    expect(summary.importedQuotesCount).toBe(1340);
    expect(summary.skippedDuplicateInFileCount).toBe(25);
    expect(summary.skippedIncompleteCount).toBe(25);
    expect(summary.failedValidationCount).toBe(10);
    expect(summary.priceDiscrepancyCount).toBe(25);
    expect(summary.syntheticDemoRowsCount).toBe(1340);
    expect(summary.durationMs).toBeLessThan(5000);
    expect(db.quotes).toHaveLength(1340);
  });

  it('7. Imported quotes integrate seamlessly with Historical Quote Comparison and AI Routing Suggestions', async () => {
    const db = setupInMemoryCollections();
    const templateBuffer = generateHistoricalImportTemplateBuffer();

    await importHistoricalQuotesFromBuffer({
      buffer: templateBuffer,
      actorId,
      dryRun: false,
    });

    // Add a new target part on a new RFQ with similar EN8 material & weight (0.63 kg)
    const targetRfqId = new mongoose.Types.ObjectId();
    const targetPartId = new mongoose.Types.ObjectId();
    db.rfqs.push({
      _id: targetRfqId,
      rfqNo: 'RFQ-NEW-001',
      customer: 'New Customer',
      status: 'ESTIMATING',
    });
    db.parts.push({
      _id: targetPartId,
      rfqId: targetRfqId,
      partName: 'Rear Wheel Spindle New',
      drawingNumber: 'DRG-RWS-101',
      material: 'EN8',
      grossWeightKg: 0.63,
      annualVolume: 150000,
    });

    // A. Verify Historical Quote Comparison finds the imported quote
    const searchRes = await searchHistoricalQuotesForPart({
      partId: String(targetPartId),
    });

    expect(searchRes.matches.length).toBeGreaterThanOrEqual(1);
    const topMatch = searchRes.matches[0];
    expect(topMatch.rfqNo).toBe('RFQ-HIST-2401-001');
    expect(topMatch.importSource).toBe('HISTORICAL_EXCEL');
    expect(topMatch.isSyntheticDemo).toBe(true);

    // B. Verify AI Routing Suggestion discovers the imported part and returns its exact operations
    const importedEn8Part = db.parts.find((p) => p.partName === 'Rear Wheel Spindle')!;
    const fakeAIProvider: AIProvider = {
      providerName: 'test-gemini',
      modelName: 'gemini-flash-test',
      isConfigured: () => true,
      generateJson: vi.fn().mockResolvedValue(
        JSON.stringify({
          selectedCandidateId: String(importedEn8Part._id),
          reason: 'Matches EN8 Rear Wheel Spindle geometry and weight.',
        }),
      ),
    };

    const routingRes = await getRoutingSuggestionForPart(String(targetPartId), fakeAIProvider);
    expect(routingRes.hasSuggestion).toBe(true);
    expect(routingRes.historicalRFQNo).toBe('RFQ-HIST-2401-001');
    expect(routingRes.suggestedOperations).toEqual([
      {
        operationName: 'CNC Rough & Finish Turning',
        machine: 'Standard CNC Turning',
        cycleTimeMinutes: 2.4,
      },
      {
        operationName: 'OD Cylindrical Grinding',
        machine: 'Grinding',
        cycleTimeMinutes: 0.8,
      },
    ]);
  });
});
