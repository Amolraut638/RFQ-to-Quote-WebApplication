/**
 * tests/approval.service.test.ts
 *
 * Tests for Day 4 approval workflow additions to quote.service.ts:
 *  1.  submitForApproval with annual value > ₹25L → PENDING_APPROVAL
 *  2.  submitForApproval with annual value ≤ ₹25L → READY_FOR_SALES
 *  3.  submitForApproval sets submittedBy and submittedAt
 *  4.  submitForApproval on PENDING_APPROVAL (immutable) → QUOTE_IMMUTABLE
 *  5.  submitForApproval on READY_FOR_SALES (immutable) → QUOTE_IMMUTABLE
 *  6.  READY_FOR_SALES is in IMMUTABLE_STATUSES
 *  7.  rejectQuote stores rejectionComment
 *  8.  rejectQuote sets rejectedBy and rejectedAt when rejecterId supplied
 *  9.  rejectQuote still works without rejecterId (backward compat)
 *  10. markAsSent accepts READY_FOR_SALES → SENT
 *  11. markAsSent accepts APPROVED → SENT
 *  12. markAsSent rejects DRAFT → INVALID_STATUS_TRANSITION
 *  13. markAsSent rejects REJECTED → INVALID_STATUS_TRANSITION
 *  14. getPendingApprovals returns only PENDING_APPROVAL quotes (service-level shape)
 *  15. getQuoteById returns populated quote
 *  16. getQuoteEvents queries by quoteId
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import mongoose from 'mongoose';

// ─── Mock Quote model ─────────────────────────────────────────────────────────

vi.mock('../src/models/Quote', async () => {
  const actual = await vi.importActual<typeof import('../src/models/Quote')>('../src/models/Quote');
  return {
    ...actual,
    Quote: {
      findOne: vi.fn(),
      find: vi.fn(),
      findById: vi.fn(),
      create: vi.fn(),
    },
  };
});

// ─── Mock QuoteEvent model ────────────────────────────────────────────────────

vi.mock('../src/models/QuoteEvent', () => {
  return {
    QuoteEvent: {
      create: vi.fn().mockResolvedValue({}),
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
const mockFind = Quote.find as ReturnType<typeof vi.fn>;
const mockFindById = Quote.findById as ReturnType<typeof vi.fn>;

/** Returns a mock that resolves directly. */
function resolving(result: unknown) {
  return Promise.resolve(result);
}

/** Chainable mock — supports .populate().populate()...sort() pattern. */
function chainResolving(result: unknown) {
  const q: Record<string, unknown> = {};
  const chain = () => q;
  q.populate = vi.fn().mockReturnValue(q);
  q.sort = vi.fn().mockReturnValue(q);
  q.lean = vi.fn().mockResolvedValue(result);
  q.then = (resolve: (v: unknown) => void) => Promise.resolve(result).then(resolve);
  return q;
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

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
  // Default QuoteEvent.create to succeed silently
  (QuoteEvent.create as ReturnType<typeof vi.fn>).mockResolvedValue({});
});

// ─── IMMUTABLE_STATUSES ───────────────────────────────────────────────────────

describe('IMMUTABLE_STATUSES', () => {
  it('includes READY_FOR_SALES', () => {
    expect(IMMUTABLE_STATUSES).toContain('READY_FOR_SALES');
  });

  it('still includes PENDING_APPROVAL, APPROVED, SENT', () => {
    expect(IMMUTABLE_STATUSES).toContain('PENDING_APPROVAL');
    expect(IMMUTABLE_STATUSES).toContain('APPROVED');
    expect(IMMUTABLE_STATUSES).toContain('SENT');
  });
});

// ─── submitForApproval (threshold logic) ──────────────────────────────────────

describe('submitForApproval — threshold-based routing', () => {
  it('routes to PENDING_APPROVAL when annual value > ₹25,00,000', async () => {
    const q = fakeQuote({ annualQuotationValue: '20043000.00' }); // > 25L
    mockFindOne.mockResolvedValue(q);

    await submitForApproval(rfqId, 1, userId);

    expect(q.status).toBe('PENDING_APPROVAL');
    expect(q.save).toHaveBeenCalled();
  });

  it('routes to READY_FOR_SALES when annual value ≤ ₹25,00,000', async () => {
    const q = fakeSmallQuote({ annualQuotationValue: '2500000.00' }); // exactly = 25L (not >, so READY)
    mockFindOne.mockResolvedValue(q);

    await submitForApproval(rfqId, 1, userId);

    expect(q.status).toBe('READY_FOR_SALES');
  });

  it('routes to READY_FOR_SALES when annual value is below ₹25L', async () => {
    const q = fakeSmallQuote();
    mockFindOne.mockResolvedValue(q);

    await submitForApproval(rfqId, 1, userId);

    expect(q.status).toBe('READY_FOR_SALES');
  });

  it('sets submittedBy and submittedAt when submitterId is provided', async () => {
    const q = fakeQuote();
    mockFindOne.mockResolvedValue(q);

    const beforeTs = Date.now();
    await submitForApproval(rfqId, 1, userId);

    expect(q.submittedBy).toEqual(userId);
    expect(q.submittedAt).toBeInstanceOf(Date);
    expect((q.submittedAt as Date).getTime()).toBeGreaterThanOrEqual(beforeTs);
  });

  it('works without submitterId (backward compatibility)', async () => {
    const q = fakeQuote();
    mockFindOne.mockResolvedValue(q);

    // Should not throw, should still transition status
    await submitForApproval(rfqId, 1);

    expect(q.status).toBe('PENDING_APPROVAL');
    expect(q.submittedBy).toBeUndefined();
  });

  it('throws QUOTE_IMMUTABLE for PENDING_APPROVAL status', async () => {
    const q = fakeQuote({ status: 'PENDING_APPROVAL' });
    mockFindOne.mockResolvedValue(q);

    const err = await submitForApproval(rfqId, 1, userId).catch((e) => e as QuoteServiceError);
    expect(err).toBeInstanceOf(QuoteServiceError);
    expect(err.code).toBe('QUOTE_IMMUTABLE');
  });

  it('throws QUOTE_IMMUTABLE for READY_FOR_SALES status', async () => {
    const q = fakeQuote({ status: 'READY_FOR_SALES' });
    mockFindOne.mockResolvedValue(q);

    const err = await submitForApproval(rfqId, 1, userId).catch((e) => e as QuoteServiceError);
    expect(err).toBeInstanceOf(QuoteServiceError);
    expect(err.code).toBe('QUOTE_IMMUTABLE');
  });

  it('throws QUOTE_NOT_FOUND when quote does not exist', async () => {
    mockFindOne.mockResolvedValue(null);

    const err = await submitForApproval(rfqId, 1, userId).catch((e) => e as QuoteServiceError);
    expect(err).toBeInstanceOf(QuoteServiceError);
    expect(err.code).toBe('QUOTE_NOT_FOUND');
  });
});

// ─── rejectQuote (new comment param) ─────────────────────────────────────────

describe('rejectQuote — rejection comment', () => {
  it('stores rejectionComment when provided', async () => {
    const q = fakeQuote({ status: 'PENDING_APPROVAL' });
    mockFindOne.mockResolvedValue(q);

    await rejectQuote(rfqId, 1, approverId, 'Margin too low');

    expect(q.rejectionComment).toBe('Margin too low');
    expect(q.status).toBe('REJECTED');
    expect(q.save).toHaveBeenCalled();
  });

  it('sets rejectedBy and rejectedAt when rejecterId supplied', async () => {
    const q = fakeQuote({ status: 'PENDING_APPROVAL' });
    mockFindOne.mockResolvedValue(q);

    const beforeTs = Date.now();
    await rejectQuote(rfqId, 1, approverId, 'Needs revision');

    expect(q.rejectedBy).toEqual(approverId);
    expect(q.rejectedAt).toBeInstanceOf(Date);
    expect((q.rejectedAt as Date).getTime()).toBeGreaterThanOrEqual(beforeTs);
  });

  it('works without rejecterId (backward compatibility)', async () => {
    const q = fakeQuote({ status: 'PENDING_APPROVAL' });
    mockFindOne.mockResolvedValue(q);

    await rejectQuote(rfqId, 1);

    expect(q.status).toBe('REJECTED');
    expect(q.rejectedBy).toBeUndefined();
    expect(q.rejectionComment).toBeUndefined();
  });
});

// ─── markAsSent — extended to accept READY_FOR_SALES ─────────────────────────

describe('markAsSent — READY_FOR_SALES support', () => {
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
    // Quote.find(...).populate(...).populate(...).sort(...) chain
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
    // Final populate resolves
    chain.populate.mockReturnValueOnce(chain)
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

