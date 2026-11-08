/**
 * services/intake/intake.service.ts
 *
 * Orchestrates AI-assisted RFQ intake:
 *  - Email extraction -> IntakeDraft
 *  - Excel / PDF upload extraction -> IntakeDraft (or merged into an existing draft)
 *  - Estimator field review (ACCEPT / EDIT / REJECT)
 *  - Atomic commit (MongoDB transaction) -> RFQ + Part documents
 *
 * Strict rules:
 *  - Never auto-accepts AI-extracted fields; every AI field starts as PENDING.
 *  - Commit uses ONLY fields with status ACCEPTED or EDITED.
 *  - Never accepts or persists any cost-related field.
 */

import mongoose from 'mongoose';
import {
  IntakeDraft,
  type IIntakeDraft,
  type IDraftField,
  type FieldStatus,
  type DraftStatus,
} from '../../models/IntakeDraft';
import { RFQ, type IRFQ } from '../../models/RFQ';
import { type IPart } from '../../models/Part';
import { createRFQ } from '../rfq.service';
import { createPart, CreatePartSchema, type CreatePartInput } from '../part.service';
import {
  extractFromEmail,
  extractFromExcelContent,
  extractFromPdfPages,
  RFQ_FIELD_KEYS,
  PART_FIELD_KEYS,
  assertNoCostFields,
  type ExtractionResult,
  type ExtractedField,
  type RfqFieldKey,
  type PartFieldKey,
} from '../ai/AIExtractor.service';
import { getAIProvider } from '../ai/GeminiProvider';
import type { AIProvider } from '../ai/AIProvider';
import { IntakeError, validateUpload } from './fileValidation.service';
import { extractPdfPages } from './pdfExtraction.service';
import { readWorkbook } from './excelExtraction.service';

const REQUIRED_RFQ_KEYS: readonly RfqFieldKey[] = ['rfqNo', 'customer'];
const REQUIRED_PART_KEYS: readonly PartFieldKey[] = [
  'partName',
  'material',
  'grossWeightKg',
  'annualVolume',
];

function toDraftField(
  scope: 'RFQ' | 'PART',
  partIndex: number,
  key: string,
  ef: ExtractedField,
): IDraftField {
  return {
    scope,
    partIndex,
    key,
    value: ef.value,
    aiValue: ef.value,
    source: {
      fileName: ef.source.fileName,
      sourceType: ef.source.sourceType,
      page: ef.source.page,
      sheet: ef.source.sheet,
      cell: ef.source.cell,
      originalValue: ef.source.originalValue,
      snippet: ef.source.snippet,
    },
    method: 'AI',
    confidence: ef.confidence,
    verified: ef.verified,
    status: 'PENDING',
  };
}

function buildFieldsFromExtraction(extraction: ExtractionResult): {
  fields: IDraftField[];
  partCount: number;
} {
  const fields: IDraftField[] = [];
  for (const k of RFQ_FIELD_KEYS) {
    fields.push(toDraftField('RFQ', -1, k, extraction.rfq[k]));
  }
  const parts = extraction.parts.length > 0 ? extraction.parts : [];
  parts.forEach((p, idx) => {
    for (const k of PART_FIELD_KEYS) {
      fields.push(toDraftField('PART', idx, k, p[k]));
    }
  });
  return { fields, partCount: parts.length };
}

function isApprovedStatus(st: FieldStatus): boolean {
  return st === 'ACCEPTED' || st === 'EDITED';
}

function hasUsableValue(f: IDraftField | undefined): boolean {
  if (!f || !isApprovedStatus(f.status)) return false;
  if (f.value === null || f.value === undefined) return false;
  if (typeof f.value === 'string' && f.value.trim() === '') return false;
  if (typeof f.value === 'number' && (!Number.isFinite(f.value) || f.value <= 0)) return false;
  return true;
}

/**
 * Computes whether a draft has all required RFQ fields and at least one complete part
 * accepted or edited by the estimator.
 */
export function evaluateDraftReadiness(
  fields: IDraftField[],
  partCount: number,
): { ready: boolean; missingReasons: string[] } {
  const reasons: string[] = [];

  for (const reqKey of REQUIRED_RFQ_KEYS) {
    const f = fields.find((x) => x.scope === 'RFQ' && x.key === reqKey);
    if (!hasUsableValue(f)) {
      reasons.push(`RFQ field "${reqKey}" must have a valid value and be ACCEPTED or EDITED.`);
    }
  }

  if (partCount <= 0) {
    reasons.push('At least one part is required.');
  }

  let validPartCount = 0;
  for (let i = 0; i < partCount; i++) {
    const partFields = fields.filter((x) => x.scope === 'PART' && x.partIndex === i);
    // If all fields of this part are REJECTED, skip the part
    const allRejected =
      partFields.length > 0 && partFields.every((x) => x.status === 'REJECTED');
    if (allRejected) continue;

    let partOk = true;
    for (const pk of REQUIRED_PART_KEYS) {
      const pf = partFields.find((x) => x.key === pk);
      if (!hasUsableValue(pf)) {
        partOk = false;
        reasons.push(
          `Part #${i + 1} field "${pk}" must have a positive/non-empty value and be ACCEPTED or EDITED.`,
        );
      }
    }
    if (partOk) validPartCount++;
  }

  if (partCount > 0 && validPartCount === 0) {
    reasons.push('At least one part must have all required fields accepted or edited.');
  }

  return { ready: reasons.length === 0, missingReasons: reasons };
}

function mergeExtractionIntoDraft(
  draft: IIntakeDraft,
  extraction: ExtractionResult,
  sourceMeta: IIntakeDraft['sources'][number],
): void {
  draft.sources.push(sourceMeta);
  draft.ai = {
    provider: extraction.provider,
    model: extraction.model,
    extractedAt: new Date(),
  };

  // Merge RFQ fields: only fill if existing field has null/empty value and is still PENDING
  for (const k of RFQ_FIELD_KEYS) {
    const incoming = extraction.rfq[k];
    if (incoming.value === null) continue;
    const existing = draft.fields.find((f) => f.scope === 'RFQ' && f.key === k);
    if (!existing) {
      draft.fields.push(toDraftField('RFQ', -1, k, incoming));
    } else if (existing.status === 'PENDING' && (existing.value === null || existing.value === '')) {
      const replacement = toDraftField('RFQ', -1, k, incoming);
      Object.assign(existing, replacement);
    }
  }

  // Merge parts:
  // If the incoming source is a single-part PDF drawing and the draft already has parts,
  // enrich matching part (by partName) or part #0 for missing drawing/weight/material fields.
  if (sourceMeta.sourceType === 'PDF' && extraction.parts.length === 1 && draft.partCount > 0) {
    const incPart = extraction.parts[0];
    const incName = String(incPart.partName.value ?? '').trim().toLowerCase();
    let targetIdx = 0;
    if (incName) {
      for (let i = 0; i < draft.partCount; i++) {
        const pf = draft.fields.find(
          (f) => f.scope === 'PART' && f.partIndex === i && f.key === 'partName',
        );
        if (pf && String(pf.value ?? '').trim().toLowerCase() === incName) {
          targetIdx = i;
          break;
        }
      }
    }
    for (const k of PART_FIELD_KEYS) {
      const incField = incPart[k];
      if (incField.value === null) continue;
      const existing = draft.fields.find(
        (f) => f.scope === 'PART' && f.partIndex === targetIdx && f.key === k,
      );
      if (!existing) {
        draft.fields.push(toDraftField('PART', targetIdx, k, incField));
      } else if (existing.status === 'PENDING' && (existing.value === null || existing.value === '')) {
        Object.assign(existing, toDraftField('PART', targetIdx, k, incField));
      }
    }
  } else if (extraction.parts.length > 0) {
    // Append incoming parts (or replace if existing draft had 0 parts)
    const startIdx = draft.partCount;
    extraction.parts.forEach((p, idx) => {
      const partIndex = startIdx + idx;
      for (const k of PART_FIELD_KEYS) {
        draft.fields.push(toDraftField('PART', partIndex, k, p[k]));
      }
    });
    draft.partCount = startIdx + extraction.parts.length;
  }

  const readiness = evaluateDraftReadiness(draft.fields, draft.partCount);
  draft.status = readiness.ready ? 'READY_TO_COMMIT' : 'REVIEW_REQUIRED';
}

// ─── 1. Email intake ─────────────────────────────────────────────────────────

export async function createOrMergeEmailIntake(params: {
  userId: string;
  emailText: string;
  draftId?: string;
  provider?: AIProvider;
}): Promise<IIntakeDraft> {
  const text = params.emailText?.trim() ?? '';
  if (text.length < 10) {
    throw new IntakeError('EMPTY_DOCUMENT', 'Email text is too short to extract RFQ details.');
  }

  const provider = params.provider ?? getAIProvider();
  const extraction = await extractFromEmail(text, provider, 'Pasted RFQ email');
  const now = new Date();
  const sourceMeta = {
    sourceType: 'EMAIL' as const,
    fileName: 'Pasted RFQ email',
    sizeBytes: Buffer.byteLength(text, 'utf8'),
    extractedAt: now,
  };

  if (params.draftId) {
    const draft = await getDraftForUser(params.draftId, params.userId);
    if (draft.status === 'COMMITTED') {
      throw new IntakeError('DRAFT_NOT_EDITABLE', 'This intake draft has already been committed.');
    }
    draft.originalEmailText = text;
    mergeExtractionIntoDraft(draft, extraction, sourceMeta);
    await draft.save();
    return draft;
  }

  const { fields, partCount } = buildFieldsFromExtraction(extraction);
  const draft = await IntakeDraft.create({
    createdBy: new mongoose.Types.ObjectId(params.userId),
    sourceType: 'EMAIL',
    sources: [sourceMeta],
    originalEmailText: text,
    ai: { provider: extraction.provider, model: extraction.model, extractedAt: now },
    fields,
    partCount,
    status: 'REVIEW_REQUIRED',
  });

  return draft;
}

// ─── 2. File upload intake (PDF or Excel) ────────────────────────────────────

export async function createOrMergeUploadIntake(params: {
  userId: string;
  file: { originalname: string; mimetype: string; size: number; buffer: Buffer } | undefined;
  draftId?: string;
  provider?: AIProvider;
}): Promise<IIntakeDraft> {
  const detected = validateUpload(params.file);
  const file = params.file!;
  const provider = params.provider ?? getAIProvider();
  const now = new Date();

  let extraction: ExtractionResult;
  let sourceMeta: IIntakeDraft['sources'][number];

  if (detected === 'PDF') {
    const pages = await extractPdfPages(file.buffer);
    extraction = await extractFromPdfPages(pages, file.originalname, provider);
    sourceMeta = {
      sourceType: 'PDF',
      fileName: file.originalname,
      mimeType: file.mimetype,
      sizeBytes: file.size,
      pageCount: pages.length,
      extractedAt: now,
    };
  } else {
    const excel = readWorkbook(file.buffer);
    const sheetCount = new Set(excel.cells.map((c) => c.sheet)).size;
    extraction = await extractFromExcelContent(excel, file.originalname, provider);
    sourceMeta = {
      sourceType: 'EXCEL',
      fileName: file.originalname,
      mimeType: file.mimetype,
      sizeBytes: file.size,
      sheetCount,
      extractedAt: now,
    };
  }

  if (params.draftId) {
    const draft = await getDraftForUser(params.draftId, params.userId);
    if (draft.status === 'COMMITTED') {
      throw new IntakeError('DRAFT_NOT_EDITABLE', 'This intake draft has already been committed.');
    }
    mergeExtractionIntoDraft(draft, extraction, sourceMeta);
    await draft.save();
    return draft;
  }

  const { fields, partCount } = buildFieldsFromExtraction(extraction);
  const draft = await IntakeDraft.create({
    createdBy: new mongoose.Types.ObjectId(params.userId),
    sourceType: sourceMeta.sourceType,
    sources: [sourceMeta],
    ai: { provider: extraction.provider, model: extraction.model, extractedAt: now },
    fields,
    partCount,
    status: 'REVIEW_REQUIRED',
  });

  return draft;
}

// ─── 3. Fetch & review fields ────────────────────────────────────────────────

export async function getDraftForUser(draftId: string, userId: string): Promise<IIntakeDraft> {
  if (!mongoose.isValidObjectId(draftId)) {
    throw new IntakeError('INVALID_ID', `Invalid draft id: "${draftId}"`);
  }
  const draft = await IntakeDraft.findOne({
    _id: new mongoose.Types.ObjectId(draftId),
    createdBy: new mongoose.Types.ObjectId(userId),
  });
  if (!draft) {
    throw new IntakeError('DRAFT_NOT_FOUND', 'Intake draft not found.');
  }
  return draft;
}

export interface FieldUpdateAction {
  scope: 'RFQ' | 'PART';
  partIndex: number;
  key: string;
  action: 'ACCEPT' | 'EDIT' | 'REJECT';
  value?: string | number | null;
}

export async function updateDraftFields(params: {
  draftId: string;
  userId: string;
  updates: FieldUpdateAction[];
  addPart?: boolean;
}): Promise<IIntakeDraft> {
  const draft = await getDraftForUser(params.draftId, params.userId);
  if (draft.status === 'COMMITTED') {
    throw new IntakeError('DRAFT_NOT_EDITABLE', 'Cannot modify a committed intake draft.');
  }

  // Reject any attempt to sneak cost-related keys into field updates
  for (const u of params.updates) {
    assertNoCostFields({ [u.key]: u.value ?? null });
    const allowedKeys: readonly string[] =
      u.scope === 'RFQ' ? RFQ_FIELD_KEYS : PART_FIELD_KEYS;
    if (!allowedKeys.includes(u.key)) {
      throw new IntakeError('VALIDATION_FAILED', `Unknown ${u.scope} field key "${u.key}".`);
    }
  }

  if (params.addPart) {
    const newIdx = draft.partCount;
    for (const k of PART_FIELD_KEYS) {
      draft.fields.push({
        scope: 'PART',
        partIndex: newIdx,
        key: k,
        value: null,
        aiValue: null,
        source: {
          fileName: 'Manual entry',
          sourceType: 'MANUAL',
          page: null,
          sheet: null,
          cell: null,
          originalValue: null,
          snippet: null,
        },
        method: 'MANUAL',
        confidence: null,
        verified: true,
        status: 'PENDING',
      });
    }
    draft.partCount = newIdx + 1;
  }

  for (const u of params.updates) {
    const targetIdx = u.scope === 'RFQ' ? -1 : u.partIndex;
    let field = draft.fields.find(
      (f) => f.scope === u.scope && f.partIndex === targetIdx && f.key === u.key,
    );

    if (!field) {
      if (u.scope === 'PART' && targetIdx >= draft.partCount) {
        throw new IntakeError('VALIDATION_FAILED', `Part index ${targetIdx} out of range.`);
      }
      field = {
        scope: u.scope,
        partIndex: targetIdx,
        key: u.key,
        value: null,
        aiValue: null,
        source: {
          fileName: 'Manual entry',
          sourceType: 'MANUAL',
          page: null,
          sheet: null,
          cell: null,
          originalValue: null,
          snippet: null,
        },
        method: 'MANUAL',
        confidence: null,
        verified: true,
        status: 'PENDING',
      };
      draft.fields.push(field);
    }

    if (u.action === 'ACCEPT') {
      if (field.value === null || field.value === undefined || String(field.value).trim() === '') {
        throw new IntakeError(
          'VALIDATION_FAILED',
          `Cannot ACCEPT empty field "${u.key}" — edit it to provide a value first or reject it.`,
        );
      }
      field.status = 'ACCEPTED';
    } else if (u.action === 'REJECT') {
      field.status = 'REJECTED';
    } else if (u.action === 'EDIT') {
      if (u.value === undefined || u.value === null || String(u.value).trim() === '') {
        throw new IntakeError('VALIDATION_FAILED', `Edited value for "${u.key}" cannot be empty.`);
      }
      if (u.key === 'grossWeightKg' || u.key === 'annualVolume') {
        const num = typeof u.value === 'number' ? u.value : Number(String(u.value).replace(/,/g, ''));
        if (!Number.isFinite(num) || num <= 0) {
          throw new IntakeError('VALIDATION_FAILED', `Field "${u.key}" must be a positive number.`);
        }
        field.value = u.key === 'annualVolume' ? Math.round(num) : num;
      } else {
        field.value = String(u.value).trim();
      }
      field.status = 'EDITED';
      if (field.aiValue === null) {
        field.method = 'MANUAL';
        field.source = {
          fileName: 'Estimator manual entry',
          sourceType: 'MANUAL',
          page: null,
          sheet: null,
          cell: null,
          originalValue: null,
          snippet: null,
        };
      }
    }
  }

  draft.markModified('fields');
  const readiness = evaluateDraftReadiness(draft.fields, draft.partCount);
  draft.status = readiness.ready ? 'READY_TO_COMMIT' : 'REVIEW_REQUIRED';
  await draft.save();
  return draft;
}

// ─── 4. Commit intake draft -> RFQ + Parts (transactional) ───────────────────

export interface CommitIntakeResult {
  rfq: IRFQ;
  parts: IPart[];
  draft: IIntakeDraft;
}

export async function commitIntakeDraft(params: {
  draftId: string;
  userId: string;
  extraPayload?: Record<string, unknown>;
}): Promise<CommitIntakeResult> {
  // Reject any cost-related field passed to commit
  if (params.extraPayload) {
    assertNoCostFields(params.extraPayload);
  }

  const draft = await getDraftForUser(params.draftId, params.userId);
  if (draft.status === 'COMMITTED') {
    throw new IntakeError('DRAFT_NOT_EDITABLE', 'This intake draft has already been committed.');
  }

  const readiness = evaluateDraftReadiness(draft.fields, draft.partCount);
  if (!readiness.ready) {
    throw new IntakeError(
      'NOT_READY_TO_COMMIT',
      `Draft is not ready to commit: ${readiness.missingReasons.join(' ')}`,
      readiness.missingReasons,
    );
  }

  const getApprovedRfqField = (key: RfqFieldKey): string | undefined => {
    const f = draft.fields.find((x) => x.scope === 'RFQ' && x.key === key);
    if (!f || !isApprovedStatus(f.status) || f.value === null || f.value === undefined) {
      return undefined;
    }
    const s = String(f.value).trim();
    return s.length > 0 ? s : undefined;
  };

  const rfqNo = getApprovedRfqField('rfqNo')!;
  const customer = getApprovedRfqField('customer')!;
  const dueDateStr = getApprovedRfqField('dueDate');
  const customerContact = getApprovedRfqField('customerContact');

  const receivedDate = new Date();
  let dueDate = new Date(receivedDate.getTime() + 14 * 86_400_000);
  if (dueDateStr) {
    const parsedDue = new Date(dueDateStr);
    if (!isNaN(parsedDue.getTime())) {
      dueDate = parsedDue;
    }
  }

  // Assemble approved parts
  const partInputs: CreatePartInput[] = [];
  for (let i = 0; i < draft.partCount; i++) {
    const pFields = draft.fields.filter((x) => x.scope === 'PART' && x.partIndex === i);
    const allRejected = pFields.length > 0 && pFields.every((x) => x.status === 'REJECTED');
    if (allRejected) continue;

    const getVal = (k: PartFieldKey) => {
      const pf = pFields.find((x) => x.key === k);
      if (!pf || !isApprovedStatus(pf.status)) return undefined;
      return pf.value ?? undefined;
    };

    const rawPart = {
      partName: String(getVal('partName') ?? '').trim(),
      material: String(getVal('material') ?? '').trim(),
      grossWeightKg: Number(getVal('grossWeightKg')),
      annualVolume: Number(getVal('annualVolume')),
      drawingNumber: getVal('drawingNumber') ? String(getVal('drawingNumber')).trim() : undefined,
      drawingRevision: getVal('drawingRevision')
        ? String(getVal('drawingRevision')).trim()
        : undefined,
    };

    const parsedPart = CreatePartSchema.safeParse(rawPart);
    if (!parsedPart.success) {
      throw new IntakeError(
        'VALIDATION_FAILED',
        `Part #${i + 1} failed validation: ${parsedPart.error.issues.map((x) => x.message).join('; ')}`,
      );
    }
    partInputs.push(parsedPart.data);
  }

  if (partInputs.length === 0) {
    throw new IntakeError('NOT_READY_TO_COMMIT', 'At least one valid approved part is required.');
  }

  // Check duplicate rfqNo before starting transaction
  const existingRfq = await RFQ.findOne({ rfqNo });
  if (existingRfq) {
    throw new IntakeError('DUPLICATE_RFQ', `An RFQ with number "${rfqNo}" already exists.`);
  }

  const session = await mongoose.startSession();
  try {
    let createdRfq!: IRFQ;
    const createdParts: IPart[] = [];

    await session.withTransaction(async () => {
      const dupInside = await RFQ.findOne({ rfqNo }).session(session);
      if (dupInside) {
        throw new IntakeError('DUPLICATE_RFQ', `An RFQ with number "${rfqNo}" already exists.`);
      }

      createdRfq = await createRFQ(
        {
          rfqNo,
          customer,
          receivedDate,
          dueDate,
          ownerId: params.userId,
          sourceEmailText: draft.originalEmailText,
          customerContact,
        },
        session,
      );

      for (const pi of partInputs) {
        const p = await createPart(createdRfq._id, pi, session);
        createdParts.push(p);
      }

      draft.status = 'COMMITTED';
      draft.committedRfqId = createdRfq._id;
      await draft.save({ session });
    });

    return { rfq: createdRfq, parts: createdParts, draft };
  } finally {
    await session.endSession();
  }
}
