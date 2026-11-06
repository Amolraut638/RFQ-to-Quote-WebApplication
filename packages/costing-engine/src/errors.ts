/**
 * Structured errors. The engine never substitutes defaults: every problem with
 * the input is reported as a CostingIssue so the caller (and ultimately the
 * estimator) knows exactly which field to fix.
 */

export type CostingErrorCode =
  /** A rate / assumption that must come from a master was absent (null/undefined/empty). */
  | 'MISSING_RATE'
  /** A value was not a finite number, was negative, or otherwise unusable. */
  | 'INVALID_INPUT'
  /** A percentage was outside its permitted range. */
  | 'INVALID_PERCENTAGE'
  /** Annual or tier volume was zero, negative, fractional or non-numeric. */
  | 'INVALID_VOLUME'
  /** routingOperations was empty or not an array. */
  | 'EMPTY_ROUTING';

export interface CostingIssue {
  code: CostingErrorCode;
  /** Dotted/indexed path of the offending input, e.g. "routingOperations[1].machineHourRate". */
  field: string;
  message: string;
}

export class CostingError extends Error {
  /** Code of the first issue, for simple `switch` handling. */
  public readonly code: CostingErrorCode;
  public readonly field: string;
  /** Every problem found (validation collects all of them rather than stopping at the first). */
  public readonly issues: readonly CostingIssue[];

  constructor(issues: CostingIssue[]) {
    if (issues.length === 0) {
      throw new Error('CostingError requires at least one issue');
    }
    super(issues.map((i) => `${i.field}: ${i.message}`).join('; '));
    this.name = 'CostingError';
    this.code = issues[0].code;
    this.field = issues[0].field;
    this.issues = issues;
  }
}

