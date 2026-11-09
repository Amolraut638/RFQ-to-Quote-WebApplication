/**
 * services/historicalImport.service.ts
 *
 * Deterministic Historical Quote Excel/CSV Importer & Synthetic 1,400-Row Generator.
 *
 * Key Rules:
 *  1. Parses Excel (.xlsx/.xls) and CSV files without the 200-row AI intake cap (up to 5,000 rows).
 *  2. Maps column headers using a deterministic alias dictionary.
 *  3. Validates core RFQ/Part fields with Zod.
 *  4. Classifies rows into:
 *      - COMPLETE (imported with full immutable Quote snapshot via @rfq/costing-engine)
 *      - SKIPPED_INCOMPLETE (missing costing inputs — NEVER fabricates rates or assumptions)
 *      - SKIPPED_DUPLICATE_IN_FILE (duplicate RFQ + Part + Version within the uploaded file)
 *      - SKIPPED_ALREADY_EXISTS (idempotent repeat import — already in MongoDB)
 *      - FAILED_VALIDATION (invalid geometry, negative weight/volume, malformed date, etc.)
 *  5. Preserves original quotation dates, historical material/machine rates, and stated prices.
 *  6. If a row states a historical selling price that differs from the deterministic engine
 *     calculation by >= ₹0.01, preserves `historicalStatedPriceExGst` separately and flags
 *     `priceDiscrepancyFlag = true` without silently overwriting the engine breakdown.
 *  7. Clearly marks synthetic demo records with `isSyntheticDemo = true` and
 *     `SYNTHETIC DEMO DATA` provenance.
 */

import crypto from 'crypto';
import mongoose from 'mongoose';
import * as XLSX from 'xlsx';
import Decimal from 'decimal.js';
import { z } from 'zod';
import { calculateCosting, type CostingInput } from '@rfq/costing-engine';
import { RFQ, LOST_REASONS, type LostReason, type RFQCommercialOutcome } from '../models/RFQ';
import { Part } from '../models/Part';
import {
  Quote,
  type IRateSnapshot,
  type ICostingInputSnapshot,
  type ICostBreakdownSnapshot,
  type IVolumeTierSnapshot,
} from '../models/Quote';

const D = Decimal.clone({
  precision: 40,
  rounding: Decimal.ROUND_HALF_UP,
});

export const MAX_IMPORT_ROWS = 5000;
export const BATCH_INSERT_SIZE = 500;

// ─── Error Handling ───────────────────────────────────────────────────────────

export type HistoricalImportErrorCode =
  | 'EMPTY_FILE'
  | 'MALFORMED_FILE'
  | 'TOO_MANY_ROWS'
  | 'INVALID_USER';

export class HistoricalImportError extends Error {
  public readonly code: HistoricalImportErrorCode;
  public readonly statusCode: number;

  constructor(code: HistoricalImportErrorCode, message: string, statusCode = 400) {
    super(message);
    this.name = 'HistoricalImportError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────

export type ImportRowStatus =
  | 'IMPORTED'
  | 'SKIPPED_INCOMPLETE'
  | 'SKIPPED_DUPLICATE_IN_FILE'
  | 'SKIPPED_ALREADY_EXISTS'
  | 'FAILED_VALIDATION';

export interface ImportRowIssue {
  rowNumber: number;
  rfqNo: string;
  partName: string;
  status: ImportRowStatus | 'PRICE_DISCREPANCY';
  reason: string;
  missingFields?: string[];
  statedPriceExGst?: string;
  calculatedPriceExGst?: string;
  priceDiscrepancyDelta?: string;
}

export interface HistoricalImportSummary {
  dryRun: boolean;
  importBatchId: string;
  totalRowsRead: number;
  completeRowsCount: number;
  importedQuotesCount: number;
  createdRfqsCount: number;
  createdPartsCount: number;
  skippedDuplicateInFileCount: number;
  skippedAlreadyExistsCount: number;
  skippedIncompleteCount: number;
  failedValidationCount: number;
  priceDiscrepancyCount: number;
  syntheticDemoRowsCount: number;
  durationMs: number;
  rowIssues: ImportRowIssue[];
}

export interface CanonicalHistoricalRow {
  rfqNo?: string;
  customer?: string;
  quoteDate?: string | Date;
  dueDate?: string | Date;
  rfqOutcome?: string;
  lostReason?: string;
  partName?: string;
  drawingNumber?: string;
  drawingRevision?: string;
  material?: string;
  grossWeightKg?: number | string;
  annualVolume?: number | string;
  quoteVersion?: number | string;
  materialRatePerKg?: number | string;
  scrapPct?: number | string;
  overheadPct?: number | string;
  packingFreightPerPiece?: number | string;
  setupCostPerPart?: number | string;
  marginPct?: number | string;
  gstPct?: number | string;
  op1Name?: string;
  op1Machine?: string;
  op1CycleTimeMinutes?: number | string;
  op1HourRate?: number | string;
  op2Name?: string;
  op2Machine?: string;
  op2CycleTimeMinutes?: number | string;
  op2HourRate?: number | string;
  op3Name?: string;
  op3Machine?: string;
  op3CycleTimeMinutes?: number | string;
  op3HourRate?: number | string;
  op4Name?: string;
  op4Machine?: string;
  op4CycleTimeMinutes?: number | string;
  op4HourRate?: number | string;
  statedSellingPriceExGst?: number | string;
  dataClassification?: string;
}

// ─── Header Alias Mapping ─────────────────────────────────────────────────────

function normalizeHeaderKey(header: string): string {
  return header
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

const HEADER_ALIAS_MAP: Record<string, keyof CanonicalHistoricalRow> = {
  rfqno: 'rfqNo',
  rfqnumber: 'rfqNo',
  rfqid: 'rfqNo',
  quoteno: 'rfqNo',
  enquiryno: 'rfqNo',

  customer: 'customer',
  customername: 'customer',
  oem: 'customer',
  client: 'customer',

  quotedate: 'quoteDate',
  costingdate: 'quoteDate',
  quotationdate: 'quoteDate',
  receiveddate: 'quoteDate',
  date: 'quoteDate',

  duedate: 'dueDate',
  rfqduedate: 'dueDate',

  status: 'rfqOutcome',
  rfqstatus: 'rfqOutcome',
  outcome: 'rfqOutcome',
  commercialoutcome: 'rfqOutcome',

  lostreason: 'lostReason',

  partname: 'partName',
  partdescription: 'partName',
  part: 'partName',
  component: 'partName',

  drawingno: 'drawingNumber',
  drawingnumber: 'drawingNumber',
  partno: 'drawingNumber',
  partnumber: 'drawingNumber',
  drgno: 'drawingNumber',

  drawingrev: 'drawingRevision',
  drawingrevision: 'drawingRevision',
  revision: 'drawingRevision',
  rev: 'drawingRevision',

  material: 'material',
  materialgrade: 'material',
  grade: 'material',
  rawmaterial: 'material',

  grossweightkg: 'grossWeightKg',
  grossweight: 'grossWeightKg',
  weightkg: 'grossWeightKg',
  partweightkg: 'grossWeightKg',
  grosswtkg: 'grossWeightKg',

  annualvolume: 'annualVolume',
  annualvolumepcs: 'annualVolume',
  annualqty: 'annualVolume',
  volume: 'annualVolume',
  qty: 'annualVolume',

  quoteversion: 'quoteVersion',
  version: 'quoteVersion',

  materialrateperkg: 'materialRatePerKg',
  materialrate: 'materialRatePerKg',
  rmrateperkg: 'materialRatePerKg',
  rmrate: 'materialRatePerKg',
  materialrateinrkg: 'materialRatePerKg',

  scrappct: 'scrapPct',
  scrap: 'scrapPct',
  scrappercentage: 'scrapPct',

  overheadpct: 'overheadPct',
  overhead: 'overheadPct',
  overheadpercentage: 'overheadPct',

  packingfreightperpiece: 'packingFreightPerPiece',
  packingfreight: 'packingFreightPerPiece',
  packingandfreight: 'packingFreightPerPiece',
  packingfreightpc: 'packingFreightPerPiece',
  packingfreightinrpc: 'packingFreightPerPiece',
  packingfreightinr: 'packingFreightPerPiece',

  setupcostperpart: 'setupCostPerPart',
  setupcost: 'setupCostPerPart',
  setupcostinr: 'setupCostPerPart',
  setupcostinrpc: 'setupCostPerPart',
  setup: 'setupCostPerPart',

  marginpct: 'marginPct',
  margin: 'marginPct',
  defaultmarginpct: 'marginPct',
  profitmarginpct: 'marginPct',

  gstpct: 'gstPct',
  gst: 'gstPct',
  taxpct: 'gstPct',

  // Operation 1 (or single-operation columns)
  op1name: 'op1Name',
  operation1name: 'op1Name',
  operationname: 'op1Name',
  operation: 'op1Name',
  op1machine: 'op1Machine',
  operation1machine: 'op1Machine',
  machine: 'op1Machine',
  machinename: 'op1Machine',
  op1cycletimeminutes: 'op1CycleTimeMinutes',
  op1cycletimemin: 'op1CycleTimeMinutes',
  op1cycletime: 'op1CycleTimeMinutes',
  cycletimeminutes: 'op1CycleTimeMinutes',
  cycletimemin: 'op1CycleTimeMinutes',
  cycletime: 'op1CycleTimeMinutes',
  op1hourrate: 'op1HourRate',
  op1machinehourrate: 'op1HourRate',
  machinehourrate: 'op1HourRate',
  hourrate: 'op1HourRate',

  // Operation 2
  op2name: 'op2Name',
  operation2name: 'op2Name',
  op2machine: 'op2Machine',
  operation2machine: 'op2Machine',
  op2cycletimeminutes: 'op2CycleTimeMinutes',
  op2cycletimemin: 'op2CycleTimeMinutes',
  op2cycletime: 'op2CycleTimeMinutes',
  op2hourrate: 'op2HourRate',
  op2machinehourrate: 'op2HourRate',

  // Operation 3
  op3name: 'op3Name',
  operation3name: 'op3Name',
  op3machine: 'op3Machine',
  operation3machine: 'op3Machine',
  op3cycletimeminutes: 'op3CycleTimeMinutes',
  op3cycletimemin: 'op3CycleTimeMinutes',
  op3cycletime: 'op3CycleTimeMinutes',
  op3hourrate: 'op3HourRate',
  op3machinehourrate: 'op3HourRate',

  // Operation 4
  op4name: 'op4Name',
  operation4name: 'op4Name',
  op4machine: 'op4Machine',
  operation4machine: 'op4Machine',
  op4cycletimeminutes: 'op4CycleTimeMinutes',
  op4cycletimemin: 'op4CycleTimeMinutes',
  op4cycletime: 'op4CycleTimeMinutes',
  op4hourrate: 'op4HourRate',
  op4machinehourrate: 'op4HourRate',

  // Stated historical price
  statedsellingpriceexgst: 'statedSellingPriceExGst',
  sellingpriceexgst: 'statedSellingPriceExGst',
  historicalpriceexgst: 'statedSellingPriceExGst',
  quotedpriceexgst: 'statedSellingPriceExGst',
  priceperpieceexgst: 'statedSellingPriceExGst',

  // Provenance / synthetic classification
  dataclassification: 'dataClassification',
  sourcenote: 'dataClassification',
  syntheticdemo: 'dataClassification',
};

// ─── Row-Level Zod Schemas ────────────────────────────────────────────────────

const CoreHistoricalRowSchema = z.object({
  rfqNo: z.string().trim().min(1, 'rfqNo is required'),
  customer: z.string().trim().min(1, 'customer is required'),
  partName: z.string().trim().min(1, 'partName is required'),
  material: z.string().trim().min(1, 'material is required'),
  grossWeightKg: z.number().positive('grossWeightKg must be > 0'),
  annualVolume: z.number().int('annualVolume must be an integer').min(1, 'annualVolume must be >= 1'),
  quoteDate: z.date({ required_error: 'quoteDate is required', invalid_type_error: 'quoteDate is invalid' }),
  dueDate: z.date(),
  quoteVersion: z.number().int().min(1).default(1),
});

const CompleteCostingInputsSchema = z.object({
  materialRatePerKg: z.number().positive('materialRatePerKg must be > 0'),
  scrapPct: z.number().min(0, 'scrapPct must be >= 0').max(99.99, 'scrapPct must be < 100'),
  overheadPct: z.number().min(0, 'overheadPct must be >= 0'),
  packingFreightPerPiece: z.number().min(0, 'packingFreightPerPiece must be >= 0'),
  setupCostPerPart: z.number().min(0, 'setupCostPerPart must be >= 0'),
  marginPct: z.number().min(0, 'marginPct must be >= 0').max(500, 'marginPct must be <= 500'),
  gstPct: z.number().min(0, 'gstPct must be >= 0').max(100, 'gstPct must be <= 100'),
  routingOperations: z
    .array(
      z.object({
        operationName: z.string().trim().min(1),
        machine: z.string().trim().min(1),
        cycleTimeMinutes: z.number().positive(),
        machineHourRate: z.number().positive(),
      }),
    )
    .min(1, 'At least one complete routing operation is required'),
});

// ─── Parsing Helpers ──────────────────────────────────────────────────────────

function parseOptionalNumber(val: unknown): number | undefined {
  if (val === null || val === undefined || val === '') return undefined;
  if (typeof val === 'number') return Number.isFinite(val) ? val : Number.NaN;
  const cleaned = String(val).replace(/[₹,\s%]/g, '').trim();
  if (!cleaned) return undefined;
  const num = Number(cleaned);
  return num;
}

function parseHistoricalDate(val: unknown): Date | undefined {
  if (val === null || val === undefined || val === '') return undefined;
  if (val instanceof Date) {
    return Number.isNaN(val.getTime()) ? undefined : val;
  }
  if (typeof val === 'number') {
    // Excel serial date fallback if cellDates didn't convert
    const parsed = XLSX.SSF.parse_date_code(val);
    if (parsed && parsed.y >= 1990 && parsed.y <= 2100) {
      return new Date(Date.UTC(parsed.y, parsed.m - 1, parsed.d));
    }
  }
  const d = new Date(String(val).trim());
  if (Number.isNaN(d.getTime())) return undefined;
  return d;
}

function d128(val: string | number): mongoose.Types.Decimal128 {
  return mongoose.Types.Decimal128.fromString(String(val));
}

export function buildExternalRowKey(rfqNo: string, partName: string, version: number): string {
  return `${rfqNo.trim().toUpperCase()}::${partName.trim().toUpperCase()}::V${version}`;
}

/**
 * Parse an Excel (.xlsx/.xls) or CSV buffer into canonical row objects.
 * Does NOT impose the 200-row AI intake limit; supports up to MAX_IMPORT_ROWS (5,000).
 */
export function parseHistoricalWorkbookBuffer(
  buffer: Buffer,
): Array<{ rowNumber: number; raw: CanonicalHistoricalRow }> {
  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(buffer, {
      type: 'buffer',
      cellDates: true,
      cellFormula: false,
      cellHTML: false,
      cellStyles: false,
    });
  } catch {
    throw new HistoricalImportError(
      'MALFORMED_FILE',
      'The uploaded Excel/CSV file could not be parsed.',
      400,
    );
  }

  const firstSheetName = wb.SheetNames[0];
  if (!firstSheetName) {
    throw new HistoricalImportError('EMPTY_FILE', 'The workbook contains no sheets.', 400);
  }

  const ws = wb.Sheets[firstSheetName];
  if (!ws || !ws['!ref']) {
    throw new HistoricalImportError('EMPTY_FILE', 'The worksheet is empty.', 400);
  }

  const rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, {
    defval: '',
    raw: true,
  });

  if (rawRows.length === 0) {
    throw new HistoricalImportError(
      'EMPTY_FILE',
      'The worksheet contains headers only and no data rows.',
      400,
    );
  }

  if (rawRows.length > MAX_IMPORT_ROWS) {
    throw new HistoricalImportError(
      'TOO_MANY_ROWS',
      `File contains ${rawRows.length} rows, exceeding the maximum limit of ${MAX_IMPORT_ROWS} rows per import.`,
      400,
    );
  }

  const mappedRows: Array<{ rowNumber: number; raw: CanonicalHistoricalRow }> = [];

  for (let i = 0; i < rawRows.length; i++) {
    const rowObj = rawRows[i];
    const canonical: CanonicalHistoricalRow = {};
    let hasAnyValue = false;

    for (const [rawHeader, cellValue] of Object.entries(rowObj)) {
      if (cellValue !== '' && cellValue !== null && cellValue !== undefined) {
        hasAnyValue = true;
      }
      const normKey = normalizeHeaderKey(rawHeader);
      const targetProp = HEADER_ALIAS_MAP[normKey];
      if (targetProp && cellValue !== '' && cellValue !== null && cellValue !== undefined) {
        (canonical as Record<string, unknown>)[targetProp] = cellValue;
      }
    }

    if (!hasAnyValue) continue;
    mappedRows.push({
      rowNumber: i + 2, // Row 1 is header
      raw: canonical,
    });
  }

  if (mappedRows.length === 0) {
    throw new HistoricalImportError('EMPTY_FILE', 'No non-empty rows found in workbook.', 400);
  }

  return mappedRows;
}

// ─── Main Deterministic Import Processor ──────────────────────────────────────

export async function importHistoricalQuotesFromBuffer(params: {
  buffer: Buffer;
  actorId: string;
  dryRun?: boolean;
}): Promise<HistoricalImportSummary> {
  const startTime = Date.now();
  const { buffer, actorId, dryRun = false } = params;

  if (!mongoose.Types.ObjectId.isValid(actorId)) {
    throw new HistoricalImportError('INVALID_USER', `Invalid actorId: "${actorId}"`, 400);
  }
  const actorObjectId = new mongoose.Types.ObjectId(actorId);
  const importBatchId = `HIST-${new Date().toISOString().slice(0, 10)}-${crypto
    .randomBytes(4)
    .toString('hex')
    .toUpperCase()}`;

  const parsedRows = parseHistoricalWorkbookBuffer(buffer);

  // Pre-collect all candidate rfqNos and externalRowKeys to query DB in one batch
  const candidateRfqNos = new Set<string>();
  const candidateRowKeys = new Set<string>();

  for (const { raw } of parsedRows) {
    const rfqNo = String(raw.rfqNo ?? '').trim();
    const partName = String(raw.partName ?? '').trim();
    const version = parseOptionalNumber(raw.quoteVersion) ?? 1;
    if (rfqNo) candidateRfqNos.add(rfqNo);
    if (rfqNo && partName) {
      candidateRowKeys.add(buildExternalRowKey(rfqNo, partName, version));
    }
  }

  const [existingRfqs, existingQuotes] = await Promise.all([
    RFQ.find({ rfqNo: { $in: Array.from(candidateRfqNos) } })
      .select('_id rfqNo')
      .lean(),
    Quote.find({ externalRowKey: { $in: Array.from(candidateRowKeys) } })
      .select('_id externalRowKey rfqId version')
      .lean(),
  ]);

  const rfqIdByRfqNo = new Map<string, mongoose.Types.ObjectId>();
  for (const r of existingRfqs) {
    rfqIdByRfqNo.set(r.rfqNo.trim().toUpperCase(), new mongoose.Types.ObjectId(String(r._id)));
  }

  const existingQuoteRowKeys = new Set<string>();
  for (const q of existingQuotes) {
    if (q.externalRowKey) {
      existingQuoteRowKeys.add(q.externalRowKey);
    }
  }

  // Track highest version per RFQ in memory so multi-part or multi-version rows on the same RFQ get distinct versions
  const existingQuotesForCandidateRfqs = await Quote.find({
    rfqId: { $in: Array.from(rfqIdByRfqNo.values()) },
  })
    .select('rfqId version')
    .lean();

  const maxVersionByRfqId = new Map<string, number>();
  for (const q of existingQuotesForCandidateRfqs) {
    const k = String(q.rfqId);
    const cur = maxVersionByRfqId.get(k) ?? 0;
    if (q.version > cur) maxVersionByRfqId.set(k, q.version);
  }

  const seenRowKeysInFile = new Set<string>();
  const rowIssues: ImportRowIssue[] = [];

  const rfqsToInsert: Array<Record<string, unknown>> = [];
  const partsToInsert: Array<Record<string, unknown>> = [];
  const quotesToInsert: Array<Record<string, unknown>> = [];

  let completeRowsCount = 0;
  let skippedDuplicateInFileCount = 0;
  let skippedAlreadyExistsCount = 0;
  let skippedIncompleteCount = 0;
  let failedValidationCount = 0;
  let priceDiscrepancyCount = 0;
  let syntheticDemoRowsCount = 0;

  for (const { rowNumber, raw } of parsedRows) {
    const rfqNoStr = String(raw.rfqNo ?? '').trim();
    const partNameStr = String(raw.partName ?? '').trim();
    const customerStr = String(raw.customer ?? '').trim();
    const materialStr = String(raw.material ?? '').trim();
    const grossWeightVal = parseOptionalNumber(raw.grossWeightKg);
    const annualVolumeVal = parseOptionalNumber(raw.annualVolume);
    const quoteVersionVal = parseOptionalNumber(raw.quoteVersion) ?? 1;
    const quoteDateVal = parseHistoricalDate(raw.quoteDate);
    const dueDateVal =
      parseHistoricalDate(raw.dueDate) ??
      (quoteDateVal ? new Date(quoteDateVal.getTime() + 14 * 86_400_000) : undefined);

    // 1. Validate Core Identity & Geometry Fields
    const coreValidation = CoreHistoricalRowSchema.safeParse({
      rfqNo: rfqNoStr,
      customer: customerStr,
      partName: partNameStr,
      material: materialStr,
      grossWeightKg: grossWeightVal,
      annualVolume: annualVolumeVal,
      quoteDate: quoteDateVal,
      dueDate: dueDateVal,
      quoteVersion: quoteVersionVal,
    });

    if (!coreValidation.success) {
      failedValidationCount++;
      const msg = coreValidation.error.issues
        .map((iss) => `${iss.path.join('.') || 'row'}: ${iss.message}`)
        .join('; ');
      rowIssues.push({
        rowNumber,
        rfqNo: rfqNoStr || '(missing)',
        partName: partNameStr || '(missing)',
        status: 'FAILED_VALIDATION',
        reason: msg,
      });
      continue;
    }

    const core = coreValidation.data;
    const rowKey = buildExternalRowKey(core.rfqNo, core.partName, core.quoteVersion);

    // 2. Intra-file Duplicate Check
    if (seenRowKeysInFile.has(rowKey)) {
      skippedDuplicateInFileCount++;
      rowIssues.push({
        rowNumber,
        rfqNo: core.rfqNo,
        partName: core.partName,
        status: 'SKIPPED_DUPLICATE_IN_FILE',
        reason: `Duplicate row in file for ${core.rfqNo} / ${core.partName} (v${core.quoteVersion}).`,
      });
      continue;
    }
    seenRowKeysInFile.add(rowKey);

    // 3. Database Repeat-Import Check (Idempotency)
    if (existingQuoteRowKeys.has(rowKey)) {
      skippedAlreadyExistsCount++;
      rowIssues.push({
        rowNumber,
        rfqNo: core.rfqNo,
        partName: core.partName,
        status: 'SKIPPED_ALREADY_EXISTS',
        reason: `Historical quote ${core.rfqNo} / ${core.partName} (v${core.quoteVersion}) is already imported.`,
      });
      continue;
    }

    // 4. Check for Missing Costing Inputs (NEVER fabricate missing costing data!)
    const matRateVal = parseOptionalNumber(raw.materialRatePerKg);
    const scrapPctVal = parseOptionalNumber(raw.scrapPct);
    const overheadPctVal = parseOptionalNumber(raw.overheadPct);
    const packingVal = parseOptionalNumber(raw.packingFreightPerPiece);
    const setupVal = parseOptionalNumber(raw.setupCostPerPart);
    const marginPctVal = parseOptionalNumber(raw.marginPct);
    const gstPctVal = parseOptionalNumber(raw.gstPct);

    // Extract routing operations (up to 4 operation column groups)
    const rawOps: Array<{
      operationName: string;
      machine: string;
      cycleTimeMinutes: number;
      machineHourRate: number;
    }> = [];

    const opGroups = [
      {
        name: raw.op1Name,
        machine: raw.op1Machine,
        cycle: raw.op1CycleTimeMinutes,
        rate: raw.op1HourRate,
      },
      {
        name: raw.op2Name,
        machine: raw.op2Machine,
        cycle: raw.op2CycleTimeMinutes,
        rate: raw.op2HourRate,
      },
      {
        name: raw.op3Name,
        machine: raw.op3Machine,
        cycle: raw.op3CycleTimeMinutes,
        rate: raw.op3HourRate,
      },
      {
        name: raw.op4Name,
        machine: raw.op4Machine,
        cycle: raw.op4CycleTimeMinutes,
        rate: raw.op4HourRate,
      },
    ];

    for (let idx = 0; idx < opGroups.length; idx++) {
      const g = opGroups[idx];
      const machineStr = String(g.machine ?? '').trim();
      const opNameStr = String(g.name ?? '').trim() || (machineStr ? `OP${idx + 10} ${machineStr}` : '');
      const cycleNum = parseOptionalNumber(g.cycle);
      const rateNum = parseOptionalNumber(g.rate);

      if (machineStr || cycleNum !== undefined || rateNum !== undefined) {
        if (
          machineStr &&
          opNameStr &&
          cycleNum !== undefined &&
          Number.isFinite(cycleNum) &&
          cycleNum > 0 &&
          rateNum !== undefined &&
          Number.isFinite(rateNum) &&
          rateNum > 0
        ) {
          rawOps.push({
            operationName: opNameStr,
            machine: machineStr,
            cycleTimeMinutes: cycleNum,
            machineHourRate: rateNum,
          });
        }
      }
    }

    const missingFields: string[] = [];
    if (matRateVal === undefined) missingFields.push('materialRatePerKg');
    if (scrapPctVal === undefined) missingFields.push('scrapPct');
    if (overheadPctVal === undefined) missingFields.push('overheadPct');
    if (packingVal === undefined) missingFields.push('packingFreightPerPiece');
    if (setupVal === undefined) missingFields.push('setupCostPerPart');
    if (marginPctVal === undefined) missingFields.push('marginPct');
    if (gstPctVal === undefined) missingFields.push('gstPct');
    if (rawOps.length === 0) {
      missingFields.push('routingOperations (machine, cycleTimeMinutes, machineHourRate)');
    }

    if (missingFields.length > 0) {
      skippedIncompleteCount++;
      rowIssues.push({
        rowNumber,
        rfqNo: core.rfqNo,
        partName: core.partName,
        status: 'SKIPPED_INCOMPLETE',
        reason: `Incomplete costing inputs — skipped to avoid fabricating missing rates: ${missingFields.join(', ')}`,
        missingFields,
      });
      continue;
    }

    // 5. Validate Costing Inputs with Zod
    const costingValidation = CompleteCostingInputsSchema.safeParse({
      materialRatePerKg: matRateVal,
      scrapPct: scrapPctVal,
      overheadPct: overheadPctVal,
      packingFreightPerPiece: packingVal,
      setupCostPerPart: setupVal,
      marginPct: marginPctVal,
      gstPct: gstPctVal,
      routingOperations: rawOps,
    });

    if (!costingValidation.success) {
      failedValidationCount++;
      const msg = costingValidation.error.issues
        .map((iss) => `${iss.path.join('.')}: ${iss.message}`)
        .join('; ');
      rowIssues.push({
        rowNumber,
        rfqNo: core.rfqNo,
        partName: core.partName,
        status: 'FAILED_VALIDATION',
        reason: msg,
      });
      continue;
    }

    const validCosting = costingValidation.data;

    // 6. Run Deterministic Costing Engine
    const engineInput: CostingInput = {
      grossWeightKg: core.grossWeightKg,
      materialRatePerKg: String(validCosting.materialRatePerKg),
      scrapPct: validCosting.scrapPct,
      routingOperations: validCosting.routingOperations.map((op) => ({
        operationName: op.operationName,
        machine: op.machine,
        cycleTimeMinutes: op.cycleTimeMinutes,
        machineHourRate: String(op.machineHourRate),
      })),
      overheadPct: validCosting.overheadPct,
      packingFreightPerPiece: String(validCosting.packingFreightPerPiece),
      setupCostPerPart: String(validCosting.setupCostPerPart),
      annualVolume: core.annualVolume,
      defaultMarginPct: validCosting.marginPct,
      gstPct: validCosting.gstPct,
    };

    const costingResult = calculateCosting(engineInput);

    // 7. Check for Stated Selling Price Discrepancy
    const statedPriceVal = parseOptionalNumber(raw.statedSellingPriceExGst);
    let historicalStatedPriceExGst: mongoose.Types.Decimal128 | undefined;
    let priceDiscrepancyFlag = false;
    let priceDiscrepancyDelta: mongoose.Types.Decimal128 | undefined;

    if (statedPriceVal !== undefined && Number.isFinite(statedPriceVal) && statedPriceVal > 0) {
      const statedDec = new D(statedPriceVal).toDecimalPlaces(2);
      const calcDec = new D(costingResult.breakdown.sellingPriceExGst).toDecimalPlaces(2);
      const deltaDec = statedDec.minus(calcDec);
      historicalStatedPriceExGst = d128(statedDec.toFixed(2));

      if (deltaDec.abs().greaterThanOrEqualTo('0.01')) {
        priceDiscrepancyFlag = true;
        priceDiscrepancyDelta = d128(deltaDec.toFixed(2));
        priceDiscrepancyCount++;
        rowIssues.push({
          rowNumber,
          rfqNo: core.rfqNo,
          partName: core.partName,
          status: 'PRICE_DISCREPANCY',
          reason: `Spreadsheet stated price (₹${statedDec.toFixed(2)}) differs from deterministic calculation (₹${calcDec.toFixed(2)}) by ₹${deltaDec.toFixed(2)}. Both values preserved.`,
          statedPriceExGst: statedDec.toFixed(2),
          calculatedPriceExGst: calcDec.toFixed(2),
          priceDiscrepancyDelta: deltaDec.toFixed(2),
        });
      }
    }

    // 8. Provenance & Synthetic Demo Flag
    const classificationText = String(raw.dataClassification ?? '').toUpperCase();
    const isSyntheticDemo =
      classificationText.includes('SYNTHETIC') ||
      classificationText.includes('DEMO') ||
      core.customer.toUpperCase().includes('SYNTHETIC');
    if (isSyntheticDemo) {
      syntheticDemoRowsCount++;
    }

    // 9. Resolve or Allocate RFQ Document
    const normRfqNo = core.rfqNo.toUpperCase();
    let rfqObjectId = rfqIdByRfqNo.get(normRfqNo);
    if (!rfqObjectId) {
      rfqObjectId = new mongoose.Types.ObjectId();
      rfqIdByRfqNo.set(normRfqNo, rfqObjectId);

      const rawOutcome = String(raw.rfqOutcome ?? 'SENT')
        .trim()
        .toUpperCase();
      const status: RFQCommercialOutcome =
        rawOutcome === 'WON' || rawOutcome === 'LOST' || rawOutcome === 'SENT'
          ? (rawOutcome as RFQCommercialOutcome)
          : 'SENT';

      const rawLostReason = String(raw.lostReason ?? '')
        .trim()
        .toUpperCase() as LostReason;
      const validLostReason =
        status === 'LOST' && LOST_REASONS.includes(rawLostReason)
          ? rawLostReason
          : status === 'LOST'
          ? 'PRICE_TOO_HIGH'
          : undefined;

      rfqsToInsert.push({
        _id: rfqObjectId,
        rfqNo: core.rfqNo,
        customer: core.customer,
        receivedDate: core.quoteDate,
        dueDate: core.dueDate,
        ownerId: actorObjectId,
        status,
        ...(validLostReason ? { lostReason: validLostReason } : {}),
        ...(status === 'WON' || status === 'LOST' || status === 'SENT'
          ? { outcomeUpdatedBy: actorObjectId, outcomeUpdatedAt: core.quoteDate }
          : {}),
        importSource: 'HISTORICAL_EXCEL',
        importBatchId,
        isSyntheticDemo,
        createdAt: core.quoteDate,
        updatedAt: core.quoteDate,
      });
    }

    // 10. Allocate Part Document
    const partObjectId = new mongoose.Types.ObjectId();
    const totalCycleTime = validCosting.routingOperations.reduce(
      (sum, op) => sum + op.cycleTimeMinutes,
      0,
    );
    partsToInsert.push({
      _id: partObjectId,
      rfqId: rfqObjectId,
      partName: core.partName,
      material: core.material,
      grossWeightKg: core.grossWeightKg,
      annualVolume: core.annualVolume,
      cycleTimeMinutes: Number(totalCycleTime.toFixed(2)),
      machineHourRateRef: d128(validCosting.routingOperations[0].machineHourRate),
      ...(raw.drawingNumber ? { drawingNumber: String(raw.drawingNumber).trim() } : {}),
      ...(raw.drawingRevision ? { drawingRevision: String(raw.drawingRevision).trim() } : {}),
      createdAt: core.quoteDate,
      updatedAt: core.quoteDate,
    });

    // 11. Build Frozen Snapshots & Allocate Quote Document
    const rfqKeyStr = String(rfqObjectId);
    const currentMaxVer = maxVersionByRfqId.get(rfqKeyStr) ?? 0;
    const assignedVersion = Math.max(core.quoteVersion, currentMaxVer + 1);
    maxVersionByRfqId.set(rfqKeyStr, assignedVersion);

    const rateSnapshot: IRateSnapshot = {
      material: core.material,
      materialRatePerKg: d128(validCosting.materialRatePerKg),
      materialRateEffectiveFrom: core.quoteDate,
      operations: validCosting.routingOperations.map((op) => ({
        operationName: op.operationName,
        machine: op.machine,
        cycleTimeMinutes: d128(op.cycleTimeMinutes),
        machineHourRate: d128(op.machineHourRate),
        machineRateEffectiveFrom: core.quoteDate,
      })),
      scrapPct: validCosting.scrapPct,
      overheadPct: validCosting.overheadPct,
      packingFreight: d128(validCosting.packingFreightPerPiece),
      marginPct: validCosting.marginPct,
      gstPct: validCosting.gstPct,
      setupCostPerPart: d128(validCosting.setupCostPerPart),
      rateSettingEffectiveFrom: core.quoteDate,
      snapshotCreatedAt: core.quoteDate,
    };

    const costingInputSnapshot: ICostingInputSnapshot = {
      grossWeightKg: d128(core.grossWeightKg),
      materialRatePerKg: d128(validCosting.materialRatePerKg),
      scrapPct: validCosting.scrapPct,
      routingOperations: validCosting.routingOperations.map((op) => ({
        operationName: op.operationName,
        machine: op.machine,
        cycleTimeMinutes: d128(op.cycleTimeMinutes),
        machineHourRate: d128(op.machineHourRate),
      })),
      overheadPct: validCosting.overheadPct,
      packingFreightPerPiece: d128(validCosting.packingFreightPerPiece),
      setupCostPerPart: d128(validCosting.setupCostPerPart),
      annualVolume: core.annualVolume,
      defaultMarginPct: validCosting.marginPct,
      gstPct: validCosting.gstPct,
    };

    const costBreakdown: ICostBreakdownSnapshot = {
      ...costingResult.breakdown,
    };

    const volumeTierResults: IVolumeTierSnapshot[] = costingResult.volumeTiers.map((t) => ({
      ...t,
    }));

    quotesToInsert.push({
      _id: new mongoose.Types.ObjectId(),
      rfqId: rfqObjectId,
      partId: partObjectId,
      version: assignedVersion,
      status: 'SENT',
      totalAnnualValue: d128(costingResult.annualQuotationValue),
      costingDate: core.quoteDate,
      createdBy: actorObjectId,
      sentBy: actorObjectId,
      sentAt: core.quoteDate,
      rateSnapshot,
      costingInputSnapshot,
      costBreakdown,
      volumeTierResults,
      annualQuotationValue: costingResult.annualQuotationValue,
      importSource: 'HISTORICAL_EXCEL',
      importBatchId,
      externalRowKey: rowKey,
      isSyntheticDemo,
      ...(historicalStatedPriceExGst ? { historicalStatedPriceExGst } : {}),
      ...(priceDiscrepancyFlag
        ? {
            priceDiscrepancyFlag: true,
            priceDiscrepancyDelta,
          }
        : {}),
      createdAt: core.quoteDate,
      updatedAt: core.quoteDate,
    });

    completeRowsCount++;
  }

  // 12. Batch Write to MongoDB if dryRun === false
  if (!dryRun && quotesToInsert.length > 0) {
    for (let i = 0; i < rfqsToInsert.length; i += BATCH_INSERT_SIZE) {
      await RFQ.insertMany(rfqsToInsert.slice(i, i + BATCH_INSERT_SIZE), { ordered: false });
    }
    for (let i = 0; i < partsToInsert.length; i += BATCH_INSERT_SIZE) {
      await Part.insertMany(partsToInsert.slice(i, i + BATCH_INSERT_SIZE), { ordered: false });
    }
    for (let i = 0; i < quotesToInsert.length; i += BATCH_INSERT_SIZE) {
      await Quote.insertMany(quotesToInsert.slice(i, i + BATCH_INSERT_SIZE), { ordered: false });
    }
  }

  return {
    dryRun,
    importBatchId,
    totalRowsRead: parsedRows.length,
    completeRowsCount,
    importedQuotesCount: dryRun ? 0 : quotesToInsert.length,
    createdRfqsCount: dryRun ? rfqsToInsert.length : rfqsToInsert.length,
    createdPartsCount: dryRun ? partsToInsert.length : partsToInsert.length,
    skippedDuplicateInFileCount,
    skippedAlreadyExistsCount,
    skippedIncompleteCount,
    failedValidationCount,
    priceDiscrepancyCount,
    syntheticDemoRowsCount,
    durationMs: Date.now() - startTime,
    rowIssues,
  };
}

// ─── Excel Template & 1,400-Row Synthetic Chakan Dataset Generator ────────────

export function generateHistoricalImportTemplateBuffer(): Buffer {
  const sampleRows = [
    {
      'RFQ No': 'RFQ-HIST-2401-001',
      Customer: 'Bajaj Auto Tier-1 Chakan (SYNTHETIC DEMO DATA)',
      'Quote Date': '2024-03-15',
      'Due Date': '2024-03-29',
      Outcome: 'WON',
      'Lost Reason': '',
      'Part Name': 'Rear Wheel Spindle',
      'Drawing No': 'DRG-RWS-101',
      'Drawing Rev': 'A',
      Material: 'EN8',
      'Gross Weight (kg)': 0.61,
      'Annual Volume': 180000,
      'Quote Version': 1,
      'Material Rate (INR/kg)': 52.0,
      'Scrap %': 5,
      'Overhead %': 150,
      'Packing & Freight (INR/pc)': 2.5,
      'Setup Cost (INR)': 0.5,
      'Margin %': 15,
      'GST %': 18,
      'Op1 Name': 'CNC Rough & Finish Turning',
      'Op1 Machine': 'Standard CNC Turning',
      'Op1 Cycle Time (min)': 2.4,
      'Op1 Hour Rate': 850,
      'Op2 Name': 'OD Cylindrical Grinding',
      'Op2 Machine': 'Grinding',
      'Op2 Cycle Time (min)': 0.8,
      'Op2 Hour Rate': 750,
      'Stated Selling Price Ex-GST': '',
      'Data Classification': 'SYNTHETIC DEMO DATA',
    },
    {
      'RFQ No': 'RFQ-HIST-2402-002',
      Customer: 'Mahindra Tractor Division (SYNTHETIC DEMO DATA)',
      'Quote Date': '2024-06-10',
      'Due Date': '2024-06-24',
      Outcome: 'LOST',
      'Lost Reason': 'PRICE_TOO_HIGH',
      'Part Name': 'Hydraulic Lift Arm',
      'Drawing No': 'DRG-HLA-204',
      'Drawing Rev': 'B',
      Material: '40Cr4',
      'Gross Weight (kg)': 4.6,
      'Annual Volume': 24000,
      'Quote Version': 1,
      'Material Rate (INR/kg)': 78.0,
      'Scrap %': 5,
      'Overhead %': 150,
      'Packing & Freight (INR/pc)': 6.0,
      'Setup Cost (INR)': 1.5,
      'Margin %': 15,
      'GST %': 18,
      'Op1 Name': 'Heavy Turning & Boring',
      'Op1 Machine': 'Heavy CNC Machining',
      'Op1 Cycle Time (min)': 8.5,
      'Op1 Hour Rate': 1450,
      'Op2 Name': 'Spline & Keyway Milling',
      'Op2 Machine': 'VMC Milling',
      'Op2 Cycle Time (min)': 3.0,
      'Op2 Hour Rate': 950,
      'Stated Selling Price Ex-GST': '',
      'Data Classification': 'SYNTHETIC DEMO DATA',
    },
  ];

  const ws = XLSX.utils.json_to_sheet(sampleRows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Historical_Quotes_Template');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

/**
 * Generates a deterministic 1,400-row synthetic historical dataset representing a
 * Chakan, Pune automotive component manufacturer across 2023–2026:
 *  - 1,340 Complete rows (including 25 rows with intentional stated-price discrepancies)
 *  - 25 Duplicate rows in file (to test intra-file duplicate detection)
 *  - 25 Incomplete rows (missing material rate, machine hour rate, or overhead — to prove
 *    the importer never fabricates missing costing inputs)
 *  - 10 Invalid rows (negative weight, zero volume, or blank customer — to test Zod validation)
 *
 * Every row is explicitly tagged with "SYNTHETIC DEMO DATA".
 */
export function generateSynthetic1400HistoricalRows(): Array<Record<string, unknown>> {
  const customers = [
    'Bajaj Auto 2W Chakan (SYNTHETIC DEMO DATA)',
    'TVS Motor 2W Division (SYNTHETIC DEMO DATA)',
    'Mahindra Tractor Farm Division (SYNTHETIC DEMO DATA)',
    'John Deere Pune Tractor Works (SYNTHETIC DEMO DATA)',
    'Endurance Technologies Tier-1 Chakan (SYNTHETIC DEMO DATA)',
    'Bharat Forge Chassis Tier-1 (SYNTHETIC DEMO DATA)',
    'ZF India Chakan Tier-1 (SYNTHETIC DEMO DATA)',
    'Dana Anand Drivetrain Chakan (SYNTHETIC DEMO DATA)',
  ];

  const partArchetypes = [
    {
      name: 'Rear Wheel Spindle',
      drgPrefix: 'DRG-2W-RWS',
      material: 'EN8',
      baseWeightKg: 0.61,
      baseVolume: 180000,
      op1: { name: 'CNC Turning', machine: 'Standard CNC Turning', cycle: 2.2, baseRate: 850 },
      op2: { name: 'Centerless Grinding', machine: 'Grinding', cycle: 1.0, baseRate: 750 },
    },
    {
      name: 'Transmission Pinion Shaft',
      drgPrefix: 'DRG-2W-TPS',
      material: '20MnCr5',
      baseWeightKg: 0.95,
      baseVolume: 120000,
      op1: { name: 'CNC Turning & Grooving', machine: 'Standard CNC Turning', cycle: 3.1, baseRate: 850 },
      op2: { name: 'Profile Milling', machine: 'VMC Milling', cycle: 1.8, baseRate: 950 },
    },
    {
      name: 'Hydraulic Lift Arm',
      drgPrefix: 'DRG-TR-HLA',
      material: '40Cr4',
      baseWeightKg: 4.6,
      baseVolume: 24000,
      op1: { name: 'Heavy CNC Turning', machine: 'Heavy CNC Machining', cycle: 7.5, baseRate: 1450 },
      op2: { name: 'Cross Hole & Slot Milling', machine: 'VMC Milling', cycle: 4.0, baseRate: 950 },
    },
    {
      name: 'Crown Wheel Blank',
      drgPrefix: 'DRG-TR-CWB',
      material: 'EN353',
      baseWeightKg: 5.8,
      baseVolume: 18000,
      op1: { name: 'Heavy Face & Bore Turning', machine: 'Heavy CNC Machining', cycle: 9.2, baseRate: 1450 },
      op2: { name: 'Surface Finish Grinding', machine: 'Grinding', cycle: 2.5, baseRate: 750 },
    },
    {
      name: 'Differential Bevel Gear Blank',
      drgPrefix: 'DRG-T1-DBG',
      material: '20MnCr5',
      baseWeightKg: 1.48,
      baseVolume: 60000,
      op1: { name: 'CNC Blank Turning', machine: 'Standard CNC Turning', cycle: 3.0, baseRate: 850 },
      op2: { name: 'VMC Pocket Milling', machine: 'VMC Milling', cycle: 1.8, baseRate: 950 },
    },
    {
      name: 'Front Axle Stub Spindle',
      drgPrefix: 'DRG-TR-FAS',
      material: '40Cr4',
      baseWeightKg: 3.25,
      baseVolume: 35000,
      op1: { name: 'Heavy Turning', machine: 'Heavy CNC Machining', cycle: 6.4, baseRate: 1450 },
      op2: { name: 'Bearing Journal Grinding', machine: 'Grinding', cycle: 2.1, baseRate: 750 },
    },
    {
      name: 'Primary Clutch Hub',
      drgPrefix: 'DRG-2W-PCH',
      material: 'EN8',
      baseWeightKg: 0.78,
      baseVolume: 150000,
      op1: { name: 'CNC Turning', machine: 'Standard CNC Turning', cycle: 2.6, baseRate: 850 },
      op2: { name: 'Spline Broach & Mill', machine: 'VMC Milling', cycle: 1.5, baseRate: 950 },
    },
    {
      name: 'PTO Output Shaft',
      drgPrefix: 'DRG-TR-PTO',
      material: 'EN353',
      baseWeightKg: 4.15,
      baseVolume: 20000,
      op1: { name: 'Heavy Shaft Turning', machine: 'Heavy CNC Machining', cycle: 8.0, baseRate: 1450 },
      op2: { name: 'OD Cylindrical Grinding', machine: 'Grinding', cycle: 2.8, baseRate: 750 },
    },
  ];

  // Historical periods across 2023–2025 with period-specific material rate inflation
  const periods = [
    { code: '23Q1', datePrefix: '2023-02', rateFactor: 0.94 },
    { code: '23Q3', datePrefix: '2023-08', rateFactor: 0.97 },
    { code: '24Q1', datePrefix: '2024-02', rateFactor: 1.0 },
    { code: '24Q3', datePrefix: '2024-08', rateFactor: 1.04 },
    { code: '25Q1', datePrefix: '2025-02', rateFactor: 1.08 },
    { code: '25Q3', datePrefix: '2025-08', rateFactor: 1.11 },
  ];

  const baseMaterialRates: Record<string, number> = {
    EN8: 52.0,
    '20MnCr5': 82.0,
    '40Cr4': 78.0,
    EN353: 95.0,
  };

  const rows: Array<Record<string, unknown>> = [];

  // 1. Generate 1,340 Complete Rows
  for (let i = 1; i <= 1340; i++) {
    const cust = customers[i % customers.length];
    const arch = partArchetypes[i % partArchetypes.length];
    const period = periods[i % periods.length];

    const day = String(((i * 3) % 26) + 1).padStart(2, '0');
    const quoteDate = `${period.datePrefix}-${day}`;
    const dueDate = `${period.datePrefix}-28`;

    const weightVariance = 1 + (((i * 7) % 21) - 10) * 0.015; // -15% to +15%
    const grossWeightKg = Number((arch.baseWeightKg * weightVariance).toFixed(3));
    const volumeVariance = 1 + (((i * 5) % 9) - 4) * 0.1; // -40% to +40%
    const annualVolume = Math.max(2000, Math.round((arch.baseVolume * volumeVariance) / 1000) * 1000);

    const materialRate = Number(
      (baseMaterialRates[arch.material] * period.rateFactor).toFixed(2),
    );
    const op1Cycle = Number((arch.op1.cycle * (1 + ((i % 5) - 2) * 0.04)).toFixed(2));
    const op2Cycle = Number((arch.op2.cycle * (1 + ((i % 3) - 1) * 0.05)).toFixed(2));
    const op1Rate = Number((arch.op1.baseRate * period.rateFactor).toFixed(2));
    const op2Rate = Number((arch.op2.baseRate * period.rateFactor).toFixed(2));

    const scrapPct = 4 + (i % 4); // 4% to 7%
    const overheadPct = 140 + (i % 3) * 10; // 140%, 150%, 160%
    const packingFreight = Number((2.0 + (i % 5) * 0.75).toFixed(2));
    const setupCost = Number((0.5 + (i % 4) * 0.25).toFixed(2));
    const marginPct = 12 + (i % 6); // 12% to 17%
    const gstPct = 18;

    const outcomes = ['SENT', 'WON', 'LOST'] as const;
    const outcome = outcomes[i % 3];
    const lostReason = outcome === 'LOST' ? LOST_REASONS[i % 5] : '';

    // For rows 1..25, include a stated selling price with a deliberate ₹3.50 commercial rounding discrepancy
    let statedSellingPriceExGst: string | number = '';
    if (i <= 25) {
      const calc = calculateCosting({
        grossWeightKg,
        materialRatePerKg: String(materialRate),
        scrapPct,
        routingOperations: [
          {
            operationName: arch.op1.name,
            machine: arch.op1.machine,
            cycleTimeMinutes: op1Cycle,
            machineHourRate: String(op1Rate),
          },
          {
            operationName: arch.op2.name,
            machine: arch.op2.machine,
            cycleTimeMinutes: op2Cycle,
            machineHourRate: String(op2Rate),
          },
        ],
        overheadPct,
        packingFreightPerPiece: String(packingFreight),
        setupCostPerPart: String(setupCost),
        annualVolume,
        defaultMarginPct: marginPct,
        gstPct,
      });
      statedSellingPriceExGst = new D(calc.breakdown.sellingPriceExGst)
        .plus('3.50')
        .toFixed(2);
    }

    const rfqNo = `RFQ-SYN-${period.code}-${String(i).padStart(4, '0')}`;

    rows.push({
      'RFQ No': rfqNo,
      Customer: cust,
      'Quote Date': quoteDate,
      'Due Date': dueDate,
      Outcome: outcome,
      'Lost Reason': lostReason,
      'Part Name': `${arch.name} Series-${(i % 12) + 1}`,
      'Drawing No': `${arch.drgPrefix}-${String(i).padStart(4, '0')}`,
      'Drawing Rev': String.fromCharCode(65 + (i % 4)),
      Material: arch.material,
      'Gross Weight (kg)': grossWeightKg,
      'Annual Volume': annualVolume,
      'Quote Version': 1,
      'Material Rate (INR/kg)': materialRate,
      'Scrap %': scrapPct,
      'Overhead %': overheadPct,
      'Packing & Freight (INR/pc)': packingFreight,
      'Setup Cost (INR)': setupCost,
      'Margin %': marginPct,
      'GST %': gstPct,
      'Op1 Name': arch.op1.name,
      'Op1 Machine': arch.op1.machine,
      'Op1 Cycle Time (min)': op1Cycle,
      'Op1 Hour Rate': op1Rate,
      'Op2 Name': arch.op2.name,
      'Op2 Machine': arch.op2.machine,
      'Op2 Cycle Time (min)': op2Cycle,
      'Op2 Hour Rate': op2Rate,
      'Stated Selling Price Ex-GST': statedSellingPriceExGst,
      'Data Classification': 'SYNTHETIC DEMO DATA - CHAKAN AUTOMOTIVE DATASET',
    });
  }

  // 2. Append 25 Duplicate Rows (exact copies of rows 1..25 to demonstrate intra-file duplicate detection)
  for (let i = 0; i < 25; i++) {
    rows.push({ ...rows[i] });
  }

  // 3. Append 25 Incomplete Rows (missing material rate, overhead, or routing — never fabricated)
  for (let i = 1; i <= 25; i++) {
    const cust = customers[i % customers.length];
    const arch = partArchetypes[i % partArchetypes.length];
    rows.push({
      'RFQ No': `RFQ-SYN-INCOMP-${String(i).padStart(3, '0')}`,
      Customer: cust,
      'Quote Date': '2024-05-15',
      'Due Date': '2024-05-30',
      Outcome: 'SENT',
      'Lost Reason': '',
      'Part Name': `${arch.name} Legacy-Incomplete-${i}`,
      'Drawing No': `${arch.drgPrefix}-INC-${i}`,
      'Drawing Rev': 'A',
      Material: arch.material,
      'Gross Weight (kg)': arch.baseWeightKg,
      'Annual Volume': arch.baseVolume,
      'Quote Version': 1,
      'Material Rate (INR/kg)': i % 2 === 0 ? '' : 78.0, // Missing on even rows
      'Scrap %': 5,
      'Overhead %': i % 3 === 0 ? '' : 150, // Missing on multiples of 3
      'Packing & Freight (INR/pc)': 2.5,
      'Setup Cost (INR)': 0.5,
      'Margin %': 15,
      'GST %': 18,
      'Op1 Name': '',
      'Op1 Machine': '', // Missing routing operation
      'Op1 Cycle Time (min)': '',
      'Op1 Hour Rate': '',
      'Op2 Name': '',
      'Op2 Machine': '',
      'Op2 Cycle Time (min)': '',
      'Op2 Hour Rate': '',
      'Stated Selling Price Ex-GST': '145.00',
      'Data Classification': 'SYNTHETIC DEMO DATA - INCOMPLETE LEGACY ROW',
    });
  }

  // 4. Append 10 Invalid Rows (negative weight or zero volume to demonstrate Zod validation)
  for (let i = 1; i <= 10; i++) {
    rows.push({
      'RFQ No': `RFQ-SYN-INVALID-${String(i).padStart(3, '0')}`,
      Customer: i === 10 ? '' : customers[0],
      'Quote Date': '2024-07-10',
      'Due Date': '2024-07-25',
      Outcome: 'SENT',
      'Lost Reason': '',
      'Part Name': `Invalid Spec Component ${i}`,
      'Drawing No': `DRG-INV-${i}`,
      'Drawing Rev': 'A',
      Material: 'EN8',
      'Gross Weight (kg)': i <= 5 ? -1.25 : 1.0, // Negative weight on 1..5
      'Annual Volume': i > 5 && i <= 9 ? 0 : 10000, // Zero volume on 6..9
      'Quote Version': 1,
      'Material Rate (INR/kg)': 52.0,
      'Scrap %': 5,
      'Overhead %': 150,
      'Packing & Freight (INR/pc)': 2.5,
      'Setup Cost (INR)': 0.5,
      'Margin %': 15,
      'GST %': 18,
      'Op1 Name': 'CNC Turning',
      'Op1 Machine': 'Standard CNC Turning',
      'Op1 Cycle Time (min)': 2.0,
      'Op1 Hour Rate': 850,
      'Op2 Name': '',
      'Op2 Machine': '',
      'Op2 Cycle Time (min)': '',
      'Op2 Hour Rate': '',
      'Stated Selling Price Ex-GST': '',
      'Data Classification': 'SYNTHETIC DEMO DATA - INVALID ROW',
    });
  }

  return rows;
}

export function generateSynthetic1400HistoricalWorkbookBuffer(): Buffer {
  const rows = generateSynthetic1400HistoricalRows();
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Synthetic_1400_Quotes');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}
