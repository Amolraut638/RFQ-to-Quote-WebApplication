/**
 * controllers/rfq.controller.ts
 */

import { Request, Response, NextFunction } from 'express';
import * as RFQService from '../services/rfq.service';
import { CreateRFQSchema } from '../validators/rfq.validator';

export async function listRFQs(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const rfqs = await RFQService.listRFQs();
    const now = new Date();
    // Annotate each RFQ with isOverdue flag without altering DB records
    const data = rfqs.map((rfq: any) => ({
      ...rfq,
      isOverdue:
        rfq.dueDate < now && rfq.status !== 'WON' && rfq.status !== 'LOST' && rfq.status !== 'SENT',
    }));
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function getRFQ(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const rfq = await RFQService.getRFQById(req.params.id);
    if (!rfq) {
      res.status(404).json({ error: 'RFQ not found' });
      return;
    }
    res.json({ success: true, data: rfq });
  } catch (err) {
    next(err);
  }
}

export async function createRFQ(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = CreateRFQSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
      return;
    }

    const rfq = await RFQService.createRFQ({
      ...parsed.data,
      receivedDate: new Date(parsed.data.receivedDate),
      dueDate: new Date(parsed.data.dueDate),
      ownerId: req.user!.id,
    });

    res.status(201).json({ success: true, data: rfq });
  } catch (err) {
    next(err);
  }
}

