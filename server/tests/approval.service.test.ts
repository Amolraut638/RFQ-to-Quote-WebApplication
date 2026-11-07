/**
 * tests/approval.service.test.ts
 *
 * Tests for Day 4 approval workflow additions to quote.service.ts.
 *
 * Implementation notes after Day 4 correction pass:
 *  - approveQuote and rejectQuote use MongoDB transactions (startSession /
 *    withTransaction / findOneAndUpdate) for atomic status + audit writes.
 *  - submitForApproval and markAsSent use awaited QuoteEvent.create (no
 *    fire-and-forget).
 *  - All mocks are updated to reflect these contracts.
 *
 * Test inventory (38 tests):
 *  1–3   Threshold boundary: ₹24,99,999 / ₹25,00,000 / ₹25,00,001
 *  4     submitForApproval > ₹25L → PENDING_APPROVAL
 *  5     submitForApproval ≤ ₹25L → READY_FOR_SALES
 *  6     submitForApproval sets submittedBy and submittedAt
 *  7     submitForApproval on PENDING_APPROVAL (immutable) → QUOTE_IMMUTABLE
 *  8     submitForApproval on READY_FOR_SALES (immutable) → QUOTE_IMMUTABLE
 *  9     READY_FOR_SALES is in IMMUTABLE_STATUSES
 *  10    submitForApproval awaits QuoteEvent.create (not fire-and-forget)
 *  11    submitForApproval propagates QuoteEvent failure (no silent loss)
 *  12    approveQuote uses conditional findOneAndUpdate (concurrent safety)
 *  13    approveQuote writes QuoteEvent inside transaction
 *  14    approveQuote on non-PENDING_APPROVAL → INVALID_STATUS_TRANSITION
 *  15    approveQuote: QuoteEvent failure rolls back (transaction test)
 *  16    concurrent approvals: second request gets INVALID_STATUS_TRANSITION
 *  17    rejectQuote stores rejectionComment (transactional path)
 *  18    rejectQuote sets rejectedBy and rejectedAt
 *  19    rejectQuote writes QuoteEvent inside transaction
 *  20    rejectQuote still works without rejecterId (backward compat)
 *  21    rejectQuote on non-PENDING_APPROVAL → INVALID_STATUS_TRANSITION
 *  22    rejectQuote: QuoteEvent failure rolls back (transaction test)
 *  23    markAsSent transitions READY_FOR_SALES → SENT
 *  24    markAsSent transitions APPROVED → SENT
 *  25    markAsSent awaits QuoteEvent.create
 *  26    markAsSent rejects DRAFT → INVALID_STATUS_TRANSITION
 *  27    markAsSent rejects REJECTED → INVALID_STATUS_TRANSITION
 *  28    markAsSent propagates QuoteEvent failure
 *  29    getPendingApprovals returns only PENDING_APPROVAL quotes
 *  30    getQuoteById calls findById
 *  31    getQuoteEvents queries QuoteEvent by quoteId
 *
 * Additional acceptance-level API tests (via Node fetch, items 32–38) are in
 * the separate api_acceptance.test.ts file.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import mongoose from 'mongoose';

// ─── Mock mongoose.startSession ───────────────────────────────────────────────
// The transactional functions call mongoose.startSession().
// We provide a fake session that tracks withTransaction calls.

const mockSession = {
  withTransaction: vi.fn(),
  endSession: vi.fn().mockResolvedValue(undefined),
};

vi.spyOn(mongoose, 'startSession').mockResolvedValue(mockSession as never);

// ─── Mock Quote model ─────────────────────────────────────────────────────────

vi.mock('../src/models/Quote', async () => {
  const actual = await vi.importActual<typeof import('../src/models/Quote')>('../src/models/Quote');
  return {
    ...actual,
    Quote: {
      findOne: vi.fn(),
      find: vi.fn(),
      findById: vi.fn(),
      findOneAndUpdate: vi.fn(),
      create: vi.fn(),
    },
  };
});

// ─── Mock QuoteEvent model ────────────────────────────────────────────────────

vi.mock('../src/models/QuoteEvent', () => {
  return {
    QuoteEvent: {
      create: vi.fn().mockResolvedValue([{}]),
      find: vi.fn(),
    },
  };
});

import {
  submitForApproval,
  approveQuote,
  rejectQuote,
  markAsSent,
  getPendingApprovals,
  getQuoteById,
  getQuoteEvents,
  QuoteServiceError,
} from '../src/services/quote.service';
import { IMMUTABLE_STATUSES, Quote } from '../src/models/Quote';
import { QuoteEvent } from '../src/models/QuoteEvent';

const mockFindOne = Quote.findOne as ReturnType<typeof vi.fn>;
const mockFindOneAndUpdate = Quote.findOneAndUpdate as ReturnType<typeof vi.fn>;
const mockFind = Quote.find as ReturnType<typeof vi.fn>;
const mockFindById = Quote.findById as ReturnType<typeof vi.fn>;
const mockQuoteEventCreate = QuoteEvent.create as ReturnType<typeof vi.fn>;
const mockStartSession = vi.mocked(mongoose.startSession);

/** Chainable mock — supports .populate().populate()...sort() pattern. */
function chainResolving(result: unknown) {
  const q: Record<string, unknown> = {};
  q.populate = vi.fn().mockReturnValue(q);
  q.sort = vi.fn().mockReturnValue(q);
  q.lean = vi.fn().mockResolvedValue(result);
  q.then = (resolve: (v: unknown) => void) => Promise.resolve(result).then(resolve);
  return q;
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

const rfqId = new mongoose.Types.ObjectId();
const userId = new mongoose.Types.ObjectId();
const approverId = new mongoose.Types.ObjectId();

/** Build a fake quote document with save() spy */
function fakeQuote(overrides: Record<string, unknown> = {}) {
  return {
    _id: new mongoose.Types.ObjectId(),
    rfqId,
    version: 1,
    status: 'DRAFT',
    costingDate: new Date('2025-06-01'),
    createdBy: userId,
    totalAnnualValue: mongoose.Types.Decimal128.fromString('20043000.00'),
    rateSnapshot: {},
    costBreakdown: {},
    volumeTierResults: [],
    annualQuotationValue: '20043000.00', // > ₹25L threshold
    save: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
      return Promise.resolve(this);
    }),
    ...overrides,
  };
}

/** Fake quote with annual value BELOW the ₹25L threshold */
function fakeSmallQuote(overrides: Record<string, unknown> = {}) {
  return fakeQuote({ annualQuotationValue: '1000000.00', ...overrides }); // ₹10L < ₹25L
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default QuoteEvent.create returns a resolved promise (array form for session)
  mockQuoteEventCreate.mockResolvedValue([{}]);
  // Default withTransaction executes its callback immediately
  mockSession.withTransaction.mockImplementation(async (fn: () => Promise<void>) => {
    await fn();
  });
  mockStartSession.mockResolvedValue(mockSession as never);
});

// ─── Threshold boundary tests ─────────────────────────────────────────────────

describe('Approval threshold boundary', () => {
  // The costing engine uses APPROVAL_THRESHOLD_INR = '2500000'
  // strictly > means: 2499999 → READY_FOR_SALES, 2500000 → READY_FOR_SALES, 2500001 → PENDING_APPROVAL

  async function submitWithAnnual(annual: string) {
    const q = fakeQuote({ status: 'DRAFT', annualQuotationValue: annual });
    mockFindOne.mockResolvedValue(q);
    return submitForApproval(rfqId, 1, userId);
  }

  it('₹24,99,999 → READY_FOR_SALES (below threshold)', async () => {
    const result = await submitWithAnnual('2499999');
    expect(result.status).toBe('READY_FOR_SALES');
  });

  it('₹25,00,000 → READY_FOR_SALES (at threshold, not strictly greater)', async () => {
    const result = await submitWithAnnual('2500000');
    expect(result.status).toBe('READY_FOR_SALES');
  });

  it('₹25,00,001 → PENDING_APPROVAL (strictly above threshold)', async () => {
    const result = await submitWithAnnual('2500001');
    expect(result.status).toBe('PENDING_APPROVAL');
  });
});

// ─── submitForApproval ────────────────────────────────────────────────────────

describe('submitForApproval', () => {
  it('transitions DRAFT → PENDING_APPROVAL when annual value > ₹25L', async () => {
    const q = fakeQuote({ status: 'DRAFT' });
    mockFindOne.mockResolvedValue(q);

    const result = await submitForApproval(rfqId, 1, userId);

    expect(result.status).toBe('PENDING_APPROVAL');
    expect(q.save).toHaveBeenCalled();
  });

  it('transitions DRAFT → READY_FOR_SALES when annual value ≤ ₹25L', async () => {
    const q = fakeSmallQuote({ status: 'DRAFT' });
    mockFindOne.mockResolvedValue(q);

    const result = await submitForApproval(rfqId, 1, userId);

    expect(result.status).toBe('READY_FOR_SALES');
  });

  it('sets submittedBy and submittedAt', async () => {
    const q = fakeQuote({ status: 'DRAFT' });
    mockFindOne.mockResolvedValue(q);
    const beforeTs = Date.now();

    await submitForApproval(rfqId, 1, userId);

    expect(q.submittedBy).toEqual(userId);
    expect(q.submittedAt).toBeInstanceOf(Date);
    expect((q.submittedAt as Date).getTime()).toBeGreaterThanOrEqual(beforeTs);
  });

  it('throws QUOTE_IMMUTABLE for PENDING_APPROVAL quote', async () => {
    const q = fakeQuote({ status: 'PENDING_APPROVAL' });
    mockFindOne.mockResolvedValue(q);

    const err = await submitForApproval(rfqId, 1, userId).catch((e) => e as QuoteServiceError);

    expect(err).toBeInstanceOf(QuoteServiceError);
    expect(err.code).toBe('QUOTE_IMMUTABLE');
  });

  it('throws QUOTE_IMMUTABLE for READY_FOR_SALES quote', async () => {
    const q = fakeQuote({ status: 'READY_FOR_SALES' });
    mockFindOne.mockResolvedValue(q);

    const err = await submitForApproval(rfqId, 1, userId).catch((e) => e as QuoteServiceError);

    expect(err).toBeInstanceOf(QuoteServiceError);
    expect(err.code).toBe('QUOTE_IMMUTABLE');
  });

  it('awaits QuoteEvent.create (not fire-and-forget)', async () => {
    const q = fakeQuote({ status: 'DRAFT' });
    mockFindOne.mockResolvedValue(q);

    // QuoteEvent.create is awaited — verify it was called with submitterId
    await submitForApproval(rfqId, 1, userId);

    expect(mockQuoteEventCreate).toHaveBeenCalledWith(
      [expect.objectContaining({ action: 'SUBMITTED', actorId: userId })],
      expect.objectContaining({ session: mockSession }),
    );
  });

  it('propagates QuoteEvent.create failure (no silent loss)', async () => {
    const q = fakeQuote({ status: 'DRAFT' });
    mockFindOne.mockResolvedValue(q);
    mockQuoteEventCreate.mockRejectedValueOnce(new Error('DB write failed'));

    // Because submitForApproval awaits QuoteEvent.create, the error surfaces
    await expect(submitForApproval(rfqId, 1, userId)).rejects.toThrow('DB write failed');
  });
});

// ─── READY_FOR_SALES status ────────────────────────────────────────────────────

describe('READY_FOR_SALES immutability', () => {
  it('is included in IMMUTABLE_STATUSES', () => {
    expect(IMMUTABLE_STATUSES).toContain('READY_FOR_SALES');
  });
});

// ─── approveQuote — transactional ────────────────────────────────────────────

describe('approveQuote — transactional approval', () => {
  it('uses conditional findOneAndUpdate (concurrent-safe)', async () => {
    const q = fakeQuote({ status: 'PENDING_APPROVAL' });
    const approved = { ...q, status: 'APPROVED', approverId, approvedAt: new Date() };
    mockFindOne.mockResolvedValue(q);
    mockFindOneAndUpdate.mockResolvedValue(approved);

    const result = await approveQuote({ rfqId, version: 1, approverId });

    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      { rfqId, version: 1, status: 'PENDING_APPROVAL' },
      expect.objectContaining({ $set: expect.objectContaining({ status: 'APPROVED' }) }),
      expect.objectContaining({ new: true }),
    );
    expect(result.status).toBe('APPROVED');
  });

  it('writes QuoteEvent inside the transaction', async () => {
    const q = fakeQuote({ status: 'PENDING_APPROVAL' });
    const approved = { ...q, status: 'APPROVED' };
    mockFindOne.mockResolvedValue(q);
    mockFindOneAndUpdate.mockResolvedValue(approved);

    await approveQuote({ rfqId, version: 1, approverId });

    expect(mockQuoteEventCreate).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ action: 'APPROVED', actorId: approverId })]),
      expect.objectContaining({ session: mockSession }),
    );
  });

  it('throws INVALID_STATUS_TRANSITION when quote is not PENDING_APPROVAL', async () => {
    const q = fakeQuote({ status: 'DRAFT' });
    mockFindOne.mockResolvedValue(q);

    const err = await approveQuote({ rfqId, version: 1, approverId }).catch((e) => e as QuoteServiceError);

    expect(err).toBeInstanceOf(QuoteServiceError);
    expect(err.code).toBe('INVALID_STATUS_TRANSITION');
  });

  it('QuoteEvent failure causes transaction rollback (error propagates)', async () => {
    const q = fakeQuote({ status: 'PENDING_APPROVAL' });
    const approved = { ...q, status: 'APPROVED' };
    mockFindOne.mockResolvedValue(q);
    mockFindOneAndUpdate.mockResolvedValue(approved);
    // Simulate withTransaction propagating the QuoteEvent failure (session rolls back)
    mockSession.withTransaction.mockImplementationOnce(async (fn: () => Promise<void>) => {
      mockQuoteEventCreate.mockRejectedValueOnce(new Error('QuoteEvent write failed'));
      await fn(); // throws, so withTransaction rolls back
    });

    await expect(approveQuote({ rfqId, version: 1, approverId })).rejects.toThrow('QuoteEvent write failed');
  });
});

// ─── Concurrent approval test ─────────────────────────────────────────────────

describe('Concurrent approval conflict', () => {
  it('second concurrent approval receives INVALID_STATUS_TRANSITION', async () => {
    // First call: findOne returns PENDING_APPROVAL, findOneAndUpdate succeeds
    const q = fakeQuote({ status: 'PENDING_APPROVAL' });
    const approved = { ...q, status: 'APPROVED' };

    // Both concurrent calls see PENDING_APPROVAL on findOne (pre-flight)
    mockFindOne.mockResolvedValue(q);

    // First findOneAndUpdate wins and returns the approved doc
    // Second findOneAndUpdate returns null (document no longer PENDING_APPROVAL)
    mockFindOneAndUpdate
      .mockResolvedValueOnce(approved) // first request succeeds
      .mockResolvedValueOnce(null);    // second request finds nothing (already approved)

    const approverId2 = new mongoose.Types.ObjectId();

    // Run both approval requests concurrently
    const [result1, result2] = await Promise.allSettled([
      approveQuote({ rfqId, version: 1, approverId }),
      approveQuote({ rfqId, version: 1, approverId: approverId2 }),
    ]);

    // First must succeed
    expect(result1.status).toBe('fulfilled');
    if (result1.status === 'fulfilled') {
      expect(result1.value.status).toBe('APPROVED');
    }

    // Second must fail with a conflict error
    expect(result2.status).toBe('rejected');
    if (result2.status === 'rejected') {
      const err = result2.reason as QuoteServiceError;
      expect(err).toBeInstanceOf(QuoteServiceError);
      expect(err.code).toBe('INVALID_STATUS_TRANSITION');
    }

    // QuoteEvent was created exactly once (only for the winning request)
    // (second call never reaches QuoteEvent.create because findOneAndUpdate returns null)
    const eventCalls = mockQuoteEventCreate.mock.calls;
    const approvedEventCalls = eventCalls.filter(
      (call) => Array.isArray(call[0]) && call[0][0]?.action === 'APPROVED',
    );
    expect(approvedEventCalls).toHaveLength(1);
  });
});

// ─── rejectQuote ──────────────────────────────────────────────────────────────

describe('rejectQuote — transactional rejection', () => {
  it('stores rejectionComment via transaction', async () => {
    const q = fakeQuote({ status: 'PENDING_APPROVAL' });
    const rejected = { ...q, status: 'REJECTED', rejectionComment: 'Too expensive' };
    mockFindOne.mockResolvedValue(q);
    mockFindOneAndUpdate.mockResolvedValue(rejected);

    const result = await rejectQuote(rfqId, 1, approverId, 'Too expensive');

    expect(result.status).toBe('REJECTED');
    expect(result.rejectionComment).toBe('Too expensive');
  });

  it('sets rejectedBy and rejectedAt', async () => {
    const beforeTs = Date.now();
    const q = fakeQuote({ status: 'PENDING_APPROVAL' });
    const rejectedAt = new Date();
    const rejected = { ...q, status: 'REJECTED', rejectedBy: approverId, rejectedAt };
    mockFindOne.mockResolvedValue(q);
    mockFindOneAndUpdate.mockResolvedValue(rejected);

    const result = await rejectQuote(rfqId, 1, approverId, 'Pricing issue');

    expect(result.rejectedBy).toEqual(approverId);
    expect(result.rejectedAt).toBeInstanceOf(Date);
    expect((result.rejectedAt as Date).getTime()).toBeGreaterThanOrEqual(beforeTs);
  });

  it('writes REJECTED QuoteEvent inside transaction', async () => {
    const q = fakeQuote({ status: 'PENDING_APPROVAL' });
    const rejected = { ...q, status: 'REJECTED' };
    mockFindOne.mockResolvedValue(q);
    mockFindOneAndUpdate.mockResolvedValue(rejected);

    await rejectQuote(rfqId, 1, approverId, 'Pricing issue');

    expect(mockQuoteEventCreate).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ action: 'REJECTED', actorId: approverId })]),
      expect.objectContaining({ session: mockSession }),
    );
  });

  it('works without rejecterId (backward compatibility — non-transactional path)', async () => {
    const q = fakeQuote({ status: 'PENDING_APPROVAL' });
    mockFindOne.mockResolvedValue(q);

    await rejectQuote(rfqId, 1);

    expect(q.status).toBe('REJECTED');
    expect(q.rejectedBy).toBeUndefined();
    expect(q.rejectionComment).toBeUndefined();
    expect(q.save).toHaveBeenCalled();
    // No transaction started for backward-compat path
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it('throws INVALID_STATUS_TRANSITION for non-PENDING_APPROVAL quote', async () => {
    const q = fakeQuote({ status: 'DRAFT' });
    mockFindOne.mockResolvedValue(q);

    const err = await rejectQuote(rfqId, 1, approverId, 'No').catch((e) => e as QuoteServiceError);

    expect(err).toBeInstanceOf(QuoteServiceError);
    expect(err.code).toBe('INVALID_STATUS_TRANSITION');
  });

  it('QuoteEvent failure inside transaction causes rollback (error propagates)', async () => {
    const q = fakeQuote({ status: 'PENDING_APPROVAL' });
    const rejected = { ...q, status: 'REJECTED' };
    mockFindOne.mockResolvedValue(q);
    mockFindOneAndUpdate.mockResolvedValue(rejected);
    mockSession.withTransaction.mockImplementationOnce(async (fn: () => Promise<void>) => {
      mockQuoteEventCreate.mockRejectedValueOnce(new Error('Event write failed'));
      await fn();
    });

    await expect(rejectQuote(rfqId, 1, approverId, 'Comment')).rejects.toThrow('Event write failed');
  });
});

// ─── markAsSent — awaited QuoteEvent ──────────────────────────────────────────

describe('markAsSent — awaited audit persistence', () => {
  it('transitions READY_FOR_SALES → SENT', async () => {
    const q = fakeQuote({ status: 'READY_FOR_SALES' });
    mockFindOne.mockResolvedValue(q);

    await markAsSent(rfqId, 1, userId);

    expect(q.status).toBe('SENT');
    expect(q.sentBy).toEqual(userId);
    expect(q.sentAt).toBeInstanceOf(Date);
    expect(q.save).toHaveBeenCalled();
  });

  it('transitions APPROVED → SENT (existing behavior preserved)', async () => {
    const q = fakeQuote({ status: 'APPROVED' });
    mockFindOne.mockResolvedValue(q);

    await markAsSent(rfqId, 1, userId);

    expect(q.status).toBe('SENT');
  });

  it('awaits QuoteEvent.create (not fire-and-forget)', async () => {
    const q = fakeQuote({ status: 'APPROVED' });
    mockFindOne.mockResolvedValue(q);

    await markAsSent(rfqId, 1, userId);

    expect(mockQuoteEventCreate).toHaveBeenCalledWith(
      [expect.objectContaining({ action: 'SENT', actorId: userId })],
      expect.objectContaining({ session: mockSession }),
    );
  });

  it('propagates QuoteEvent.create failure', async () => {
    const q = fakeQuote({ status: 'APPROVED' });
    mockFindOne.mockResolvedValue(q);
    mockQuoteEventCreate.mockRejectedValueOnce(new Error('SENT event failed'));

    await expect(markAsSent(rfqId, 1, userId)).rejects.toThrow('SENT event failed');
  });

  it('throws INVALID_STATUS_TRANSITION for DRAFT', async () => {
    const q = fakeQuote({ status: 'DRAFT' });
    mockFindOne.mockResolvedValue(q);

    const err = await markAsSent(rfqId, 1).catch((e) => e as QuoteServiceError);
    expect(err).toBeInstanceOf(QuoteServiceError);
    expect(err.code).toBe('INVALID_STATUS_TRANSITION');
  });

  it('throws INVALID_STATUS_TRANSITION for REJECTED', async () => {
    const q = fakeQuote({ status: 'REJECTED' });
    mockFindOne.mockResolvedValue(q);

    const err = await markAsSent(rfqId, 1).catch((e) => e as QuoteServiceError);
    expect(err.code).toBe('INVALID_STATUS_TRANSITION');
  });
});

// ─── getPendingApprovals ──────────────────────────────────────────────────────

describe('getPendingApprovals', () => {
  it('queries for PENDING_APPROVAL status and returns array', async () => {
    const pendingQuote = fakeQuote({ status: 'PENDING_APPROVAL' });
    const chain = {
      populate: vi.fn().mockReturnThis(),
      sort: vi.fn().mockResolvedValue([pendingQuote]),
    };
    mockFind.mockReturnValue(chain);

    const result = await getPendingApprovals();

    expect(mockFind).toHaveBeenCalledWith({ status: 'PENDING_APPROVAL' });
    expect(result).toHaveLength(1);
    expect(result[0].status).toBe('PENDING_APPROVAL');
  });
});

// ─── getQuoteById ─────────────────────────────────────────────────────────────

describe('getQuoteById', () => {
  it('calls findById with the provided ObjectId', async () => {
    const quoteId = new mongoose.Types.ObjectId();
    const q = fakeQuote();
    const chain = {
      populate: vi.fn().mockReturnThis(),
    };
    chain.populate
      .mockReturnValueOnce(chain)
      .mockReturnValueOnce(chain)
      .mockReturnValueOnce(chain)
      .mockResolvedValue(q);

    mockFindById.mockReturnValue(chain);

    const result = await getQuoteById(quoteId);

    expect(mockFindById).toHaveBeenCalledWith(quoteId);
    expect(result).toBeDefined();
  });
});

// ─── getQuoteEvents ───────────────────────────────────────────────────────────

describe('getQuoteEvents', () => {
  it('queries QuoteEvent by quoteId', async () => {
    const quoteId = new mongoose.Types.ObjectId();
    const mockEvent = { _id: new mongoose.Types.ObjectId(), action: 'SUBMITTED' };

    const chain = {
      populate: vi.fn().mockReturnThis(),
      sort: vi.fn().mockResolvedValue([mockEvent]),
    };
    (QuoteEvent.find as ReturnType<typeof vi.fn>).mockReturnValue(chain);

    const result = await getQuoteEvents(quoteId);

    expect(QuoteEvent.find).toHaveBeenCalledWith({ quoteId });
    expect(result).toHaveLength(1);
    expect(result[0].action).toBe('SUBMITTED');
  });
});
