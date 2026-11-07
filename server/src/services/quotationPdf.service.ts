/**
 * services/quotationPdf.service.ts
 *
 * Generates a customer quotation PDF using PDFKit from a persisted IQuote document.
 *
 * CRITICAL: All monetary values come EXCLUSIVELY from the frozen quote snapshots
 * (quote.costBreakdown, quote.volumeTierResults, quote.rateSnapshot).
 * This function NEVER recalculates prices from rate masters.
 */

import PDFDocument from 'pdfkit';
import type { IQuote } from '../models/Quote';

type AnyRFQ = {
  rfqNo: string;
  customer: string;
  dueDate?: Date | string;
  [key: string]: unknown;
};

function fmtMoney(str: string): string {
  const n = parseFloat(str);
  if (isNaN(n)) return str;
  // Use Rs. prefix (₹ may not render in all PDF fonts)
  return (
    'Rs.' +
    n.toLocaleString('en-IN', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
  );
}

function fmtDate(d: Date | string | undefined): string {
  if (!d) return 'N/A';
  return new Date(d as string).toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

function fmtVol(n: number | string): string {
  return Number(n).toLocaleString('en-IN');
}

function d128Str(v: { toString(): string } | undefined | null): string {
  return v ? v.toString() : '0';
}

export async function generateQuotationPdf(
  quote: IQuote,
  rfq: AnyRFQ,
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    const chunks: Buffer[] = [];

    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const q = quote as unknown as Record<string, unknown>;
    const bd = q['costBreakdown'] as Record<string, string> | undefined;
    const tiers = (q['volumeTierResults'] as Array<Record<string, unknown>>) ?? [];
    const rs = q['rateSnapshot'] as Record<string, unknown> | undefined;
    const ci = q['costingInputSnapshot'] as Record<string, unknown> | undefined;

    const L = 50;   // left margin
    const R = 545;  // right margin
    const W = R - L;

    // ── HEADER ───────────────────────────────────────────────────────────────
    doc.fontSize(20).font('Helvetica-Bold').text('QUOTATION', { align: 'center' });
    doc.moveDown(0.3);
    doc.fontSize(10).font('Helvetica').text(
      'Company A — Precision Automotive Components',
      { align: 'center' },
    );
    doc.moveDown(0.6);
    doc.moveTo(L, doc.y).lineTo(R, doc.y).strokeColor('#CCCCCC').stroke();
    doc.moveDown(0.5);

    // Quote reference (right-aligned block)
    const refY = doc.y;
    doc.fontSize(9).font('Helvetica-Bold');
    doc.text(`Quotation Ref: ${rfq.rfqNo}-v${String(q['version'])}`, L, refY, {
      align: 'right',
      width: W,
    });
    doc.font('Helvetica').text(
      `Date: ${fmtDate(new Date())}`,
      L,
      doc.y,
      { align: 'right', width: W },
    );
    doc.text(
      'Validity: 30 days from quotation date',
      L,
      doc.y,
      { align: 'right', width: W },
    );
    doc.moveDown(0.8);

    // ── CUSTOMER DETAILS ─────────────────────────────────────────────────────
    doc.fontSize(10).font('Helvetica-Bold').text('Customer Details');
    doc.moveDown(0.2);
    doc.fontSize(9).font('Helvetica');
    doc.text(`Customer : ${rfq.customer}`);
    doc.text(`RFQ No.  : ${rfq.rfqNo}`);
    if (rfq.dueDate) doc.text(`RFQ Due  : ${fmtDate(rfq.dueDate as string)}`);
    doc.moveDown(0.8);

    // ── MATERIAL & COSTING SUMMARY ───────────────────────────────────────────
    doc.fontSize(10).font('Helvetica-Bold').text('Material & Costing Summary');
    doc.moveDown(0.2);
    doc.fontSize(9).font('Helvetica');

    if (rs) {
      const matRate = d128Str(rs['materialRatePerKg'] as { toString(): string } | null);
      doc.text(`Material          : ${String(rs['material'] ?? 'N/A')}`);
      doc.text(
        `Material Rate     : Rs.${matRate}/kg (eff. ${fmtDate(rs['materialRateEffectiveFrom'] as string)})`,
      );

      const ops = rs['operations'] as Array<Record<string, unknown>> | undefined;
      if (ops && ops.length > 0) {
        const opList = ops
          .map((op) => `${String(op['operationName'])} on ${String(op['machine'])}`)
          .join('; ');
        doc.text(`Routing           : ${opList}`);
      }

      doc.text(`Scrap             : ${String(rs['scrapPct'])}%`);
      doc.text(`Overhead          : ${String(rs['overheadPct'])}%`);
      doc.text(`GST               : ${String(rs['gstPct'])}%`);
      doc.text(`Margin            : ${String(rs['marginPct'])}%`);
    }

    if (ci) {
      doc.text(
        `Annual Volume     : ${fmtVol(ci['annualVolume'] as number)} pcs`,
      );
    }
    doc.text(`Costing Date      : ${fmtDate(q['costingDate'] as string)}`);
    doc.moveDown(0.8);

    // ── COST BREAKDOWN TABLE ─────────────────────────────────────────────────
    doc.fontSize(10).font('Helvetica-Bold').text(
      'Cost Breakdown — Per Piece (Base Tier, 100%)',
    );
    doc.moveDown(0.3);
    doc.moveTo(L, doc.y).lineTo(R, doc.y).strokeColor('#CCCCCC').stroke();
    doc.moveDown(0.2);

    const COL_VAL = 400;
    const COL_VAL_W = R - COL_VAL;

    function row(label: string, value: string, bold = false) {
      const y = doc.y;
      doc.fontSize(9).font(bold ? 'Helvetica-Bold' : 'Helvetica');
      doc.text(label, L, y, { width: 340 });
      doc.text(value, COL_VAL, y, { width: COL_VAL_W, align: 'right' });
      doc.moveDown(0.35);
    }

    if (bd) {
      row('Material Cost', fmtMoney(bd['materialCost']));
      row('Scrap Cost', fmtMoney(bd['scrapCost']));
      row('Conversion Cost (Routing)', fmtMoney(bd['conversionCost']));
      row('Overhead Cost', fmtMoney(bd['overheadCost']));
      row('Packing & Freight', fmtMoney(bd['packingFreight']));
      row('Setup Allocation / Piece', fmtMoney(bd['setupAllocationPerPiece']));
      doc.moveDown(0.1);
      doc.moveTo(L, doc.y).lineTo(R, doc.y).strokeColor('#CCCCCC').stroke();
      doc.moveDown(0.2);
      row('Total Cost / Piece', fmtMoney(bd['totalCost']), true);
      row('Selling Price (Ex-GST)', fmtMoney(bd['sellingPriceExGst']), true);
      row('GST Amount', fmtMoney(bd['gstAmount']));
      row('Selling Price (Incl. GST)', fmtMoney(bd['sellingPriceIncludingGst']), true);
    }

    doc.moveTo(L, doc.y).lineTo(R, doc.y).strokeColor('#CCCCCC').stroke();
    doc.moveDown(0.8);

    // Annual Quotation Value
    doc.fontSize(10).font('Helvetica-Bold');
    doc.text(
      `Annual Quotation Value (Base Tier Ex-GST × Annual Volume): ${fmtMoney(String(q['annualQuotationValue'] ?? '0'))}`,
    );
    doc.moveDown(0.8);

    // ── VOLUME TIER PRICING ──────────────────────────────────────────────────
    if (tiers.length > 0) {
      doc.fontSize(10).font('Helvetica-Bold').text('Volume Tier Pricing');
      doc.moveDown(0.3);
      doc.moveTo(L, doc.y).lineTo(R, doc.y).strokeColor('#CCCCCC').stroke();
      doc.moveDown(0.2);

      // Column positions
      const C = [L, L + 90, L + 190, L + 300, L + 400];

      doc.fontSize(8).font('Helvetica-Bold');
      const hY = doc.y;
      doc.text('Tier', C[0], hY, { width: 85 });
      doc.text('Volume (pcs)', C[1], hY, { width: 95, align: 'right' });
      doc.text('Total Cost/pc', C[2], hY, { width: 100, align: 'right' });
      doc.text('Ex-GST', C[3], hY, { width: 95, align: 'right' });
      doc.text('Incl. GST', C[4], hY, { width: 100, align: 'right' });
      doc.moveDown(0.4);
      doc.moveTo(L, doc.y).lineTo(R, doc.y).strokeColor('#CCCCCC').stroke();
      doc.moveDown(0.2);

      for (const tier of tiers) {
        const rY = doc.y;
        doc.fontSize(8).font('Helvetica');
        doc.text(
          `${String(tier['tierName'])} (${String(tier['tierPercentage'])}%)`,
          C[0],
          rY,
          { width: 85 },
        );
        doc.text(fmtVol(tier['tierVolume'] as number), C[1], rY, { width: 95, align: 'right' });
        doc.text(fmtMoney(String(tier['totalCostPerPiece'])), C[2], rY, { width: 100, align: 'right' });
        doc.text(fmtMoney(String(tier['sellingPriceExGst'])), C[3], rY, { width: 95, align: 'right' });
        doc.text(fmtMoney(String(tier['sellingPriceIncludingGst'])), C[4], rY, { width: 100, align: 'right' });
        doc.moveDown(0.4);
      }

      doc.moveTo(L, doc.y).lineTo(R, doc.y).strokeColor('#CCCCCC').stroke();
      doc.moveDown(0.8);
    }

    // ── COMMERCIAL TERMS ─────────────────────────────────────────────────────
    doc.fontSize(10).font('Helvetica-Bold').text('Commercial Terms');
    doc.moveDown(0.2);
    doc.fontSize(9).font('Helvetica');
    doc.text('- All prices are in Indian Rupees (INR).');
    doc.text('- GST is charged separately at the applicable rate and shown above.');
    doc.text('- Quotation validity: 30 days from date of issue.');
    doc.text('- Prices are based on the annual volumes stated above.');
    doc.text('- Subject to mutually agreed delivery schedule and payment terms.');
    doc.moveDown(0.8);

    // ── FOOTER ───────────────────────────────────────────────────────────────
    doc.moveTo(L, doc.y).lineTo(R, doc.y).strokeColor('#CCCCCC').stroke();
    doc.moveDown(0.3);
    doc.fontSize(8).font('Helvetica');
    doc.text(
      `Status: ${String(q['status'])}  |  Version: v${String(q['version'])}  |  Prepared by: Company A Estimating Team`,
    );
    doc.moveDown(0.2);
    doc.fillColor('#888888').fontSize(7).text(
      'All rates are locked at the time of costing and are not recalculated. ' +
        'This document is generated from a verified, immutable costing snapshot.',
      { align: 'center' },
    );

    doc.end();
  });
}

