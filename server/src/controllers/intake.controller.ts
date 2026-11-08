/**
 * controllers/intake.controller.ts
 *
 * HTTP handlers for AI-assisted RFQ intake and historical routing suggestions.
 * Never logs document contents or API keys.
 */

import { Request, Response, NextFunction } from 'express';
import {
  EmailIntakeSchema,
  PatchDraftFieldsSchema,
} from '../validators/intake.validator';
import {
  createOrMergeEmailIntake,
  createOrMergeUploadIntake,
  getDraftForUser,
  updateDraftFields,
  commitIntakeDraft,
  evaluateDraftReadiness,
} from '../services/intake/intake.service';
import { getRoutingSuggestionForPart } from '../services/intake/routingSuggestion.service';
import { IntakeError } from '../services/intake/fileValidation.service';
import { AIError } from '../services/ai/AIProvider';
import { getAIProvider } from '../services/ai/GeminiProvider';
import type { IIntakeDraft } from '../models/IntakeDraft';

function serializeDraft(draft: IIntakeDraft) {
  const readiness = evaluateDraftReadiness(draft.fields, draft.partCount);
  return {
    _id: String(draft._id),
    createdBy: String(draft.createdBy),
    sourceType: draft.sourceType,
    sources: draft.sources,
    ai: draft.ai,
    fields: draft.fields,
    partCount: draft.partCount,
    status: draft.status,
    readiness,
    committedRfqId: draft.committedRfqId ? String(draft.committedRfqId) : null,
    createdAt: draft.createdAt,
    updatedAt: draft.updatedAt,
  };
}

export function handleIntakeError(
  err: unknown,
  res: Response,
  next: NextFunction,
): void {
  if (err instanceof AIError) {
    const statusMap: Record<AIError['code'], number> = {
      AI_NOT_CONFIGURED: 503,
      AI_UNAVAILABLE: 503,
      AI_TIMEOUT: 504,
      AI_RATE_LIMITED: 429,
      AI_INVALID_RESPONSE: 502,
      AI_COST_FIELD_REJECTED: 422,
    };
    res.status(statusMap[err.code] ?? 502).json({
      error: err.message,
      code: err.code,
    });
    return;
  }

  if (err instanceof IntakeError) {
    const statusMap: Record<IntakeError['code'], number> = {
      NO_FILE: 400,
      FILE_TOO_LARGE: 413,
      UNSUPPORTED_FILE_TYPE: 415,
      FILE_CONTENT_MISMATCH: 415,
      MALFORMED_FILE: 422,
      TOO_MANY_PAGES: 422,
      SCANNED_PDF_UNSUPPORTED: 422,
      EMPTY_DOCUMENT: 422,
      DRAFT_NOT_FOUND: 404,
      DRAFT_NOT_EDITABLE: 409,
      VALIDATION_FAILED: 400,
      DUPLICATE_RFQ: 409,
      NOT_READY_TO_COMMIT: 400,
      INVALID_ID: 400,
    };
    res.status(statusMap[err.code] ?? 400).json({
      error: err.message,
      code: err.code,
      ...(err.details ? { details: err.details } : {}),
    });
    return;
  }

  next(err);
}

/** GET /api/intake/status — returns provider & model metadata (never API keys). */
export async function getIntakeStatusHandler(
  _req: Request,
  res: Response,
): Promise<void> {
  const provider = getAIProvider();
  res.json({ success: true, data: provider.status() });
}

/** POST /api/intake/email */
export async function emailIntakeHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const parsed = EmailIntakeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: parsed.error.issues[0]?.message ?? 'Validation failed',
        code: 'VALIDATION_FAILED',
        details: parsed.error.flatten(),
      });
      return;
    }

    const draft = await createOrMergeEmailIntake({
      userId: req.user!.id,
      emailText: parsed.data.emailText,
      draftId: parsed.data.draftId,
    });

    res.status(201).json({ success: true, data: serializeDraft(draft) });
  } catch (err) {
    handleIntakeError(err, res, next);
  }
}

/** POST /api/intake/upload */
export async function uploadIntakeHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const file = (req as Request & { file?: Express.Multer.File }).file;
    const draftId =
      typeof req.body?.draftId === 'string' && req.body.draftId.trim()
        ? req.body.draftId.trim()
        : undefined;

    const draft = await createOrMergeUploadIntake({
      userId: req.user!.id,
      file,
      draftId,
    });

    res.status(201).json({ success: true, data: serializeDraft(draft) });
  } catch (err) {
    handleIntakeError(err, res, next);
  }
}

/** GET /api/intake/:id */
export async function getIntakeDraftHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const draft = await getDraftForUser(req.params.id, req.user!.id);
    res.json({ success: true, data: serializeDraft(draft) });
  } catch (err) {
    handleIntakeError(err, res, next);
  }
}

/** PATCH /api/intake/:id/fields */
export async function patchIntakeFieldsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const parsed = PatchDraftFieldsSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: parsed.error.issues[0]?.message ?? 'Validation failed',
        code: 'VALIDATION_FAILED',
        details: parsed.error.flatten(),
      });
      return;
    }

    const draft = await updateDraftFields({
      draftId: req.params.id,
      userId: req.user!.id,
      updates: parsed.data.updates,
      addPart: parsed.data.addPart,
    });

    res.json({ success: true, data: serializeDraft(draft) });
  } catch (err) {
    handleIntakeError(err, res, next);
  }
}

/** POST /api/intake/:id/commit */
export async function commitIntakeDraftHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const result = await commitIntakeDraft({
      draftId: req.params.id,
      userId: req.user!.id,
      extraPayload:
        req.body && typeof req.body === 'object'
          ? (req.body as Record<string, unknown>)
          : undefined,
    });

    res.status(201).json({
      success: true,
      data: {
        rfq: result.rfq,
        parts: result.parts,
        draft: serializeDraft(result.draft),
      },
    });
  } catch (err) {
    handleIntakeError(err, res, next);
  }
}

/** GET /api/parts/:id/routing-suggestions */
export async function getPartRoutingSuggestionsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const suggestion = await getRoutingSuggestionForPart(req.params.id);
    res.json({ success: true, data: suggestion });
  } catch (err) {
    handleIntakeError(err, res, next);
  }
}

