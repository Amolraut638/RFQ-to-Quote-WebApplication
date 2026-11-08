/**
 * services/intake/routingSuggestion.service.ts
 *
 * AI-assisted historical routing suggestions.
 *
 * Process:
 *  1. Load the target Part.
 *  2. Find historical Parts (excluding the target part itself) with matching material
 *     (case-insensitive) and comparable grossWeightKg (sorted by relative weight closeness).
 *  3. For each candidate part, find the latest Quote on its RFQ whose frozen
 *     costingInputSnapshot.routingOperations is non-empty, along with the RFQ's rfqNo.
 *  4. Pass the candidate summaries (partName, material, grossWeightKg, operations) to
 *     the genuine AI model via selectRoutingCandidate().
 *  5. Validate that the AI selected a candidateId from the supplied list.
 *  6. Return the exact historical routing operations (operationName, machine,
 *     cycleTimeMinutes) from the selected quote snapshot — AI never invents or modifies
 *     machine rates, cycle times, or operations.
 */

import mongoose from 'mongoose';
import { Part } from '../../models/Part';
import { Quote } from '../../models/Quote';
import { RFQ } from '../../models/RFQ';
import { IntakeError } from './fileValidation.service';
import { getAIProvider } from '../ai/GeminiProvider';
import { selectRoutingCandidate, type RoutingCandidatePrompt } from '../ai/AIExtractor.service';
import type { AIProvider } from '../ai/AIProvider';

export interface SuggestedOperation {
  operationName: string;
  machine: string;
  cycleTimeMinutes: number;
}

export interface RoutingSuggestionResult {
  hasSuggestion: boolean;
  suggestedOperations: SuggestedOperation[];
  basedOnPartId: string | null;
  historicalPartName: string | null;
  historicalRFQNo: string | null;
  historicalQuoteVersion: number | null;
  historicalGrossWeightKg: number | null;
  historicalMaterial: string | null;
  reason: string;
  provider: string;
  model: string;
}

interface InternalCandidate extends RoutingCandidatePrompt {
  partId: string;
  rfqNo: string;
  quoteVersion: number;
  fullOperations: SuggestedOperation[];
}

function d128ToNumber(val: unknown): number {
  if (typeof val === 'number') return val;
  if (val && typeof (val as { toString?: () => string }).toString === 'function') {
    const n = parseFloat((val as { toString: () => string }).toString());
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function getRoutingSuggestionForPart(
  partId: string,
  providerOverride?: AIProvider,
): Promise<RoutingSuggestionResult> {
  if (!mongoose.isValidObjectId(partId)) {
    throw new IntakeError('INVALID_ID', `Invalid partId: "${partId}"`);
  }

  const targetPart = await Part.findById(partId).lean();
  if (!targetPart) {
    throw new IntakeError('VALIDATION_FAILED', `Part "${partId}" not found`);
  }

  const provider = providerOverride ?? getAIProvider();
  const emptyResult = (reason: string): RoutingSuggestionResult => ({
    hasSuggestion: false,
    suggestedOperations: [],
    basedOnPartId: null,
    historicalPartName: null,
    historicalRFQNo: null,
    historicalQuoteVersion: null,
    historicalGrossWeightKg: null,
    historicalMaterial: null,
    reason,
    provider: provider.providerName,
    model: provider.modelName,
  });

  // 1. Find historical parts with the same material (case-insensitive), excluding targetPart
  const materialRegex = new RegExp(`^\\s*${escapeRegex(targetPart.material.trim())}\\s*$`, 'i');
  const otherParts = await Part.find({
    _id: { $ne: targetPart._id },
    material: materialRegex,
  }).lean();

  if (otherParts.length === 0) {
    return emptyResult(`No historical parts found with material "${targetPart.material}".`);
  }

  // Sort by relative weight difference to targetPart
  const targetWeight = targetPart.grossWeightKg || 1;
  otherParts.sort((a, b) => {
    const da = Math.abs((a.grossWeightKg - targetWeight) / targetWeight);
    const db = Math.abs((b.grossWeightKg - targetWeight) / targetWeight);
    return da - db;
  });

  // 2. For up to 10 closest parts, look up the latest Quote with routing operations
  const candidates: InternalCandidate[] = [];
  for (const hp of otherParts.slice(0, 10)) {
    const latestQuote = await Quote.findOne({ rfqId: hp.rfqId })
      .sort({ version: -1 })
      .lean();
    if (!latestQuote) continue;

    const rawOps = latestQuote.costingInputSnapshot?.routingOperations ?? [];
    if (rawOps.length === 0) continue;

    const rfq = await RFQ.findById(hp.rfqId).lean();
    if (!rfq) continue;

    const fullOperations: SuggestedOperation[] = rawOps.map((op) => ({
      operationName: op.operationName,
      machine: op.machine,
      cycleTimeMinutes: d128ToNumber(op.cycleTimeMinutes),
    }));

    const candidateId = String(hp._id);
    candidates.push({
      candidateId,
      partId: candidateId,
      partName: hp.partName,
      material: hp.material,
      grossWeightKg: hp.grossWeightKg,
      rfqNo: rfq.rfqNo,
      quoteVersion: latestQuote.version,
      operations: fullOperations.map((o) => ({
        operationName: o.operationName,
        machine: o.machine,
      })),
      fullOperations,
    });
  }

  if (candidates.length === 0) {
    return emptyResult(
      `Found historical parts with material "${targetPart.material}", but none have saved quote routings yet.`,
    );
  }

  // 3. Ask the genuine AI model to select the best matching candidate
  const promptCandidates: RoutingCandidatePrompt[] = candidates.map((c) => ({
    candidateId: c.candidateId,
    partName: c.partName,
    material: c.material,
    grossWeightKg: c.grossWeightKg,
    operations: c.operations,
  }));

  const choice = await selectRoutingCandidate(
    {
      partName: targetPart.partName,
      material: targetPart.material,
      grossWeightKg: targetPart.grossWeightKg,
    },
    promptCandidates,
    provider,
  );

  if (!choice.selectedCandidateId) {
    return emptyResult(choice.reason || 'AI determined no historical candidate was sufficiently similar.');
  }

  const chosen = candidates.find((c) => c.candidateId === choice.selectedCandidateId);
  if (!chosen) {
    throw new IntakeError(
      'VALIDATION_FAILED',
      'AI selected a candidate outside the supplied historical list.',
    );
  }

  return {
    hasSuggestion: true,
    suggestedOperations: chosen.fullOperations,
    basedOnPartId: chosen.partId,
    historicalPartName: chosen.partName,
    historicalRFQNo: chosen.rfqNo,
    historicalQuoteVersion: chosen.quoteVersion,
    historicalGrossWeightKg: chosen.grossWeightKg,
    historicalMaterial: chosen.material,
    reason: choice.reason,
    provider: provider.providerName,
    model: provider.modelName,
  };
}

