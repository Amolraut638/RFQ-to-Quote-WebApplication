/**
 * services/intake/excelExtraction.service.ts
 *
 * Deterministic workbook reading (xlsx library): structure + exact cell references.
 * No column positions are assumed — the AI interprets the headers from this content.
 * Only non-empty cells within sane caps are sent to the model.
 */

import * as XLSX from 'xlsx';
import { IntakeError } from './fileValidation.service';
import type { ExcelCell, ExcelContent } from '../ai/AIExtractor.service';

const MAX_SHEETS = 10;
const MAX_ROWS_PER_SHEET = 200;
const MAX_COLS = 40;
const MAX_TOTAL_CELLS = 2500;
const MAX_CELL_CHARS = 200;

export function readWorkbook(buffer: Buffer): ExcelContent {
  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(buffer, {
      type: 'buffer',
      cellFormula: false,
      cellHTML: false,
      cellStyles: false,
      sheetRows: MAX_ROWS_PER_SHEET,
    });
  } catch {
    throw new IntakeError('MALFORMED_FILE', 'The Excel workbook could not be read (it may be corrupt).');
  }

  const cells: ExcelCell[] = [];
  const lines: string[] = [];

  for (const sheetName of wb.SheetNames.slice(0, MAX_SHEETS)) {
    const ws = wb.Sheets[sheetName];
    if (!ws || !ws['!ref']) continue;
    const range = XLSX.utils.decode_range(ws['!ref']);
    const lastRow = Math.min(range.e.r, MAX_ROWS_PER_SHEET - 1);
    const lastCol = Math.min(range.e.c, MAX_COLS - 1);
    lines.push(`## Sheet: ${sheetName}`);

    for (let r = range.s.r; r <= lastRow; r++) {
      const rowParts: string[] = [];
      for (let c = range.s.c; c <= lastCol; c++) {
        if (cells.length >= MAX_TOTAL_CELLS) break;
        const ref = XLSX.utils.encode_cell({ r, c });
        const cell = ws[ref] as XLSX.CellObject | undefined;
        if (!cell || cell.v === undefined || cell.v === null) continue;
        const text = String(cell.w ?? cell.v).trim().slice(0, MAX_CELL_CHARS);
        if (!text) continue;
        cells.push({ sheet: sheetName, ref, text });
        rowParts.push(`${sheetName}!${ref}=${text}`);
      }
      if (rowParts.length) lines.push(rowParts.join(' | '));
    }
  }

  if (cells.length === 0) {
    throw new IntakeError('EMPTY_DOCUMENT', 'The workbook contains no readable cell data.');
  }
  return { promptText: lines.join('\n'), cells };
}

