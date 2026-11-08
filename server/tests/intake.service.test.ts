/**
 * tests/intake.service.test.ts
 *
 * Automated unit tests for:
 *  - Email extraction & snippet provenance
 *  - Excel parsing & cell-level provenance (Sheet!Cell)
 *  - PDF text extraction & page-level provenance
 *  - Invalid files, oversized files, malformed documents
 *  - Field acceptance, editing, and rejection
 *  - Commit validation (only ACCEPTED/EDITED fields allowed, cost-field rejection)
 *  - Duplicate RFQ prevention
 *  - RFQ and Part creation
 *  - Transaction rollback on part creation failure
 *
 * AI inference and Mongoose persistence are mocked here.
 * Live Gemini + Atlas end-to-end verification is executed separately.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import * as XLSX from 'xlsx';
import PDFDocument from 'pdfkit';

// ─── Mock Mongoose models ────────────────────────────────────────────────────

const draftStore: Map<string, any> = new Map();
const rfqStore: any[] = [];
const partStore: any[] = [];
let failPartCreation = false;

vi.mock('../src/models/IntakeDraft', () => ({
  IntakeDraft: {
    create: vi.fn(async (data: any) => {
      const id = new mongoose.Types.ObjectId();
      const doc: any = {
        ...data,
        _id: id,
        markModified: vi.fn(),
        save: vi.fn(async function (this: any) {
          draftStore.set(String(this._id), this);
          return this;
        }),
      };
      draftStore.set(String(id), doc);
      return doc;
    }),
    findOne: vi.fn(async (filter: any) => {
      const doc = draftStore.get(String(filter._id));
      if (!doc) return null;
      if (filter.createdBy && String(doc.createdBy) !== String(filter.createdBy)) {
        return null;
      }
      return doc;
    }),
  },
}));

vi.mock('../src/models/RFQ', () => ({
  RFQ: {
    findOne: vi.fn((filter: any) => {
      const found = rfqStore.find((r) => r.rfqNo === filter.rfqNo) ?? null;
      return {
        session: () => Promise.resolve(found),
        then: (resolve: (v: any) => void) => Promise.resolve(found).then(resolve),
      };
    }),
    findById: vi.fn((id: any) => {
      const found = rfqStore.find((r) => String(r._id) === String(id)) ?? null;
      return {
        session: () => ({
          lean: () => Promise.resolve(found),
        }),
        lean: () => Promise.resolve(found),
      };
    }),
    create: vi.fn(async (docsOrDoc: any) => {
      const arr = Array.isArray(docsOrDoc) ? docsOrDoc : [docsOrDoc];
      const created = arr.map((d) => ({ ...d, _id: new mongoose.Types.ObjectId() }));
      rfqStore.push(...created);
      return Array.isArray(docsOrDoc) ? created : created[0];
    }),
  },
}));

vi.mock('../src/models/Part', () => ({
  Part: {
    create: vi.fn(async (docs: any[]) => {
      if (failPartCreation) {
        throw new Error('simulated Part.create database failure');
      }
      const created = docs.map((d) => ({ ...d, _id: new mongoose.Types.ObjectId() }));
      partStore.push(...created);
      return created;
    }),
  },
}));

// Transactional session mock with state rollback on throw
vi.spyOn(mongoose, 'startSession').mockImplementation(async () => {
  return {
    withTransaction: async (fn: () => Promise<void>) => {
      const snapRfqs = [...rfqStore];
      const snapParts = [...partStore];
      const snapDrafts = new Map(
        Array.from(draftStore.entries()).map(([k, v]) => [k, { ...v }]),
      );
      try {
        await fn();
      } catch (err) {
        rfqStore.length = 0;
        rfqStore.push(...snapRfqs);
        partStore.length = 0;
        partStore.push(...snapParts);
        draftStore.clear();
        for (const [k, v] of snapDrafts.entries()) draftStore.set(k, v);
        throw err;
      }
    },
    endSession: async () => undefined,
  } as never;
});

import {
  validateUpload,
  MAX_UPLOAD_BYTES,
  IntakeError,
} from '../src/services/intake/fileValidation.service';
import { readWorkbook } from '../src/services/intake/excelExtraction.service';
import { extractPdfPages } from '../src/services/intake/pdfExtraction.service';
import {
  createOrMergeEmailIntake,
  createOrMergeUploadIntake,
  updateDraftFields,
  commitIntakeDraft,
} from '../src/services/intake/intake.service';
import type { AIProvider } from '../src/services/ai/AIProvider';

const userId = new mongoose.Types.ObjectId().toString();

function buildPdfBuffer(pagesText: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ autoFirstPage: false });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    pagesText.forEach((t) => {
      doc.addPage();
      if (t) doc.fontSize(11).text(t, 50, 50);
    });
    doc.end();
  });
}

function buildXlsxBuffer(): Buffer {
  const wb = XLSX.utils.book_new();
  const rows = [
    ['Synthetic Inquiry Sheet', '', '', ''],
    ['Comp Description', 'Raw Mat Grade', 'Gross Wt (kg)', 'Yearly Qty'],
    ['Output Flange Shaft', 'EN8', 1.25, 18000],
    ['Bevel Pinion Blank', '20MnCr5', 0.92, 30000],
  ];
  const ws = XLSX.utils.aoa_to_sheet(rows);
  XLSX.utils.book_append_sheet(wb, ws, 'PartSchedule');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

beforeEach(() => {
  draftStore.clear();
  rfqStore.length = 0;
  partStore.length = 0;
  failPartCreation = false;
  vi.clearAllMocks();
});

describe('File validation & document parsing', () => {
  it('rejects missing, oversized, unsupported, and mismatched files', () => {
    expect(() => validateUpload(undefined)).toThrowError(IntakeError);

    expect(() =>
      validateUpload({
        originalname: 'big.pdf',
        mimetype: 'application/pdf',
        size: MAX_UPLOAD_BYTES + 1,
        buffer: Buffer.from('%PDF-1.7'),
      }),
    ).toThrow(/10 MB/);

    expect(() =>
      validateUpload({
        originalname: 'script.exe',
        mimetype: 'application/octet-stream',
        size: 100,
        buffer: Buffer.from('MZ90000000'),
      }),
    ).toThrow(/Only PDF and Excel/);

    // Extension says .pdf, magic bytes are plain text
    expect(() =>
      validateUpload({
        originalname: 'fake.pdf',
        mimetype: 'application/pdf',
        size: 100,
        buffer: Buffer.from('hello world not a pdf'),
      }),
    ).toThrow(/Only PDF and Excel/);

    // PDF magic bytes but .xlsx extension/MIME -> FILE_CONTENT_MISMATCH
    expect(() =>
      validateUpload({
        originalname: 'renamed.xlsx',
        mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        size: 100,
        buffer: Buffer.from('%PDF-1.7 test content'),
      }),
    ).toThrow(/does not match/);
  });

  it('rejects malformed PDF and Excel documents cleanly', async () => {
    await expect(extractPdfPages(Buffer.from('%PDF-corrupt-binary'))).rejects.toMatchObject({
      code: 'MALFORMED_FILE',
    });

    // Empty workbook (no cells) -> EMPTY_DOCUMENT
    const emptyWb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(emptyWb, XLSX.utils.aoa_to_sheet([]), 'Empty');
    const emptyBuf = XLSX.write(emptyWb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
    expect(() => readWorkbook(emptyBuf)).toThrowError(/no readable cell data/);
  });

  it('extracts Excel cells with exact worksheet and cell coordinates', () => {
    const buf = buildXlsxBuffer();
    const excel = readWorkbook(buf);
    expect(excel.cells.find((c) => c.sheet === 'PartSchedule' && c.ref === 'A3')?.text).toBe(
      'Output Flange Shaft',
    );
    expect(excel.cells.find((c) => c.sheet === 'PartSchedule' && c.ref === 'B3')?.text).toBe(
      'EN8',
    );
    expect(excel.cells.find((c) => c.sheet === 'PartSchedule' && c.ref === 'C3')?.text).toBe(
      '1.25',
    );
    expect(excel.cells.find((c) => c.sheet === 'PartSchedule' && c.ref === 'D3')?.text).toBe(
      '18000',
    );
  });

  it('extracts PDF text with page numbers and rejects empty/scanned PDFs', async () => {
    const pdfBuf = await buildPdfBuffer([
      'General notes page 1 with basic project notes only.',
      'TITLE BLOCK — PART NAME: Rear Axle Stub | DWG NO: DWG-AX-402 | REV: B | MATERIAL: EN8 | WEIGHT: 0.74 kg | CUSTOMER: Synthetic Auto Ltd',
    ]);
    const pages = await extractPdfPages(pdfBuf);
    expect(pages).toHaveLength(2);
    expect(pages[1].num).toBe(2);
    expect(pages[1].text).toContain('DWG-AX-402');

    const blankPdf = await buildPdfBuffer(['']);
    await expect(extractPdfPages(blankPdf)).rejects.toMatchObject({
      code: 'SCANNED_PDF_UNSUPPORTED',
    });
  });
});

describe('Intake workflow: email, Excel, PDF provenance, review, and transactional commit', () => {
  it('extracts email, Excel (cell provenance), and PDF (page provenance) into an IntakeDraft', async () => {
    const emailProvider: AIProvider = {
      providerName: 'gemini',
      modelName: 'gemini-3.8-flash',
      generateJson: vi.fn().mockResolvedValue(
        JSON.stringify({
          rfq: {
            rfqNo: { value: 'RFQ-SYN-501', snippet: 'RFQ Reference: RFQ-SYN-501' },
            customer: { value: 'Pune Driveline Corp', snippet: 'Customer: Pune Driveline Corp' },
            dueDate: { value: '2026-12-15', snippet: 'Due Date: 2026-12-15' },
          },
          parts: [],
        }),
      ),
    };

    const draft1 = await createOrMergeEmailIntake({
      userId,
      emailText:
        'RFQ Reference: RFQ-SYN-501\nCustomer: Pune Driveline Corp\nDue Date: 2026-12-15\nPlease see attached Excel schedule and drawing.',
      provider: emailProvider,
    });

    expect(draft1.status).toBe('REVIEW_REQUIRED');
    const rfqNoField = draft1.fields.find((f) => f.scope === 'RFQ' && f.key === 'rfqNo')!;
    expect(rfqNoField.value).toBe('RFQ-SYN-501');
    expect(rfqNoField.verified).toBe(true);
    expect(rfqNoField.status).toBe('PENDING');

    // Merge Excel part list into the same draft
    const xlsxBuf = buildXlsxBuffer();
    const excelProvider: AIProvider = {
      providerName: 'gemini',
      modelName: 'gemini-3.8-flash',
      generateJson: vi.fn().mockResolvedValue(
        JSON.stringify({
          rfq: {},
          parts: [
            {
              partName: { value: 'Output Flange Shaft', sheet: 'PartSchedule', cell: 'A3' },
              material: { value: 'EN8', sheet: 'PartSchedule', cell: 'B3' },
              grossWeightKg: { value: 1.25, sheet: 'PartSchedule', cell: 'C3' },
              annualVolume: { value: 18000, sheet: 'PartSchedule', cell: 'D3' },
            },
            {
              partName: { value: 'Bevel Pinion Blank', sheet: 'PartSchedule', cell: 'A4' },
              material: { value: '20MnCr5', sheet: 'PartSchedule', cell: 'B4' },
              grossWeightKg: { value: 0.92, sheet: 'PartSchedule', cell: 'C4' },
              annualVolume: { value: 30000, sheet: 'PartSchedule', cell: 'D4' },
            },
          ],
        }),
      ),
    };

    const draft2 = await createOrMergeUploadIntake({
      userId,
      draftId: String(draft1._id),
      file: {
        originalname: 'parts.xlsx',
        mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        size: xlsxBuf.length,
        buffer: xlsxBuf,
      },
      provider: excelProvider,
    });

    expect(draft2.partCount).toBe(2);
    const p0Mat = draft2.fields.find(
      (f) => f.scope === 'PART' && f.partIndex === 0 && f.key === 'material',
    )!;
    expect(p0Mat.value).toBe('EN8');
    expect(p0Mat.source.sheet).toBe('PartSchedule');
    expect(p0Mat.source.cell).toBe('B3');
    expect(p0Mat.source.originalValue).toBe('EN8');
    expect(p0Mat.verified).toBe(true);

    // Merge PDF title-block into the same draft (enriches Part #0 with drawingNumber & revision)
    const pdfBuf = await buildPdfBuffer([
      'Cover sheet notes for engineering package.',
      'TITLE BLOCK: PART NAME: Output Flange Shaft | DRAWING NO: DWG-OFS-77 | REV: C | MATERIAL: EN8',
    ]);
    const pdfProvider: AIProvider = {
      providerName: 'gemini',
      modelName: 'gemini-3.8-flash',
      generateJson: vi.fn().mockResolvedValue(
        JSON.stringify({
          rfq: {},
          parts: [
            {
              partName: {
                value: 'Output Flange Shaft',
                page: 2,
                snippet: 'PART NAME: Output Flange Shaft',
              },
              drawingNumber: {
                value: 'DWG-OFS-77',
                page: 2,
                snippet: 'DRAWING NO: DWG-OFS-77',
              },
              drawingRevision: {
                value: 'C',
                page: 2,
                snippet: 'REV: C',
              },
            },
          ],
        }),
      ),
    };

    const draft3 = await createOrMergeUploadIntake({
      userId,
      draftId: String(draft1._id),
      file: {
        originalname: 'drawing.pdf',
        mimetype: 'application/pdf',
        size: pdfBuf.length,
        buffer: pdfBuf,
      },
      provider: pdfProvider,
    });

    const dwgField = draft3.fields.find(
      (f) => f.scope === 'PART' && f.partIndex === 0 && f.key === 'drawingNumber',
    )!;
    expect(dwgField.value).toBe('DWG-OFS-77');
    expect(dwgField.source.page).toBe(2);
    expect(dwgField.verified).toBe(true);
  });

  it('enforces estimator acceptance/editing/rejection, blocks duplicate RFQs, and rolls back on failure', async () => {
    const provider: AIProvider = {
      providerName: 'gemini',
      modelName: 'gemini-3.8-flash',
      generateJson: vi.fn().mockResolvedValue(
        JSON.stringify({
          rfq: {
            rfqNo: { value: 'RFQ-SYN-777', snippet: 'RFQ: RFQ-SYN-777' },
            customer: { value: 'Chakan Gear Works', snippet: 'Customer: Chakan Gear Works' },
          },
          parts: [
            {
              partName: { value: 'Spindle Gear', snippet: 'Part: Spindle Gear' },
              material: { value: 'EN8', snippet: 'Material: EN8' },
              grossWeightKg: { value: 0.65, snippet: 'Weight: 0.65 kg' },
              annualVolume: { value: 40000, snippet: 'Volume: 40000' },
            },
          ],
        }),
      ),
    };

    const draft = await createOrMergeEmailIntake({
      userId,
      emailText:
        'RFQ: RFQ-SYN-777 | Customer: Chakan Gear Works | Part: Spindle Gear | Material: EN8 | Weight: 0.65 kg | Volume: 40000',
      provider,
    });

    // Cannot commit while fields are still PENDING
    await expect(
      commitIntakeDraft({ draftId: String(draft._id), userId }),
    ).rejects.toMatchObject({ code: 'NOT_READY_TO_COMMIT' });

    // Rejecting a required field keeps draft in REVIEW_REQUIRED
    await updateDraftFields({
      draftId: String(draft._id),
      userId,
      updates: [{ scope: 'RFQ', partIndex: -1, key: 'customer', action: 'REJECT' }],
    });
    expect(draft.status).toBe('REVIEW_REQUIRED');

    // Accept rfqNo, edit customer, accept part fields and edit annualVolume
    await updateDraftFields({
      draftId: String(draft._id),
      userId,
      updates: [
        { scope: 'RFQ', partIndex: -1, key: 'rfqNo', action: 'ACCEPT' },
        {
          scope: 'RFQ',
          partIndex: -1,
          key: 'customer',
          action: 'EDIT',
          value: 'Chakan Gear Works Pvt Ltd',
        },
        { scope: 'PART', partIndex: 0, key: 'partName', action: 'ACCEPT' },
        { scope: 'PART', partIndex: 0, key: 'material', action: 'ACCEPT' },
        { scope: 'PART', partIndex: 0, key: 'grossWeightKg', action: 'ACCEPT' },
        {
          scope: 'PART',
          partIndex: 0,
          key: 'annualVolume',
          action: 'EDIT',
          value: 45000,
        },
      ],
    });

    expect(draft.status).toBe('READY_TO_COMMIT');

    // Reject cost-related payload on commit
    await expect(
      commitIntakeDraft({
        draftId: String(draft._id),
        userId,
        extraPayload: { sellingPriceExGst: 999 },
      }),
    ).rejects.toMatchObject({ code: 'AI_COST_FIELD_REJECTED' });

    // Simulate part creation failure -> transaction rolls back RFQ creation
    failPartCreation = true;
    await expect(
      commitIntakeDraft({ draftId: String(draft._id), userId }),
    ).rejects.toThrow(/simulated Part\.create/);
    expect(rfqStore).toHaveLength(0);
    expect(partStore).toHaveLength(0);
    expect(draft.status).toBe('READY_TO_COMMIT');

    // Now succeed
    failPartCreation = false;
    const committed = await commitIntakeDraft({ draftId: String(draft._id), userId });
    expect(committed.rfq.rfqNo).toBe('RFQ-SYN-777');
    expect(committed.rfq.customer).toBe('Chakan Gear Works Pvt Ltd');
    expect(committed.parts).toHaveLength(1);
    expect(committed.parts[0].annualVolume).toBe(45000);
    expect(committed.draft.status).toBe('COMMITTED');

    // Duplicate RFQ check on another draft with the same rfqNo
    const dupDraft = await createOrMergeEmailIntake({
      userId,
      emailText:
        'RFQ: RFQ-SYN-777 | Customer: Chakan Gear Works | Part: Spindle Gear | Material: EN8 | Weight: 0.65 kg | Volume: 40000',
      provider,
    });
    await updateDraftFields({
      draftId: String(dupDraft._id),
      userId,
      updates: [
        { scope: 'RFQ', partIndex: -1, key: 'rfqNo', action: 'ACCEPT' },
        { scope: 'RFQ', partIndex: -1, key: 'customer', action: 'ACCEPT' },
        { scope: 'PART', partIndex: 0, key: 'partName', action: 'ACCEPT' },
        { scope: 'PART', partIndex: 0, key: 'material', action: 'ACCEPT' },
        { scope: 'PART', partIndex: 0, key: 'grossWeightKg', action: 'ACCEPT' },
        { scope: 'PART', partIndex: 0, key: 'annualVolume', action: 'ACCEPT' },
      ],
    });
    await expect(
      commitIntakeDraft({ draftId: String(dupDraft._id), userId }),
    ).rejects.toMatchObject({ code: 'DUPLICATE_RFQ' });
  });
});

