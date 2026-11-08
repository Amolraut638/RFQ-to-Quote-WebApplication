/**
 * tests/approval.service.test.ts  (UNIT tests — mocked persistence, no database)
 *
 * Uses the in-memory fake in helpers/fakeMongo.ts, which emulates atomic conditional
 * updates and transaction rollback. These prove the service logic; they do NOT prove
 * MongoDB behaviour — that is covered by the live Atlas scripts (see Day 4 report).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { createFakeMongo } from './helpers/fakeMongo';

vi.mock('../src/models/Quote', async () => {
  const actual = await vi.importActual<typeof import('../src/models/Quote')>('../src/models/Quote');
  return {
    ...actual,
    Quote: { findOne: vi.fn(), find: vi.fn(), findById: vi.fn(), findOneAndUpdate: vi.fn(), create: vi.fn() },
  };
});
vi.mock('../src/models/QuoteEvent', () => ({ QuoteEvent: { create: vi.fn(), find: vi.fn() } }));

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

const rfqId = new mongoose.Types.ObjectId();
const userId = new mongoose.Types.ObjectId();
const approverId = new mongoose.Types.ObjectId();
const approver2 = new mongoose.Types.ObjectId();

let fake: ReturnType<typeof createFakeMongo>;

function seed(status: string, annual = '20043000.00', version = 1) {
  fake = createFakeMongo([
    { _id: new mongoose.Types.ObjectId(), rfqId, version, status, annualQuotationValue: annual },
  ]);
  vi.mocked(Quote.findOne).mockImplementation(fake.findOne as never);
  vi.mocked(Quote.findOneAndUpdate).mockImplementation(fake.findOneAndUpdate as never);
  vi.mocked(QuoteEvent.create).mockImplementation(fake.eventCreate as never);
  vi.spyOn(mongoose, 'startSession').mockResolvedValue(fake.session as never);
}

const doc = () => fake.state.docs[0];
const events = (action?: string) => fake.state.events.filter((e) => !action || e.action === action);
const codeOf = (p: Promise<unknown>) => p.then(() => 'OK', (e: QuoteServiceError) => e.code);

beforeEach(() => vi.clearAllMocks());

describe('threshold boundary (uses existing evaluateApproval)', () => {
  it.each([
    ['2499999', 'READY_FOR_SALES'],
    ['2500000', 'READY_FOR_SALES'],
    ['2500001', 'PENDING_APPROVAL'],
  ])('₹%s → %s', async (annual, expected) => {
    seed('DRAFT', annual);
    const r = await submitForApproval(rfqId, 1, userId);
    expect(r.status).toBe(expected);
    expect(doc().status).toBe(expected);
  });
});

describe('submitForApproval', () => {
  it('DRAFT > ₹25L → PENDING_APPROVAL, sets submittedBy/At, writes one SUBMITTED event', async () => {
    seed('DRAFT');
    const r = await submitForApproval(rfqId, 1, userId);
    expect(r.status).toBe('PENDING_APPROVAL');
    expect(doc().submittedBy).toEqual(userId);
    expect(doc().submittedAt).toBeInstanceOf(Date);
    expect(events('SUBMITTED')).toHaveLength(1);
    expect(events('SUBMITTED')[0].actorId).toEqual(userId);
  });

  it('is never auto-APPROVED: low value goes to READY_FOR_SALES', async () => {
    seed('DRAFT', '1000000.00');
    const r = await submitForApproval(rfqId, 1, userId);
    expect(r.status).toBe('READY_FOR_SALES');
    expect(events('APPROVED')).toHaveLength(0);
  });

  it('PENDING_APPROVAL / READY_FOR_SALES are immutable → QUOTE_IMMUTABLE', async () => {
    seed('PENDING_APPROVAL');
    expect(await codeOf(submitForApproval(rfqId, 1, userId))).toBe('QUOTE_IMMUTABLE');
    seed('READY_FOR_SALES');
    expect(await codeOf(submitForApproval(rfqId, 1, userId))).toBe('QUOTE_IMMUTABLE');
    expect(IMMUTABLE_STATUSES).toContain('READY_FOR_SALES');
  });

  it('REJECTED cannot be submitted → INVALID_STATUS_TRANSITION, nothing written', async () => {
    seed('REJECTED');
    expect(await codeOf(submitForApproval(rfqId, 1, userId))).toBe('INVALID_STATUS_TRANSITION');
    expect(events()).toHaveLength(0);
  });

  it('missing quote → QUOTE_NOT_FOUND', async () => {
    seed('DRAFT');
    expect(await codeOf(submitForApproval(rfqId, 99, userId))).toBe('QUOTE_NOT_FOUND');
  });

  it('SIMULTANEOUS submissions: exactly one succeeds, other gets STATUS_CONFLICT, one SUBMITTED event', async () => {
    seed('DRAFT');
    const results = await Promise.allSettled([
      submitForApproval(rfqId, 1, userId),
      submitForApproval(rfqId, 1, approver2),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const bad = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(ok).toHaveLength(1);
    expect(bad).toHaveLength(1);
    expect(bad[0].reason).toBeInstanceOf(QuoteServiceError);
    expect(bad[0].reason.code).toBe('STATUS_CONFLICT');
    expect(events('SUBMITTED')).toHaveLength(1);
    expect(doc().status).toBe('PENDING_APPROVAL');
    // the single event belongs to the winning submitter
    expect(String(events('SUBMITTED')[0].actorId)).toBe(String(doc().submittedBy));
  });

  it('audit write failure rolls back: status stays DRAFT, no event, error surfaces', async () => {
    seed('DRAFT');
    fake.state.failNextEventWrite = true;
    await expect(submitForApproval(rfqId, 1, userId)).rejects.toThrow('simulated QuoteEvent write failure');
    expect(doc().status).toBe('DRAFT');
    expect(doc().submittedBy).toBeUndefined();
    expect(events()).toHaveLength(0);
    expect(fake.state.aborts).toBe(1);
  });
});

describe('approveQuote', () => {
  it('PENDING_APPROVAL → APPROVED with one approver, timestamp and APPROVED event', async () => {
    seed('PENDING_APPROVAL');
    const r = await approveQuote({ rfqId, version: 1, approverId });
    expect(r.status).toBe('APPROVED');
    expect(doc().approverId).toEqual(approverId);
    expect(doc().approvedAt).toBeInstanceOf(Date);
    expect(events('APPROVED')).toHaveLength(1);
  });

  it.each(['DRAFT', 'APPROVED', 'REJECTED', 'READY_FOR_SALES', 'SENT'])(
    'cannot approve from %s → INVALID_STATUS_TRANSITION, nothing written',
    async (status) => {
      seed(status);
      expect(await codeOf(approveQuote({ rfqId, version: 1, approverId }))).toBe('INVALID_STATUS_TRANSITION');
      expect(events()).toHaveLength(0);
    },
  );

  it('CONCURRENT approvals: exactly one wins, other STATUS_CONFLICT, one approver, one APPROVED event', async () => {
    seed('PENDING_APPROVAL');
    const results = await Promise.allSettled([
      approveQuote({ rfqId, version: 1, approverId }),
      approveQuote({ rfqId, version: 1, approverId: approver2 }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const bad = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(bad.reason.code).toBe('STATUS_CONFLICT');
    expect(events('APPROVED')).toHaveLength(1);
    expect(String(events('APPROVED')[0].actorId)).toBe(String(doc().approverId));
    expect(doc().status).toBe('APPROVED');
  });

  it('audit failure rolls back the approval: still PENDING_APPROVAL, no approver, no event', async () => {
    seed('PENDING_APPROVAL');
    fake.state.failNextEventWrite = true;
    await expect(approveQuote({ rfqId, version: 1, approverId })).rejects.toThrow('simulated');
    expect(doc().status).toBe('PENDING_APPROVAL');
    expect(doc().approverId).toBeUndefined();
    expect(doc().approvedAt).toBeUndefined();
    expect(events()).toHaveLength(0);
  });
});

describe('rejectQuote', () => {
  it('PENDING_APPROVAL → REJECTED storing rejecter, time, comment, one REJECTED event', async () => {
    seed('PENDING_APPROVAL');
    const r = await rejectQuote(rfqId, 1, approverId, 'Too expensive');
    expect(r.status).toBe('REJECTED');
    expect(doc().rejectedBy).toEqual(approverId);
    expect(doc().rejectedAt).toBeInstanceOf(Date);
    expect(doc().rejectionComment).toBe('Too expensive');
    expect(events('REJECTED')).toHaveLength(1);
    expect(events('REJECTED')[0].comment).toBe('Too expensive');
  });

  it('refuses a missing rejecter ID or blank comment — nothing written', async () => {
    seed('PENDING_APPROVAL');
    expect(await codeOf(rejectQuote(rfqId, 1, undefined as never, 'x'))).toBe('INVALID_STATUS_TRANSITION');
    expect(await codeOf(rejectQuote(rfqId, 1, approverId, '   '))).toBe('INVALID_STATUS_TRANSITION');
    expect(doc().status).toBe('PENDING_APPROVAL');
    expect(events()).toHaveLength(0);
  });

  it.each(['DRAFT', 'APPROVED', 'REJECTED', 'READY_FOR_SALES', 'SENT'])(
    'cannot reject from %s',
    async (status) => {
      seed(status);
      expect(await codeOf(rejectQuote(rfqId, 1, approverId, 'no'))).toBe('INVALID_STATUS_TRANSITION');
    },
  );

  it('concurrent reject + approve: exactly one wins, exactly one event', async () => {
    seed('PENDING_APPROVAL');
    const results = await Promise.allSettled([
      approveQuote({ rfqId, version: 1, approverId }),
      rejectQuote(rfqId, 1, approver2, 'No'),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(events()).toHaveLength(1);
  });

  it('audit failure rolls back the rejection', async () => {
    seed('PENDING_APPROVAL');
    fake.state.failNextEventWrite = true;
    await expect(rejectQuote(rfqId, 1, approverId, 'c')).rejects.toThrow('simulated');
    expect(doc().status).toBe('PENDING_APPROVAL');
    expect(doc().rejectionComment).toBeUndefined();
    expect(events()).toHaveLength(0);
  });
});

describe('markAsSent', () => {
  it.each(['APPROVED', 'READY_FOR_SALES'])('%s → SENT with sentBy/At and one SENT event', async (status) => {
    seed(status);
    const r = await markAsSent(rfqId, 1, userId);
    expect(r.status).toBe('SENT');
    expect(doc().sentBy).toEqual(userId);
    expect(doc().sentAt).toBeInstanceOf(Date);
    expect(events('SENT')).toHaveLength(1);
  });

  it.each(['DRAFT', 'PENDING_APPROVAL', 'REJECTED', 'SENT'])(
    'cannot send from %s → INVALID_STATUS_TRANSITION',
    async (status) => {
      seed(status);
      expect(await codeOf(markAsSent(rfqId, 1, userId))).toBe('INVALID_STATUS_TRANSITION');
      expect(events()).toHaveLength(0);
    },
  );

  it('SIMULTANEOUS mark-as-sent: exactly one succeeds, other STATUS_CONFLICT, one SENT event', async () => {
    seed('READY_FOR_SALES');
    const results = await Promise.allSettled([
      markAsSent(rfqId, 1, userId),
      markAsSent(rfqId, 1, approver2),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const bad = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(bad.reason.code).toBe('STATUS_CONFLICT');
    expect(events('SENT')).toHaveLength(1);
    expect(String(events('SENT')[0].actorId)).toBe(String(doc().sentBy));
  });

  it('audit failure rolls back: stays APPROVED, no sentBy, no event', async () => {
    seed('APPROVED');
    fake.state.failNextEventWrite = true;
    await expect(markAsSent(rfqId, 1, userId)).rejects.toThrow('simulated');
    expect(doc().status).toBe('APPROVED');
    expect(doc().sentBy).toBeUndefined();
    expect(events()).toHaveLength(0);
  });
});

describe('read helpers', () => {
  it('getPendingApprovals queries PENDING_APPROVAL only', async () => {
    const chain = { populate: vi.fn().mockReturnThis(), sort: vi.fn().mockResolvedValue([{ status: 'PENDING_APPROVAL' }]) };
    vi.mocked(Quote.find).mockReturnValue(chain as never);
    const r = await getPendingApprovals();
    expect(Quote.find).toHaveBeenCalledWith({ status: 'PENDING_APPROVAL' });
    expect(r).toHaveLength(1);
  });

  it('getQuoteById calls findById', async () => {
    const id = new mongoose.Types.ObjectId();
    const chain = { populate: vi.fn() };
    chain.populate.mockReturnValueOnce(chain).mockReturnValueOnce(chain).mockReturnValueOnce(chain).mockResolvedValue({});
    vi.mocked(Quote.findById).mockReturnValue(chain as never);
    await getQuoteById(id);
    expect(Quote.findById).toHaveBeenCalledWith(id);
  });

  it('getQuoteEvents queries by quoteId', async () => {
    const id = new mongoose.Types.ObjectId();
    const chain = { populate: vi.fn().mockReturnThis(), sort: vi.fn().mockResolvedValue([{ action: 'SUBMITTED' }]) };
    vi.mocked(QuoteEvent.find).mockReturnValue(chain as never);
    const r = await getQuoteEvents(id);
    expect(QuoteEvent.find).toHaveBeenCalledWith({ quoteId: id });
    expect(r[0].action).toBe('SUBMITTED');
  });
});
