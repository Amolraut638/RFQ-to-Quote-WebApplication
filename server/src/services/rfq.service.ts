/**
 * services/rfq.service.ts
 *
 * RFQ business logic, register queries, and commercial outcome tracking.
 */

import mongoose, { type ClientSession } from 'mongoose';
import {
  RFQ,
  IRFQ,
  type LostReason,
  type RFQCommercialOutcome,
} from '../models/RFQ';
import { Part } from '../models/Part';
import { Quote, type QuoteStatus } from '../models/Quote';
import { RFQEvent, type IRFQEvent } from '../models/RFQEvent';

const VALID_LOST_REASONS: readonly LostReason[] = [
  'PRICE_TOO_HIGH',
  'DELIVERY_TIMELINE',
  'COMPETITOR_SELECTED',
  'TECHNICAL_REJECTION',
  'CUSTOMER_CANCELLED',
  'OTHER',
];

// ─── Error handling ───────────────────────────────────────────────────────────

export type RFQServiceErrorCode =
  | 'INVALID_RFQ_ID'
  | 'INVALID_ACTOR_ID'
  | 'RFQ_NOT_FOUND'
  | 'FORBIDDEN_ROLE'
  | 'INVALID_OUTCOME'
  | 'LOST_REASON_REQUIRED'
  | 'LOST_REASON_NOTE_REQUIRED'
  | 'QUOTE_NOT_SENT'
  | 'INVALID_OUTCOME_TRANSITION'
  | 'OUTCOME_CONFLICT';

export class RFQServiceError extends Error {
  public readonly code: RFQServiceErrorCode;
  public readonly statusCode: number;

  constructor(code: RFQServiceErrorCode, message: string, statusCode = 400) {
    super(message);
    this.name = 'RFQServiceError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PopulatedUserSummary {
  _id: unknown;
  name: string;
  email: string;
  role: string;
}

/** Plain (lean) RFQ shape returned to controllers; ownerId is populated. */
export interface RFQListItem {
  _id: unknown;
  rfqNo: string;
  customer: string;
  receivedDate: Date;
  dueDate: Date;
  ownerId: PopulatedUserSummary | null;
  status: RFQCommercialOutcome;
  lostReason?: LostReason | string;
  lostReasonNote?: string;
  outcomeUpdatedBy?: PopulatedUserSummary | null;
  outcomeUpdatedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
  /** First part's name, shown in the register. */
  partName?: string;
  /** Total number of parts in this RFQ. */
  partCount: number;
  /** Latest relevant quote status (separated from RFQ commercial outcome). */
  latestQuoteStatus: QuoteStatus | null;
  /** Version number of the latest relevant quote. */
  latestQuoteVersion: number | null;
  /** True if at least one quote version for this RFQ has been marked SENT. */
  hasSentQuote: boolean;
}

export interface UpdateRFQOutcomeParams {
  rfqId: string;
  outcome: 'WON' | 'LOST';
  lostReason?: LostReason;
  lostReasonNote?: string;
  actorId: string;
  actorRole: string;
}

export interface UpdateRFQOutcomeResult {
  rfq: Record<string, unknown>;
  auditEvent: Record<string, unknown>;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Derive the normalized RFQ commercial outcome ('ESTIMATING' | 'SENT' | 'WON' | 'LOST').
 * - WON and LOST are terminal commercial outcomes.
 * - If status is SENT, or if any quote for the RFQ has status === 'SENT', commercial outcome is 'SENT'.
 * - Otherwise commercial outcome is 'ESTIMATING'.
 */
export function resolveCommercialOutcome(
  rawStatus: IRFQ['status'],
  hasSentQuote: boolean,
): RFQCommercialOutcome {
  if (rawStatus === 'WON') return 'WON';
  if (rawStatus === 'LOST') return 'LOST';
  if (rawStatus === 'SENT' || hasSentQuote) return 'SENT';
  return 'ESTIMATING';
}

// ─── Queries & Mutations ──────────────────────────────────────────────────────

export async function listRFQs(): Promise<RFQListItem[]> {
  const rfqs = (await RFQ.find()
    .populate('ownerId', 'name email role')
    .populate('outcomeUpdatedBy', 'name email role')
    .sort({ dueDate: 1 })
    .lean()) as unknown as Array<Record<string, any>>;

  const rfqIds = rfqs.map((r) => r._id);

  const [parts, quotes] = await Promise.all([
    Part.find({ rfqId: { $in: rfqIds } }).lean(),
    Quote.find({ rfqId: { $in: rfqIds } })
      .select('rfqId version status sentAt updatedAt')
      .sort({ version: 1 })
      .lean(),
  ]);

  const firstPartByRfq = new Map<string, string>();
  const partCountByRfq = new Map<string, number>();
  for (const p of parts) {
    const key = String(p.rfqId);
    if (!firstPartByRfq.has(key)) firstPartByRfq.set(key, p.partName);
    partCountByRfq.set(key, (partCountByRfq.get(key) ?? 0) + 1);
  }

  const latestQuoteByRfq = new Map<string, { status: QuoteStatus; version: number }>();
  const hasSentQuoteByRfq = new Map<string, boolean>();
  for (const q of quotes) {
    const key = String(q.rfqId);
    // Because quotes are sorted by version ascending, each iteration overwrites with a newer version
    latestQuoteByRfq.set(key, { status: q.status, version: q.version });
    if (q.status === 'SENT') {
      hasSentQuoteByRfq.set(key, true);
    }
  }

  return rfqs.map((r) => {
    const key = String(r._id);
    const hasSentQuote = hasSentQuoteByRfq.get(key) ?? r.status === 'SENT';
    const latestQuote = latestQuoteByRfq.get(key) ?? null;
    const normalizedStatus = resolveCommercialOutcome(r.status, hasSentQuote);

    return {
      ...r,
      status: normalizedStatus,
      partName: firstPartByRfq.get(key),
      partCount: partCountByRfq.get(key) ?? 0,
      latestQuoteStatus: latestQuote?.status ?? null,
      latestQuoteVersion: latestQuote?.version ?? null,
      hasSentQuote,
    } as RFQListItem;
  });
}

export async function getRFQById(id: string): Promise<Record<string, unknown> | null> {
  if (!mongoose.Types.ObjectId.isValid(id)) return null;

  const rfq = await RFQ.findById(id)
    .populate('ownerId', 'name email role')
    .populate('outcomeUpdatedBy', 'name email role')
    .lean();
  if (!rfq) return null;

  const [parts, quotes, outcomeEvents] = await Promise.all([
    Part.find({ rfqId: id }).lean(),
    Quote.find({ rfqId: id }).select('version status sentAt').sort({ version: 1 }).lean(),
    RFQEvent.find({ rfqId: id })
      .populate('actorId', 'name email role')
      .sort({ timestamp: 1 })
      .lean(),
  ]);

  const hasSentQuote = quotes.some((q) => q.status === 'SENT') || rfq.status === 'SENT';
  const latestQuote = quotes.length > 0 ? quotes[quotes.length - 1] : null;
  const normalizedStatus = resolveCommercialOutcome(rfq.status, hasSentQuote);

  return {
    ...(rfq as unknown as Record<string, unknown>),
    status: normalizedStatus,
    parts,
    partCount: parts.length,
    hasSentQuote,
    latestQuoteStatus: latestQuote?.status ?? null,
    latestQuoteVersion: latestQuote?.version ?? null,
    outcomeEvents,
  };
}

export async function createRFQ(
  data: {
    rfqNo: string;
    customer: string;
    receivedDate: Date;
    dueDate: Date;
    ownerId: string;
    sourceEmailText?: string;
    customerContact?: string;
  },
  session?: ClientSession,
): Promise<IRFQ> {
  if (session) {
    const [doc] = await RFQ.create([data], { session });
    return doc;
  }
  return RFQ.create(data);
}

/**
 * Update RFQ commercial outcome to WON or LOST.
 *
 * Enforces:
 *  1. Role check: only SALES_HEAD may record commercial outcomes.
 *  2. Valid outcome: only 'WON' or 'LOST'.
 *  3. LOST requires a valid lostReason from LOST_REASONS.
 *  4. OTHER requires a meaningful lostReasonNote (>= 5 characters).
 *  5. WON does not require lostReason and clears any prior lostReason fields.
 *  6. At least one Quote for this RFQ must have status === 'SENT'.
 *  7. RFQ cannot already be in a terminal outcome ('WON' or 'LOST').
 *  8. Atomic conditional update + immutable RFQEvent creation in one transaction.
 */
export async function updateRFQOutcome(
  params: UpdateRFQOutcomeParams,
): Promise<UpdateRFQOutcomeResult> {
  const { rfqId, outcome, lostReason, lostReasonNote, actorId, actorRole } = params;

  // Rule 8: Role check
  if (actorRole !== 'SALES_HEAD') {
    throw new RFQServiceError(
      'FORBIDDEN_ROLE',
      'Only SALES_HEAD users are authorized to update RFQ commercial outcomes.',
      403,
    );
  }

  if (!mongoose.Types.ObjectId.isValid(rfqId)) {
    throw new RFQServiceError('INVALID_RFQ_ID', `Invalid rfqId: "${rfqId}"`, 400);
  }
  if (!mongoose.Types.ObjectId.isValid(actorId)) {
    throw new RFQServiceError('INVALID_ACTOR_ID', `Invalid actorId: "${actorId}"`, 400);
  }

  // Validate outcome value
  if (outcome !== 'WON' && outcome !== 'LOST') {
    throw new RFQServiceError(
      'INVALID_OUTCOME',
      `Invalid commercial outcome "${String(outcome)}". Only WON or LOST are allowed.`,
      400,
    );
  }

  // Rule 4 & 5: Validate lostReason and lostReasonNote
  const trimmedNote = lostReasonNote?.trim() ?? '';
  if (outcome === 'LOST') {
    if (!lostReason || !VALID_LOST_REASONS.includes(lostReason)) {
      throw new RFQServiceError(
        'LOST_REASON_REQUIRED',
        'A valid lostReason is required when marking an RFQ as LOST.',
        400,
      );
    }
    if (lostReason === 'OTHER' && trimmedNote.length < 5) {
      throw new RFQServiceError(
        'LOST_REASON_NOTE_REQUIRED',
        'A meaningful explanation (at least 5 characters) is required when lostReason is OTHER.',
        400,
      );
    }
  }

  const rfqObjectId = new mongoose.Types.ObjectId(rfqId);
  const actorObjectId = new mongoose.Types.ObjectId(actorId);

  // Load RFQ to verify existence and current status
  const existingRfq = await RFQ.findById(rfqObjectId);
  if (!existingRfq) {
    throw new RFQServiceError('RFQ_NOT_FOUND', `RFQ "${rfqId}" not found.`, 404);
  }

  // Rule 9: Reject invalid transitions from terminal states
  if (existingRfq.status === 'WON' || existingRfq.status === 'LOST') {
    throw new RFQServiceError(
      'INVALID_OUTCOME_TRANSITION',
      `RFQ is already marked as ${existingRfq.status} and cannot be transitioned to ${outcome}.`,
      409,
    );
  }

  // Rule 2 & 3: An RFQ can become WON or LOST only after at least one quote has been SENT
  const sentQuote = await Quote.findOne({ rfqId: rfqObjectId, status: 'SENT' }).sort({
    version: -1,
  });
  if (!sentQuote) {
    throw new RFQServiceError(
      'QUOTE_NOT_SENT',
      `Cannot mark RFQ as ${outcome} before at least one customer quote has been sent.`,
      422,
    );
  }

  const now = new Date();
  const session = await mongoose.startSession();
  try {
    let updatedRfq: IRFQ | null = null;
    let createdEvent: IRFQEvent | undefined;

    await session.withTransaction(async () => {
      const setFields: Record<string, unknown> = {
        status: outcome,
        outcomeUpdatedBy: actorObjectId,
        outcomeUpdatedAt: now,
      };
      const unsetFields: Record<string, 1> = {};

      if (outcome === 'LOST') {
        setFields.lostReason = lostReason;
        if (trimmedNote) {
          setFields.lostReasonNote = trimmedNote;
        } else {
          unsetFields.lostReasonNote = 1;
        }
      } else {
        // WON: never store lostReason or lostReasonNote
        unsetFields.lostReason = 1;
        unsetFields.lostReasonNote = 1;
      }

      const updateOperation: Record<string, unknown> = { $set: setFields };
      if (Object.keys(unsetFields).length > 0) {
        updateOperation.$unset = unsetFields;
      }

      updatedRfq = await RFQ.findOneAndUpdate(
        {
          _id: rfqObjectId,
          status: { $in: ['ESTIMATING', 'PENDING_APPROVAL', 'SENT'] },
        },
        updateOperation,
        { new: true, session },
      );

      if (!updatedRfq) {
        throw new RFQServiceError(
          'OUTCOME_CONFLICT',
          `RFQ "${rfqId}" commercial outcome was already updated by a concurrent request.`,
          409,
        );
      }

      const [ev] = await RFQEvent.create(
        [
          {
            rfqId: rfqObjectId,
            action: outcome,
            previousStatus: 'SENT',
            newStatus: outcome,
            actorId: actorObjectId,
            timestamp: now,
            ...(outcome === 'LOST'
              ? {
                  lostReason,
                  ...(trimmedNote ? { lostReasonNote: trimmedNote } : {}),
                }
              : {}),
            quoteId: sentQuote._id,
            quoteVersion: sentQuote.version,
          },
        ],
        { session },
      );
      createdEvent = ev;
    });

    const rawRfq =
      updatedRfq && typeof (updatedRfq as IRFQ).toObject === 'function'
        ? (updatedRfq as IRFQ).toObject()
        : (updatedRfq as unknown as Record<string, unknown>);
    const rawEvent =
      createdEvent && typeof createdEvent.toObject === 'function'
        ? createdEvent.toObject()
        : (createdEvent as unknown as Record<string, unknown>);

    return {
      rfq: {
        ...rawRfq,
        _id: String(rawRfq._id),
        ownerId: rawRfq.ownerId ? String(rawRfq.ownerId) : undefined,
        outcomeUpdatedBy: rawRfq.outcomeUpdatedBy ? String(rawRfq.outcomeUpdatedBy) : undefined,
      },
      auditEvent: {
        ...rawEvent,
        _id: rawEvent?._id ? String(rawEvent._id) : undefined,
        rfqId: rawEvent?.rfqId ? String(rawEvent.rfqId) : String(rfqObjectId),
        actorId: rawEvent?.actorId ? String(rawEvent.actorId) : String(actorObjectId),
        quoteId: rawEvent?.quoteId ? String(rawEvent.quoteId) : String(sentQuote._id),
      },
    };
  } finally {
    await session.endSession();
  }
}

