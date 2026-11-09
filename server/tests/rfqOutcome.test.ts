/**
 * tests/rfqOutcome.test.ts
 *
 * Unit & integration tests for RFQ commercial outcome tracking (ESTIMATING → SENT → WON | LOST).
 * Verifies:
 *  1. Valid WON transition.
 *  2. Valid LOST transition.
 *  3. LOST without a reason rejected.
 *  4. OTHER without explanation rejected.
 *  5. WON before any quote is sent rejected.
 *  6. LOST before any quote is sent rejected.
 *  7. Estimator cannot update commercial outcomes.
 *  8. Invalid outcomes rejected.
 *  9. Audit event created correctly (and transaction rolls back on audit failure).
 * 10. Concurrent outcome updates handled safely.
 * 11. Existing quote lifecycle remains unaffected & markAsSent transitions RFQ to SENT.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import mongoose from 'mongoose';

vi.mock('../src/models/RFQ', async () => {
  const actual = await vi.importActual<typeof import('../src/models/RFQ')>('../src/models/RFQ');
  return {
    ...actual,
    RFQ: {
      find: vi.fn(),
      findById: vi.fn(),
      findOneAndUpdate: vi.fn(),
      create: vi.fn(),
    },
  };
});

vi.mock('../src/models/Part', () => ({
  Part: {
    find: vi.fn(),
  },
}));

vi.mock('../src/models/Quote', async () => {
  const actual = await vi.importActual<typeof import('../src/models/Quote')>('../src/models/Quote');
  return {
    ...actual,
    Quote: {
      find: vi.fn(),
      findOne: vi.fn(),
      findOneAndUpdate: vi.fn(),
    },
  };
});

vi.mock('../src/models/QuoteEvent', () => ({
  QuoteEvent: {
    create: vi.fn(),
  },
}));

vi.mock('../src/models/RFQEvent', () => ({
  RFQEvent: {
    find: vi.fn(),
    create: vi.fn(),
  },
}));

import { RFQ } from '../src/models/RFQ';
import { Quote } from '../src/models/Quote';
import { QuoteEvent } from '../src/models/QuoteEvent';
import { RFQEvent } from '../src/models/RFQEvent';
import {
  updateRFQOutcome,
  resolveCommercialOutcome,
  RFQServiceError,
} from '../src/services/rfq.service';
import { markAsSent } from '../src/services/quote.service';
import { UpdateRFQOutcomeSchema } from '../src/validators/rfq.validator';

type Doc = Record<string, any>;

function createOutcomeTestState(params: {
  rfqStatus?: string;
  quotes?: Doc[];
}) {
  const rfqId = new mongoose.Types.ObjectId();
  const ownerId = new mongoose.Types.ObjectId();
  const salesHeadId = new mongoose.Types.ObjectId();
  const salesHead2Id = new mongoose.Types.ObjectId();
  const estimatorId = new mongoose.Types.ObjectId();
  const sentQuoteId = new mongoose.Types.ObjectId();

  const state = {
    rfq: {
      _id: rfqId,
      rfqNo: 'RFQ-2611-099',
      customer: 'Tata AutoComp Systems',
      receivedDate: new Date('2026-05-01T00:00:00.000Z'),
      dueDate: new Date('2026-05-20T00:00:00.000Z'),
      ownerId,
      status: params.rfqStatus ?? 'SENT',
    } as Doc,
    quotes:
      params.quotes ??
      ([
        {
          _id: sentQuoteId,
          rfqId,
          version: 1,
          status: 'SENT',
          annualQuotationValue: '3200000.00',
          sentBy: salesHeadId,
          sentAt: new Date('2026-05-05T10:00:00.000Z'),
        },
      ] as Doc[]),
    rfqEvents: [] as Doc[],
    quoteEvents: [] as Doc[],
    failNextRfqEventWrite: false,
  };

  let txChain: Promise<unknown> = Promise.resolve();

  const session = {
    withTransaction: (fn: () => Promise<void>) => {
      const next = txChain.then(async () => {
        const snapRfq = { ...state.rfq };
        const snapQuotes = state.quotes.map((q) => ({ ...q }));
        const snapRfqEvents = [...state.rfqEvents];
        const snapQuoteEvents = [...state.quoteEvents];
        try {
          await fn();
        } catch (err) {
          state.rfq = snapRfq;
          state.quotes = snapQuotes;
          state.rfqEvents = snapRfqEvents;
          state.quoteEvents = snapQuoteEvents;
          throw err;
        }
      });
      txChain = next.catch(() => undefined);
      return next;
    },
    endSession: async () => undefined,
  };

  vi.spyOn(mongoose, 'startSession').mockResolvedValue(session as never);

  vi.mocked(RFQ.findById).mockImplementation(((id: unknown) => {
    if (String(id) !== String(state.rfq._id)) return Promise.resolve(null);
    return Promise.resolve({ ...state.rfq });
  }) as never);

  vi.mocked(RFQ.findOneAndUpdate).mockImplementation(((
    filter: Doc,
    update: { $set?: Doc; $unset?: Doc },
  ) => {
    const idMatches =
      filter._id === undefined || String(filter._id) === String(state.rfq._id);
    const statusFilter = filter.status;
    const statusMatches =
      statusFilter === undefined ||
      (typeof statusFilter === 'string'
        ? state.rfq.status === statusFilter
        : Array.isArray(statusFilter.$in) && statusFilter.$in.includes(state.rfq.status));

    if (!idMatches || !statusMatches) {
      return Promise.resolve(null);
    }

    if (update.$set) {
      Object.assign(state.rfq, update.$set);
    }
    if (update.$unset) {
      for (const k of Object.keys(update.$unset)) {
        delete state.rfq[k];
      }
    }
    return Promise.resolve({ ...state.rfq });
  }) as never);

  vi.mocked(Quote.findOne).mockImplementation(((filter: Doc) => {
    const matches = state.quotes.filter((q) => {
      if (filter.rfqId && String(q.rfqId) !== String(filter.rfqId)) return false;
      if (filter.version !== undefined && q.version !== filter.version) return false;
      if (filter.status && q.status !== filter.status) return false;
      return true;
    });
    const sorted = [...matches].sort((a, b) => b.version - a.version);
    const found = sorted[0] ? { ...sorted[0] } : null;
    return {
      sort: vi.fn().mockResolvedValue(found),
      then: (onFulfilled: (v: Doc | null) => unknown) => Promise.resolve(found).then(onFulfilled),
    } as never;
  }) as never);

  vi.mocked(Quote.findOneAndUpdate).mockImplementation(((
    filter: Doc,
    update: { $set: Doc },
  ) => {
    const q = state.quotes.find(
      (item) =>
        String(item.rfqId) === String(filter.rfqId) &&
        item.version === filter.version &&
        filter.status.$in.includes(item.status),
    );
    if (!q) return Promise.resolve(null);
    Object.assign(q, update.$set);
    return Promise.resolve({ ...q });
  }) as never);

  vi.mocked(RFQEvent.create).mockImplementation((async (docs: Doc[]) => {
    if (state.failNextRfqEventWrite) {
      state.failNextRfqEventWrite = false;
      throw new Error('Simulated RFQEvent write failure');
    }
    const created = docs.map((d) => ({ _id: new mongoose.Types.ObjectId(), ...d }));
    state.rfqEvents.push(...created);
    return created;
  }) as never);

  vi.mocked(QuoteEvent.create).mockImplementation((async (docs: Doc[]) => {
    const created = docs.map((d) => ({ _id: new mongoose.Types.ObjectId(), ...d }));
    state.quoteEvents.push(...created);
    return created;
  }) as never);

  return {
    state,
    rfqId,
    ownerId,
    salesHeadId,
    salesHead2Id,
    estimatorId,
    sentQuoteId,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('RFQ Commercial Outcome Tracking', () => {
  it('1. Valid WON transition updates status, outcomeUpdatedBy, outcomeUpdatedAt and clears lostReason', async () => {
    const { state, rfqId, salesHeadId } = createOutcomeTestState({ rfqStatus: 'SENT' });

    const result = await updateRFQOutcome({
      rfqId: String(rfqId),
      outcome: 'WON',
      actorId: String(salesHeadId),
      actorRole: 'SALES_HEAD',
    });

    expect(result.rfq.status).toBe('WON');
    expect(result.rfq.outcomeUpdatedBy).toBe(String(salesHeadId));
    expect(result.rfq.outcomeUpdatedAt).toBeInstanceOf(Date);
    expect(result.rfq.lostReason).toBeUndefined();
    expect(state.rfq.status).toBe('WON');
  });

  it('2. Valid LOST transition stores lostReason, optional lostReasonNote, outcomeUpdatedBy, and outcomeUpdatedAt', async () => {
    const { state, rfqId, salesHeadId } = createOutcomeTestState({ rfqStatus: 'SENT' });

    const result = await updateRFQOutcome({
      rfqId: String(rfqId),
      outcome: 'LOST',
      lostReason: 'PRICE_TOO_HIGH',
      lostReasonNote: 'Customer selected a competitor quoting 6% lower.',
      actorId: String(salesHeadId),
      actorRole: 'SALES_HEAD',
    });

    expect(result.rfq.status).toBe('LOST');
    expect(result.rfq.lostReason).toBe('PRICE_TOO_HIGH');
    expect(result.rfq.lostReasonNote).toBe('Customer selected a competitor quoting 6% lower.');
    expect(result.rfq.outcomeUpdatedBy).toBe(String(salesHeadId));
    expect(result.rfq.outcomeUpdatedAt).toBeInstanceOf(Date);
    expect(state.rfq.status).toBe('LOST');
  });

  it('3. LOST without a reason is rejected at both Zod validator and service layers', async () => {
    const { state, rfqId, salesHeadId } = createOutcomeTestState({ rfqStatus: 'SENT' });

    // Zod schema check
    const zodResult = UpdateRFQOutcomeSchema.safeParse({ outcome: 'LOST' });
    expect(zodResult.success).toBe(false);

    // Service layer check
    await expect(
      updateRFQOutcome({
        rfqId: String(rfqId),
        outcome: 'LOST',
        actorId: String(salesHeadId),
        actorRole: 'SALES_HEAD',
      }),
    ).rejects.toMatchObject({
      code: 'LOST_REASON_REQUIRED',
      statusCode: 400,
    });

    expect(state.rfq.status).toBe('SENT');
    expect(state.rfqEvents).toHaveLength(0);
  });

  it('4. OTHER without a meaningful explanation is rejected at both Zod validator and service layers', async () => {
    const { state, rfqId, salesHeadId } = createOutcomeTestState({ rfqStatus: 'SENT' });

    // Zod schema check with empty / short note
    expect(
      UpdateRFQOutcomeSchema.safeParse({
        outcome: 'LOST',
        lostReason: 'OTHER',
        lostReasonNote: 'abc',
      }).success,
    ).toBe(false);

    // Service layer check
    await expect(
      updateRFQOutcome({
        rfqId: String(rfqId),
        outcome: 'LOST',
        lostReason: 'OTHER',
        lostReasonNote: '   ',
        actorId: String(salesHeadId),
        actorRole: 'SALES_HEAD',
      }),
    ).rejects.toMatchObject({
      code: 'LOST_REASON_NOTE_REQUIRED',
      statusCode: 400,
    });

    expect(state.rfq.status).toBe('SENT');
    expect(state.rfqEvents).toHaveLength(0);
  });

  it('5. WON before any quote is sent is rejected with QUOTE_NOT_SENT (422)', async () => {
    const rfqId = new mongoose.Types.ObjectId();
    const { state, salesHeadId } = createOutcomeTestState({
      rfqStatus: 'ESTIMATING',
      quotes: [
        {
          _id: new mongoose.Types.ObjectId(),
          rfqId,
          version: 1,
          status: 'APPROVED', // Approved, but NOT sent to customer yet
          annualQuotationValue: '3000000.00',
        },
      ],
    });

    await expect(
      updateRFQOutcome({
        rfqId: String(state.rfq._id),
        outcome: 'WON',
        actorId: String(salesHeadId),
        actorRole: 'SALES_HEAD',
      }),
    ).rejects.toMatchObject({
      code: 'QUOTE_NOT_SENT',
      statusCode: 422,
    });

    expect(state.rfq.status).toBe('ESTIMATING');
    expect(state.rfqEvents).toHaveLength(0);
  });

  it('6. LOST before any quote is sent is rejected with QUOTE_NOT_SENT (422)', async () => {
    const { state, salesHeadId } = createOutcomeTestState({
      rfqStatus: 'ESTIMATING',
      quotes: [],
    });

    await expect(
      updateRFQOutcome({
        rfqId: String(state.rfq._id),
        outcome: 'LOST',
        lostReason: 'PRICE_TOO_HIGH',
        actorId: String(salesHeadId),
        actorRole: 'SALES_HEAD',
      }),
    ).rejects.toMatchObject({
      code: 'QUOTE_NOT_SENT',
      statusCode: 422,
    });

    expect(state.rfq.status).toBe('ESTIMATING');
    expect(state.rfqEvents).toHaveLength(0);
  });

  it('7. Estimator cannot update commercial outcomes (FORBIDDEN_ROLE 403)', async () => {
    const { state, rfqId, estimatorId } = createOutcomeTestState({ rfqStatus: 'SENT' });

    await expect(
      updateRFQOutcome({
        rfqId: String(rfqId),
        outcome: 'WON',
        actorId: String(estimatorId),
        actorRole: 'ESTIMATOR',
      }),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN_ROLE',
      statusCode: 403,
    });

    expect(state.rfq.status).toBe('SENT');
    expect(state.rfqEvents).toHaveLength(0);
  });

  it('8. Invalid outcomes and transitions from terminal WON/LOST states are rejected', async () => {
    const { state, rfqId, salesHeadId } = createOutcomeTestState({ rfqStatus: 'SENT' });

    // Zod rejects ESTIMATING, SENT, or unknown values on outcome endpoint
    expect(UpdateRFQOutcomeSchema.safeParse({ outcome: 'ESTIMATING' }).success).toBe(false);
    expect(UpdateRFQOutcomeSchema.safeParse({ outcome: 'SENT' }).success).toBe(false);
    expect(UpdateRFQOutcomeSchema.safeParse({ outcome: 'CANCELLED' }).success).toBe(false);

    // Service rejects invalid outcome
    await expect(
      updateRFQOutcome({
        rfqId: String(rfqId),
        outcome: 'ESTIMATING' as never,
        actorId: String(salesHeadId),
        actorRole: 'SALES_HEAD',
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_OUTCOME',
      statusCode: 400,
    });

    // Once marked WON, cannot transition to LOST
    await updateRFQOutcome({
      rfqId: String(rfqId),
      outcome: 'WON',
      actorId: String(salesHeadId),
      actorRole: 'SALES_HEAD',
    });
    expect(state.rfq.status).toBe('WON');

    await expect(
      updateRFQOutcome({
        rfqId: String(rfqId),
        outcome: 'LOST',
        lostReason: 'CUSTOMER_CANCELLED',
        actorId: String(salesHeadId),
        actorRole: 'SALES_HEAD',
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_OUTCOME_TRANSITION',
      statusCode: 409,
    });
  });

  it('9. Audit event is created atomically, and audit write failure rolls back RFQ status', async () => {
    const { state, rfqId, salesHeadId, sentQuoteId } = createOutcomeTestState({
      rfqStatus: 'SENT',
    });

    // First simulate an audit failure: RFQ must remain SENT
    state.failNextRfqEventWrite = true;
    await expect(
      updateRFQOutcome({
        rfqId: String(rfqId),
        outcome: 'LOST',
        lostReason: 'COMPETITOR_SELECTED',
        lostReasonNote: 'Competitor had existing tooling.',
        actorId: String(salesHeadId),
        actorRole: 'SALES_HEAD',
      }),
    ).rejects.toThrow('Simulated RFQEvent write failure');

    expect(state.rfq.status).toBe('SENT');
    expect(state.rfq.lostReason).toBeUndefined();
    expect(state.rfqEvents).toHaveLength(0);

    // Now succeed and verify audit event fields
    const res = await updateRFQOutcome({
      rfqId: String(rfqId),
      outcome: 'LOST',
      lostReason: 'COMPETITOR_SELECTED',
      lostReasonNote: 'Competitor had existing tooling.',
      actorId: String(salesHeadId),
      actorRole: 'SALES_HEAD',
    });

    expect(state.rfqEvents).toHaveLength(1);
    expect(res.auditEvent).toMatchObject({
      rfqId: String(rfqId),
      action: 'LOST',
      previousStatus: 'SENT',
      newStatus: 'LOST',
      actorId: String(salesHeadId),
      lostReason: 'COMPETITOR_SELECTED',
      lostReasonNote: 'Competitor had existing tooling.',
      quoteId: String(sentQuoteId),
      quoteVersion: 1,
    });
  });

  it('10. Concurrent outcome updates are handled safely: exactly one wins, second gets OUTCOME_CONFLICT', async () => {
    const { state, rfqId, salesHeadId, salesHead2Id } = createOutcomeTestState({
      rfqStatus: 'SENT',
    });

    const results = await Promise.allSettled([
      updateRFQOutcome({
        rfqId: String(rfqId),
        outcome: 'WON',
        actorId: String(salesHeadId),
        actorRole: 'SALES_HEAD',
      }),
      updateRFQOutcome({
        rfqId: String(rfqId),
        outcome: 'LOST',
        lostReason: 'DELIVERY_TIMELINE',
        actorId: String(salesHead2Id),
        actorRole: 'SALES_HEAD',
      }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(RFQServiceError);
    expect(rejected[0].reason.code).toBe('OUTCOME_CONFLICT');
    expect(state.rfqEvents).toHaveLength(1);
    expect(state.rfq.status).toBe('WON');
  });

  it('11. Existing quote lifecycle remains unaffected and markAsSent transitions RFQ from ESTIMATING to SENT', async () => {
    const rfqId = new mongoose.Types.ObjectId();
    const quoteId = new mongoose.Types.ObjectId();
    const { state, salesHeadId } = createOutcomeTestState({
      rfqStatus: 'ESTIMATING',
      quotes: [
        {
          _id: quoteId,
          rfqId,
          version: 1,
          status: 'APPROVED',
          annualQuotationValue: '4500000.00',
        },
      ],
    });
    // Ensure quote.rfqId matches state.rfq._id
    state.quotes[0].rfqId = state.rfq._id;

    // 1. Mark quote as SENT via quote.service.ts
    const sentQuote = await markAsSent(state.rfq._id, 1, salesHeadId);
    expect(sentQuote.status).toBe('SENT');
    expect(state.quoteEvents).toHaveLength(1);
    expect(state.quoteEvents[0].action).toBe('SENT');

    // RFQ commercial outcome automatically transitioned to SENT
    expect(state.rfq.status).toBe('SENT');
    expect(state.rfqEvents).toHaveLength(1);
    expect(state.rfqEvents[0].action).toBe('SENT');

    // 2. Now update RFQ commercial outcome to WON
    await updateRFQOutcome({
      rfqId: String(state.rfq._id),
      outcome: 'WON',
      actorId: String(salesHeadId),
      actorRole: 'SALES_HEAD',
    });

    // Quote status and QuoteEvent history remain untouched
    expect(state.quotes[0].status).toBe('SENT');
    expect(state.quoteEvents).toHaveLength(1);
    expect(state.rfq.status).toBe('WON');
    expect(state.rfqEvents).toHaveLength(2);
    expect(resolveCommercialOutcome('PENDING_APPROVAL', false)).toBe('ESTIMATING');
    expect(resolveCommercialOutcome('ESTIMATING', true)).toBe('SENT');
  });
});
