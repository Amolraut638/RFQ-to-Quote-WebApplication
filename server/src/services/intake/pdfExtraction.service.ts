/**
 * services/intake/pdfExtraction.service.ts
 *
 * Deterministic PDF text-layer extraction with page numbers (pdf-parse v2).
 * This is document parsing, not AI. Scanned/image-only PDFs are detected and rejected
 * with a clear message — image understanding / OCR is NOT implemented.
 */

import { PDFParse } from 'pdf-parse';
import { IntakeError } from './fileValidation.service';
import type { PdfPageText } from '../ai/AIExtractor.service';

export const MAX_PDF_PAGES = 20;
const MIN_TEXT_CHARS = 30;
const MAX_CHARS_PER_PAGE = 8000;

export async function extractPdfPages(buffer: Buffer): Promise<PdfPageText[]> {
  let parser: PDFParse | undefined;
  try {
    parser = new PDFParse({ data: new Uint8Array(buffer) });
    const result = await parser.getText();
    if (result.total > MAX_PDF_PAGES) {
      throw new IntakeError('TOO_MANY_PAGES', `PDF has ${result.total} pages; the limit is ${MAX_PDF_PAGES}.`);
    }
    const pages = result.pages
      .map((p) => ({ num: p.num, text: (p.text ?? '').replace(/\u0000/g, '').trim().slice(0, MAX_CHARS_PER_PAGE) }))
      .filter((p) => p.text.length > 0);
    const totalChars = pages.reduce((n, p) => n + p.text.length, 0);
    if (totalChars < MIN_TEXT_CHARS) {
      throw new IntakeError(
        'SCANNED_PDF_UNSUPPORTED',
        'This PDF has no readable text layer (it looks scanned or image-only). Scanned drawings are not supported yet — upload a text-based PDF.',
      );
    }
    return pages;
  } catch (e) {
    if (e instanceof IntakeError) throw e;
    throw new IntakeError('MALFORMED_FILE', 'The PDF could not be read (it may be corrupt or encrypted).');
  } finally {
    await parser?.destroy().catch(() => undefined);
  }
}

