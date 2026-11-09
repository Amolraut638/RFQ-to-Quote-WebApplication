/**
 * seed/generateHistoricalExcel.ts
 *
 * Generates the 1,400-row synthetic historical quotes Excel workbook on disk at:
 *   server/src/seed/synthetic-historical-quotes-1400.xlsx
 *
 * All rows are clearly marked as SYNTHETIC DEMO DATA.
 */

import fs from 'fs';
import path from 'path';
import {
  generateSynthetic1400HistoricalWorkbookBuffer,
  generateHistoricalImportTemplateBuffer,
} from '../services/historicalImport.service';

const outDir = __dirname;
const syntheticPath = path.join(outDir, 'synthetic-historical-quotes-1400.xlsx');
const templatePath = path.join(outDir, 'historical-quotes-template.xlsx');

const syntheticBuf = generateSynthetic1400HistoricalWorkbookBuffer();
fs.writeFileSync(syntheticPath, syntheticBuf);
console.log(
  `[generateHistoricalExcel] Wrote 1,400-row synthetic workbook (${syntheticBuf.length} bytes) to ${syntheticPath}`,
);

const templateBuf = generateHistoricalImportTemplateBuffer();
fs.writeFileSync(templatePath, templateBuf);
console.log(
  `[generateHistoricalExcel] Wrote template workbook (${templateBuf.length} bytes) to ${templatePath}`,
);
