/**
 * services/costingWorkflow.service.ts
 *
 * Connects: RFQ/Part data → rate lookup → costing engine → quote persistence.
 *
 * Rules:
 *  - Never silently default a missing rate. Let RateLookupError propagate.
 *  - Never recalculate historical quote versions.
 *  - Use the existing rate lookup service and costing engine exclusively.
 *  - Concurrency safety: relies on { rfqId, version } unique index in Quote.
 */

import mongoose from 'mongoose';
import { RFQ } from '../models/RFQ';
import { Part, IPart } from '../models/Part';
import { Quote, IRateSnapshot, ISnapshotOperation } from '../models/Quote';
import {
  getMaterialRate,
  getMachineRate,
  getRateSetting,
  decimal128ToString,
} from './rateLookup.service';
import { createQuote, reviseQuote } from './quote.service';
import {
  calculateCosting,
  evaluateApproval,
} from '@rfq/costing-engine';
import type { CostingInput, CostingResult } from '@rfq/costing-engine';
import type { IQuote } from '../models/Quote';

// ─── Error types ──────────────────────────────────────────────────────────────

export type WorkflowErrorCode =
  | 'RFQ_NOT_FOUND'
  | 'PART_NOT_FOUND'
  | 'PART_NOT_IN_RFQ'
  | 'INVALID_RFQ_ID'
  | 'INVALID_PART_ID'
  | 'INVALID_INPUT';

export class WorkflowError extends Error {
  public readonly code: WorkflowErrorCode;
  constructor(code: WorkflowErrorCode, message: string) {
    super(message);
    this.name = 'WorkflowError';
    this.code = code;
  }
}

// ─── Input / output types ─────────────────────────────────────────────────────

export interface RoutingOperationInput {
  operationName: string;
  machine: string;
  cycleTimeMinutes: number;
}

export interface CostingWorkflowInput {
  rfqId: string;
  partId: string;
  routingOperations: RoutingOperationInput[];
  scrapPctOverride?: number;
  overheadPctOverride?: number;
  packingFreightOverride?: number;
  setupCostOverride?: number;
  marginPctOverride?: number;
  gstPctOverride?: number;
  costingDate?: string; // ISO string; defaults to today
}

export interface CostingContextResult {
  rfq: { _id: string; rfqNo: string; customer: string; dueDate: string; status: string };
  part: {
    _id: string;
    partName: string;
    material: string;
    grossWeightKg: number;
    annualVolume: number;
    cycleTimeMinutes?: number;
  };
  materialRate: { material: string; ratePerKg: string; effectiveFrom: string };
  rateSettings: {
    scrapPct: number;
    overheadPct: number;
    packingFreight: string;
    defaultMarginPct: number;
    gstPct: number;
    setupCostPerPart: string;
    effectiveFrom: string;
  };
  availableMachines: { machine: string; hourRate: string; effectiveFrom: string }[];
  costingDate: string;
}

export interface CostingPreviewResult {
  breakdown: CostingResult['breakdown'];
  volumeTiers: CostingResult['volumeTiers'];
  annualQuotationValue: string;
  approvalDecision: { totalAnnualValue: string; threshold: string; requiresApproval: boolean };
  rateSnapshot: IRateSnapshot;
  costingInput: CostingInput;
  costingDate: string;
}

// ─── Known machines (from seed) ───────────────────────────────────────────────

const KNOWN_MACHINES = [
  'Standard CNC Turning',
  'Heavy CNC Machining',
  'VMC Milling',
  'Grinding',
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function validateObjectId(id: string, field: string, code: WorkflowErrorCode): void {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw new WorkflowError(code, `${field} is not a valid ObjectId: "${id}"`);
  }
}

function resolveCostingDate(isoString?: string): Date {
  if (!isoString) return new Date();
  const d = new Date(isoString);
  if (isNaN(d.getTime())) {
    throw new WorkflowError('INVALID_INPUT', `costingDate is not a valid date: "${isoString}"`);
  }
  return d;
}

function d128(s: string | number): mongoose.Types.Decimal128 {
  return mongoose.Types.Decimal128.fromString(String(s));
}

// ─── A. Load costing context ──────────────────────────────────────────────────

/**
 * Load all context needed for the costing screen: RFQ, Part, material rate,
 * global rate settings, and all available machine rates.
 */
export async function getCostingContext(
  rfqId: string,
  partId: string,
  costingDateStr?: string,
): Promise<CostingContextResult> {
  validateObjectId(rfqId, 'rfqId', 'INVALID_RFQ_ID');
  validateObjectId(partId, 'partId', 'INVALID_PART_ID');

  const costingDate = resolveCostingDate(costingDateStr);

  const rfq = await RFQ.findById(rfqId).lean();
  if (!rfq) throw new WorkflowError('RFQ_NOT_FOUND', `RFQ "${rfqId}" not found`);

  const part = await Part.findById(partId).lean<IPart>();
  if (!part) throw new WorkflowError('PART_NOT_FOUND', `Part "${partId}" not found`);
  if (String(part.rfqId) !== String(rfq._id)) {
    throw new WorkflowError('PART_NOT_IN_RFQ', `Part "${partId}" does not belong to RFQ "${rfqId}"`);
  }

  // These throw RateLookupError on miss — let propagate
  const materialRate = await getMaterialRate(part.material, costingDate);
  const rateSetting = await getRateSetting(costingDate);

  // Build available machine list — skip machines with no rate (don't throw)
  const availableMachines: CostingContextResult['availableMachines'] = [];
  for (const machine of KNOWN_MACHINES) {
    try {
      const mr = await getMachineRate(machine, costingDate);
      availableMachines.push({
        machine: mr.machine,
        hourRate: decimal128ToString(mr.hourRate),
        effectiveFrom: mr.effectiveFrom.toISOString(),
      });
    } catch {
      // Machine has no applicable rate — omit from list
    }
  }

  return {
    rfq: {
      _id: String(rfq._id),
      rfqNo: rfq.rfqNo,
      customer: rfq.customer,
      dueDate: rfq.dueDate.toISOString(),
      status: rfq.status,
    },
    part: {
      _id: String(part._id),
      partName: part.partName,
      material: part.material,
      grossWeightKg: part.grossWeightKg,
      annualVolume: part.annualVolume,
      cycleTimeMinutes: part.cycleTimeMinutes,
    },
    materialRate: {
      material: materialRate.material,
      ratePerKg: decimal128ToString(materialRate.ratePerKg),
      effectiveFrom: materialRate.effectiveFrom.toISOString(),
    },
    rateSettings: {
      scrapPct: rateSetting.scrapPct,
      overheadPct: rateSetting.overheadPct,
      packingFreight: decimal128ToString(rateSetting.packingFreight),
      defaultMarginPct: rateSetting.defaultMarginPct,
      gstPct: rateSetting.gstPct,
      setupCostPerPart: decimal128ToString(rateSetting.setupCostPerPart),
      effectiveFrom: rateSetting.effectiveFrom.toISOString(),
    },
    availableMachines,
    costingDate: costingDate.toISOString(),
  };
}

// ─── B + C. Build costing result (shared by preview and save) ─────────────────

async function buildCostingResult(input: CostingWorkflowInput): Promise<{
  costingInput: CostingInput;
  costingResult: CostingResult;
  rateSnapshot: IRateSnapshot;
  costingDate: Date;
  part: IPart;
}> {
  validateObjectId(input.rfqId, 'rfqId', 'INVALID_RFQ_ID');
  validateObjectId(input.partId, 'partId', 'INVALID_PART_ID');

  if (!input.routingOperations || input.routingOperations.length === 0) {
    throw new WorkflowError('INVALID_INPUT', 'At least one routing operation is required');
  }

  const costingDate = resolveCostingDate(input.costingDate);

  const rfq = await RFQ.findById(input.rfqId).lean();
  if (!rfq) throw new WorkflowError('RFQ_NOT_FOUND', `RFQ "${input.rfqId}" not found`);

  const part = await Part.findById(input.partId).lean<IPart>();
  if (!part) throw new WorkflowError('PART_NOT_FOUND', `Part "${input.partId}" not found`);
  if (String(part.rfqId) !== String(rfq._id)) {
    throw new WorkflowError('PART_NOT_IN_RFQ', `Part "${input.partId}" does not belong to RFQ "${input.rfqId}"`);
  }

  // Rate lookups — all throw RateLookupError on miss
  const materialRate = await getMaterialRate(part.material, costingDate);
  const rateSetting = await getRateSetting(costingDate);

  // Per-operation machine rate lookups
  const machineRates = await Promise.all(
    input.routingOperations.map((op) => getMachineRate(op.machine, costingDate)),
  );

  // Resolve effective values (override or rate master default)
  const scrapPct = input.scrapPctOverride ?? rateSetting.scrapPct;
  const overheadPct = input.overheadPctOverride ?? rateSetting.overheadPct;
  const packingFreightPerPiece =
    input.packingFreightOverride != null
      ? String(input.packingFreightOverride)
      : decimal128ToString(rateSetting.packingFreight);
  const setupCostPerPart =
    input.setupCostOverride != null
      ? String(input.setupCostOverride)
      : decimal128ToString(rateSetting.setupCostPerPart);
  const defaultMarginPct = input.marginPctOverride ?? rateSetting.defaultMarginPct;
  const gstPct = input.gstPctOverride ?? rateSetting.gstPct;

  // Build CostingInput for the engine
  const costingInput: CostingInput = {
    grossWeightKg: part.grossWeightKg,
    materialRatePerKg: decimal128ToString(materialRate.ratePerKg),
    scrapPct,
    routingOperations: input.routingOperations.map((op, i) => ({
      operationName: op.operationName,
      machine: op.machine,
      cycleTimeMinutes: op.cycleTimeMinutes,
      machineHourRate: decimal128ToString(machineRates[i].hourRate),
    })),
    overheadPct,
    packingFreightPerPiece,
    setupCostPerPart,
    annualVolume: part.annualVolume,
    defaultMarginPct,
    gstPct,
  };

  // Run pure costing engine — synchronous, deterministic
  const costingResult = calculateCosting(costingInput);

  // Build immutable rate snapshot with Decimal128 values for MongoDB
  const snapshotOps: ISnapshotOperation[] = input.routingOperations.map((op, i) => ({
    operationName: op.operationName,
    machine: op.machine,
    cycleTimeMinutes: d128(op.cycleTimeMinutes),
    machineHourRate: d128(decimal128ToString(machineRates[i].hourRate)),
    machineRateEffectiveFrom: machineRates[i].effectiveFrom,
  }));

  const rateSnapshot: IRateSnapshot = {
    material: part.material,
    materialRatePerKg: d128(decimal128ToString(materialRate.ratePerKg)),
    materialRateEffectiveFrom: materialRate.effectiveFrom,
    operations: snapshotOps,
    scrapPct,
    overheadPct,
    packingFreight: d128(packingFreightPerPiece),
    marginPct: defaultMarginPct,
    gstPct,
    setupCostPerPart: d128(setupCostPerPart),
    rateSettingEffectiveFrom: rateSetting.effectiveFrom,
    snapshotCreatedAt: new Date(),
  };

  return { costingInput, costingResult, rateSnapshot, costingDate, part };
}

// ─── C. Preview (no DB write) ─────────────────────────────────────────────────

/**
 * Calculate a costing preview. Does NOT persist a quote.
 */
export async function previewCosting(input: CostingWorkflowInput): Promise<CostingPreviewResult> {
  const { costingInput, costingResult, rateSnapshot, costingDate } = await buildCostingResult(input);

  const approvalDecision = evaluateApproval([costingResult.annualQuotationValue]);

  return {
    breakdown: costingResult.breakdown,
    volumeTiers: costingResult.volumeTiers,
    annualQuotationValue: costingResult.annualQuotationValue,
    approvalDecision,
    rateSnapshot,
    costingInput,
    costingDate: costingDate.toISOString(),
  };
}

// ─── D. Save quote version ────────────────────────────────────────────────────

/**
 * Save a costing result as a new quote version.
 * Creates v1 for a new RFQ; creates vN+1 for a revision.
 * Concurrency: relies on unique index { rfqId, version } to reject races.
 */
export async function saveQuoteVersion(
  input: CostingWorkflowInput,
  userId: string,
): Promise<IQuote> {
  validateObjectId(userId, 'userId', 'INVALID_INPUT');

  const { costingInput, costingResult, rateSnapshot, costingDate } =
    await buildCostingResult(input);

  const rfqObjectId = new mongoose.Types.ObjectId(input.rfqId);
  const partObjectId = new mongoose.Types.ObjectId(input.partId);
  const userObjectId = new mongoose.Types.ObjectId(userId);

  const params = {
    rfqId: rfqObjectId,
    partId: partObjectId,
    createdBy: userObjectId,
    costingDate,
    costingInput,
    costingResult,
    rateSnapshot,
  };

  // Determine: first quote or revision?
  const latestQuote = await Quote.findOne({ rfqId: rfqObjectId })
    .sort({ version: -1 })
    .lean();

  if (!latestQuote) {
    return createQuote(params);
  }

  // Always create a new revision (sibling) — never overwrite
  return reviseQuote(params);
}

