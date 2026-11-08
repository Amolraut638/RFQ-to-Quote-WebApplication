/**
 * services/intake/fileValidation.service.ts
 *
 * Upload validation. Never trusts the extension or MIME alone: the content's magic
 * bytes must match an allowed type, and the extension/MIME must agree with it.
 */

import path from 'path';

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB

export type DetectedFileType = 'PDF' | 'XLSX' | 'XLS';

export class IntakeError extends Error {
  constructor(
    public readonly code:
      | 'NO_FILE'
      | 'FILE_TOO_LARGE'
      | 'UNSUPPORTED_FILE_TYPE'
      | 'FILE_CONTENT_MISMATCH'
      | 'MALFORMED_FILE'
      | 'TOO_MANY_PAGES'
      | 'SCANNED_PDF_UNSUPPORTED'
      | 'EMPTY_DOCUMENT'
      | 'DRAFT_NOT_FOUND'
      | 'DRAFT_NOT_EDITABLE'
      | 'VALIDATION_FAILED'
      | 'DUPLICATE_RFQ'
      | 'NOT_READY_TO_COMMIT'
      | 'INVALID_ID',
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'IntakeError';
  }
}

const MIME_BY_TYPE: Record<DetectedFileType, string[]> = {
  PDF: ['application/pdf'],
  XLSX: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  XLS: ['application/vnd.ms-excel'],
};
const EXT_BY_TYPE: Record<DetectedFileType, string[]> = {
  PDF: ['.pdf'],
  XLSX: ['.xlsx'],
  XLS: ['.xls'],
};

/** Detects the real type from magic bytes. Returns null if unrecognised. */
export function detectFileType(buf: Buffer): DetectedFileType | null {
  if (buf.length >= 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'PDF';
  if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) return 'XLSX';
  const ole = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
  if (buf.length >= 8 && ole.every((b, i) => buf[i] === b)) return 'XLS';
  return null;
}

export function validateUpload(file: { originalname: string; mimetype: string; size: number; buffer: Buffer } | undefined): DetectedFileType {
  if (!file) throw new IntakeError('NO_FILE', 'No file was uploaded (expected form field "file").');
  if (file.size > MAX_UPLOAD_BYTES) throw new IntakeError('FILE_TOO_LARGE', 'File exceeds the 10 MB limit.');
  const type = detectFileType(file.buffer);
  if (!type) {
    throw new IntakeError('UNSUPPORTED_FILE_TYPE', 'Only PDF and Excel (.xlsx, .xls) files are supported.');
  }
  const ext = path.extname(file.originalname).toLowerCase();
  if (!EXT_BY_TYPE[type].includes(ext) || !MIME_BY_TYPE[type].includes(file.mimetype)) {
    throw new IntakeError(
      'FILE_CONTENT_MISMATCH',
      'File extension or MIME type does not match the file content.',
    );
  }
  return type;
}

