/**
 * services/rfq.service.ts
 *
 * RFQ business logic and database operations.
 */

import { RFQ, IRFQ } from '../models/RFQ';
import { Part } from '../models/Part';

/** Plain (lean) RFQ shape returned to controllers; ownerId is populated. */
export interface RFQListItem {
  _id: unknown;
  rfqNo: string;
  customer: string;
  receivedDate: Date;
  dueDate: Date;
  ownerId: { _id: unknown; name: string; email: string; role: string } | null;
  status: IRFQ['status'];
  lostReason?: string;
  createdAt: Date;
  updatedAt: Date;
  /** First part's name, shown in the register. */
  partName?: string;
}

export async function listRFQs(): Promise<RFQListItem[]> {
  const rfqs = (await RFQ.find()
    .populate('ownerId', 'name email role')
    .sort({ dueDate: 1 })
    .lean()) as unknown as RFQListItem[];

  const parts = await Part.find({ rfqId: { $in: rfqs.map((r) => r._id) } }).lean();
  const firstPartByRfq = new Map<string, string>();
  for (const p of parts) {
    const key = String(p.rfqId);
    if (!firstPartByRfq.has(key)) firstPartByRfq.set(key, p.partName);
  }

  return rfqs.map((r) => ({ ...r, partName: firstPartByRfq.get(String(r._id)) }));
}

export async function getRFQById(id: string): Promise<Record<string, unknown> | null> {
  const rfq = await RFQ.findById(id).populate('ownerId', 'name email role').lean();
  if (!rfq) return null;
  const parts = await Part.find({ rfqId: id }).lean();
  return { ...(rfq as unknown as Record<string, unknown>), parts };
}

export async function createRFQ(data: {
  rfqNo: string;
  customer: string;
  receivedDate: Date;
  dueDate: Date;
  ownerId: string;
  sourceEmailText?: string;
}): Promise<IRFQ> {
  return RFQ.create(data);
}
