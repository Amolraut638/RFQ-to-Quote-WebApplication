// Shared TypeScript types used by both client and server.
// No business logic here — types only.

export type UserRole = 'ESTIMATOR' | 'SALES_HEAD';

export type RFQStatus = 'ESTIMATING' | 'PENDING_APPROVAL' | 'SENT' | 'WON' | 'LOST';

export type LostReason =
  | 'PRICE_TOO_HIGH'
  | 'DELIVERY_TIMELINE'
  | 'COMPETITOR_SELECTED'
  | 'TECHNICAL_REJECTION'
  | 'CUSTOMER_CANCELLED'
  | 'OTHER';

export type QuoteStatus = 'DRAFT' | 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED' | 'READY_FOR_SALES' | 'SENT';

export interface User {
  _id: string;
  name: string;
  email: string;
  role: UserRole;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface RFQEvent {
  _id: string;
  rfqId: string;
  action: 'SENT' | 'WON' | 'LOST';
  previousStatus: RFQStatus;
  newStatus: 'SENT' | 'WON' | 'LOST';
  actorId: PopulatedUserRef | string;
  timestamp: string;
  lostReason?: LostReason;
  lostReasonNote?: string;
  quoteId?: string;
  quoteVersion?: number;
}

export interface RFQ {
  _id: string;
  rfqNo: string;
  customer: string;
  receivedDate: string;
  dueDate: string;
  ownerId: User | string;
  status: RFQStatus;
  lostReason?: LostReason | string;
  lostReasonNote?: string;
  outcomeUpdatedBy?: PopulatedUserRef | User | string | null;
  outcomeUpdatedAt?: string;
  isOverdue?: boolean;
  partName?: string;
  partCount?: number;
  latestQuoteStatus?: QuoteStatus | null;
  latestQuoteVersion?: number | null;
  hasSentQuote?: boolean;
  outcomeEvents?: RFQEvent[];
  importSource?: 'HISTORICAL_EXCEL' | null;
  importBatchId?: string | null;
  isSyntheticDemo?: boolean;
  createdAt: string;
  updatedAt: string;
}

export type ImportRowStatus =
  | 'IMPORTED'
  | 'SKIPPED_INCOMPLETE'
  | 'SKIPPED_DUPLICATE_IN_FILE'
  | 'SKIPPED_ALREADY_EXISTS'
  | 'FAILED_VALIDATION';

export interface ImportRowIssue {
  rowNumber: number;
  rfqNo: string;
  partName: string;
  status: ImportRowStatus | 'PRICE_DISCREPANCY';
  reason: string;
  missingFields?: string[];
  statedPriceExGst?: string;
  calculatedPriceExGst?: string;
  priceDiscrepancyDelta?: string;
}

export interface HistoricalImportSummary {
  dryRun: boolean;
  importBatchId: string;
  totalRowsRead: number;
  completeRowsCount: number;
  importedQuotesCount: number;
  createdRfqsCount: number;
  createdPartsCount: number;
  skippedDuplicateInFileCount: number;
  skippedAlreadyExistsCount: number;
  skippedIncompleteCount: number;
  failedValidationCount: number;
  priceDiscrepancyCount: number;
  syntheticDemoRowsCount: number;
  durationMs: number;
  rowIssues: ImportRowIssue[];
}

export interface Part {
  _id: string;
  rfqId: string;
  partName: string;
  material: string;
  grossWeightKg: number;
  annualVolume: number;
  cycleTimeMinutes?: number;
  drawingNumber?: string;
  drawingRevision?: string;
}

export interface ApiResponse<T> {
  success: boolean;
  data: T;
  error?: string;
}

// ─── Costing workflow types ───────────────────────────────────────────────────

export interface RoutingOperationInput {
  operationName: string;
  machine: string;
  cycleTimeMinutes: number;
}

export interface CostBreakdown {
  materialCost: string;
  scrapCost: string;
  conversionCost: string;
  overheadCost: string;
  packingFreight: string;
  baseManufacturingCost: string;
  setupAllocationPerPiece: string;
  totalCost: string;
  sellingPriceExGst: string;
  gstAmount: string;
  sellingPriceIncludingGst: string;
}

export interface VolumeTier {
  tierName: string;
  tierPercentage: number;
  tierVolume: number;
  setupAllocationPerPiece: string;
  totalCostPerPiece: string;
  sellingPriceExGst: string;
  gstAmount: string;
  sellingPriceIncludingGst: string;
}

export interface QuoteSummary {
  _id: string;
  rfqId: string;
  version: number;
  status: QuoteStatus;
  annualQuotationValue: string;
  totalAnnualValue?: string;
  costingDate: string;
  createdAt: string;
  costBreakdown?: CostBreakdown;
  volumeTierResults?: VolumeTier[];
  // Day 4 additions — optional for backward compat
  approverId?: string;
  approvedAt?: string;
  rejectedBy?: string;
  rejectedAt?: string;
  rejectionComment?: string;
  submittedBy?: string;
  submittedAt?: string;
  sentBy?: string;
  sentAt?: string;
  importSource?: 'HISTORICAL_EXCEL' | null;
  importBatchId?: string | null;
  externalRowKey?: string | null;
  isSyntheticDemo?: boolean;
  historicalStatedPriceExGst?: string | null;
  priceDiscrepancyFlag?: boolean;
  priceDiscrepancyDelta?: string | null;
}

export interface MachineOption {
  machine: string;
  hourRate: string;
  effectiveFrom: string;
}

export interface CostingContext {
  rfq: { _id: string; rfqNo: string; customer: string; dueDate: string; status: string };
  part: {
    _id: string;
    partName: string;
    material: string;
    grossWeightKg: number;
    annualVolume: number;
    cycleTimeMinutes?: number;
  };
  materialRate: { material: string; ratePerKg: string; effectiveFrom: string };
  rateSettings: {
    scrapPct: number;
    overheadPct: number;
    packingFreight: string;
    defaultMarginPct: number;
    gstPct: number;
    setupCostPerPart: string;
    effectiveFrom: string;
  };
  availableMachines: MachineOption[];
  costingDate: string;
}

export interface ApprovalDecision {
  totalAnnualValue: string;
  threshold: string;
  requiresApproval: boolean;
}

export interface CostingPreviewResult {
  breakdown: CostBreakdown;
  volumeTiers: VolumeTier[];
  annualQuotationValue: string;
  approvalDecision: ApprovalDecision;
  costingDate: string;
}

export interface CostingFormInputs {
  partId: string;
  routingOperations: RoutingOperationInput[];
  scrapPct: number;
  overheadPct: number;
  packingFreight: number;
  setupCost: number;
  marginPct: number;
  gstPct: number;
  costingDate: string;
}

// ─── Day 4: Approval workflow types ──────────────────────────────────────────

export interface PopulatedUserRef {
  _id: string;
  name: string;
  email: string;
  role?: string;
}

export interface PopulatedRFQRef {
  _id: string;
  rfqNo: string;
  customer: string;
  dueDate: string;
}

export interface QuoteEvent {
  _id: string;
  action: 'SUBMITTED' | 'APPROVED' | 'REJECTED' | 'SENT';
  actorId: PopulatedUserRef | string;
  timestamp: string;
  comment?: string;
}

/** Full quote detail returned by GET /api/approvals/:quoteId */
export interface QuoteDetail extends Omit<QuoteSummary, 'rfqId' | 'approverId'> {
  rfqId: PopulatedRFQRef | string;
  createdBy: PopulatedUserRef | string;
  approverId?: PopulatedUserRef | string;
  rateSnapshot?: {
    material: string;
    materialRatePerKg: string;
    materialRateEffectiveFrom: string;
    operations: Array<{
      operationName: string;
      machine: string;
      cycleTimeMinutes: string;
      machineHourRate: string;
      machineRateEffectiveFrom: string;
    }>;
    scrapPct: number;
    overheadPct: number;
    packingFreight: string;
    marginPct: number;
    gstPct: number;
    setupCostPerPart: string;
    rateSettingEffectiveFrom: string;
    snapshotCreatedAt: string;
  };
  costingInputSnapshot?: {
    grossWeightKg: string;
    materialRatePerKg: string;
    scrapPct: number;
    routingOperations: Array<{
      operationName: string;
      machine: string;
      cycleTimeMinutes: string;
      machineHourRate: string;
    }>;
    overheadPct: number;
    packingFreightPerPiece: string;
    setupCostPerPart: string;
    annualVolume: number;
    defaultMarginPct: number;
    gstPct: number;
  };
}

/** Entry in the pending approvals list (GET /api/approvals/pending) */
export interface PendingApproval {
  _id: string;
  rfqId: PopulatedRFQRef | string;
  version: number;
  status: QuoteStatus;
  annualQuotationValue: string;
  totalAnnualValue: string;
  createdBy: PopulatedUserRef | string;
  submittedAt?: string;
  createdAt: string;
}

// ─── Day 5: AI-Assisted RFQ Intake & Routing Suggestions ─────────────────────

export type IntakeSourceType = 'EMAIL' | 'EXCEL' | 'PDF';
export type FieldStatus = 'PENDING' | 'ACCEPTED' | 'EDITED' | 'REJECTED';
export type DraftStatus = 'PROCESSING' | 'REVIEW_REQUIRED' | 'READY_TO_COMMIT' | 'COMMITTED' | 'FAILED';

export interface IntakeAIStatus {
  configured: boolean;
  provider: string;
  model: string | null;
  dataPolicyNotice: string;
}

export interface IntakeFieldSource {
  fileName: string;
  sourceType: IntakeSourceType | 'MANUAL';
  page: number | null;
  sheet: string | null;
  cell: string | null;
  originalValue: string | null;
  snippet: string | null;
}

export interface IntakeDraftField {
  scope: 'RFQ' | 'PART';
  partIndex: number;
  key: string;
  value: string | number | null;
  aiValue: string | number | null;
  source: IntakeFieldSource;
  method: 'AI' | 'MANUAL';
  confidence: number | null;
  verified: boolean;
  status: FieldStatus;
}

export interface IntakeDraft {
  _id: string;
  createdBy: string;
  sourceType: IntakeSourceType;
  sources: Array<{
    sourceType: IntakeSourceType;
    fileName: string;
    mimeType?: string;
    sizeBytes?: number;
    pageCount?: number;
    sheetCount?: number;
    extractedAt: string;
  }>;
  ai: {
    provider: string;
    model: string;
    extractedAt: string;
  };
  fields: IntakeDraftField[];
  partCount: number;
  status: DraftStatus;
  readiness: {
    ready: boolean;
    missingReasons: string[];
  };
  committedRfqId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FieldUpdateAction {
  scope: 'RFQ' | 'PART';
  partIndex: number;
  key: string;
  action: 'ACCEPT' | 'EDIT' | 'REJECT';
  value?: string | number | null;
}

export interface RoutingSuggestionResult {
  hasSuggestion: boolean;
  suggestedOperations: RoutingOperationInput[];
  basedOnPartId: string | null;
  historicalPartName: string | null;
  historicalRFQNo: string | null;
  historicalQuoteVersion: number | null;
  historicalGrossWeightKg: number | null;
  historicalMaterial: string | null;
  reason: string;
  provider: string;
  model: string;
}

// ─── Historical Quote Comparison ─────────────────────────────────────────────

export interface HistoricalQuoteMatch {
  quoteId: string;
  partId: string | null;
  historicalPartName: string;
  drawingNumber: string | null;
  drawingRevision: string | null;
  material: string;
  partWeightKg: number;
  customerName: string;
  rfqId: string;
  rfqNo: string;
  quoteVersion: number;
  quoteDate: string;
  historicalQuoteStatus: QuoteStatus;
  historicalMaterialRate: string;
  historicalMachineRates: Array<{
    operationName: string;
    machine: string;
    machineHourRate: string;
    effectiveFrom: string;
  }>;
  historicalRoutingOperations: Array<{
    operationName: string;
    machine: string;
    cycleTimeMinutes: number;
    machineHourRate: string;
  }>;
  historicalScrapPct: number;
  historicalOverheadPct: number;
  historicalMarginPct: number;
  historicalGstPct: number;
  historicalPackingFreight: string;
  historicalSetupCost: string;
  historicalPricePerPieceExGst: string;
  historicalPricePerPieceIncGst: string;
  historicalAnnualVolume: number;
  historicalAnnualQuoteValue: string;
  similarityScore: number;
  weightDifferencePct: number;
  withinWeightTolerance: boolean;
  weightTolerancePct: number;
  matchFlags: {
    exactDrawingMatch: boolean;
    sameMaterial: boolean;
    similarWeight: boolean;
    similarName: boolean;
  };
  matchReasons: string[];
  importSource?: 'HISTORICAL_EXCEL' | null;
  isSyntheticDemo?: boolean;
  historicalStatedPriceExGst?: string | null;
  priceDiscrepancyFlag?: boolean;
  priceDiscrepancyDelta?: string | null;
}

export interface SearchHistoricalQuotesResponse {
  targetPart: {
    _id: string;
    partName: string;
    drawingNumber: string | null;
    material: string;
    grossWeightKg: number;
    annualVolume: number;
  };
  weightTolerancePct: number;
  limit: number;
  matches: HistoricalQuoteMatch[];
}

export interface ComparisonRow {
  key: string;
  label: string;
  unit: 'INR_PER_KG' | 'INR_PER_PC' | 'INR' | 'PCT' | 'PCS';
  currentValue: string;
  historicalValue: string;
  absoluteDifference: string;
  percentageDifference: string | null;
  note?: string;
}

export interface HistoricalQuoteComparisonResult {
  tierPercentage: number;
  isDirectlyEquivalent: boolean;
  equivalenceWarnings: string[];
  current: {
    partId: string;
    partName: string;
    material: string;
    grossWeightKg: number;
    costingDate: string;
    annualVolume: number;
    tierVolume: number;
    sellingPricePerPieceExGst: string;
    annualQuoteValue: string;
  };
  historical: HistoricalQuoteMatch & {
    comparedTierVolume: number;
    comparedTierSellingPriceExGst: string;
  };
  priceDelta: {
    currentPriceExGst: string;
    historicalPriceExGst: string;
    absoluteDifference: string;
    percentageDifference: string | null;
  };
  annualValueDelta: {
    currentAnnualValue: string;
    historicalAnnualValue: string;
    absoluteDifference: string;
    percentageDifference: string | null;
  };
  rows: ComparisonRow[];
}

// ─── Quote Revision Comparison ───────────────────────────────────────────────

export type ChangeDirection = 'INCREASED' | 'DECREASED' | 'UNCHANGED';

export interface RevisionUserSummary {
  _id: string;
  name: string;
  email: string;
  role?: string;
}

export interface RevisionEventSummary {
  action: 'SUBMITTED' | 'APPROVED' | 'REJECTED' | 'SENT';
  actor: RevisionUserSummary | string;
  timestamp: string;
  comment: string | null;
}

export interface RevisionMetadata {
  quoteId: string;
  version: number;
  status: QuoteStatus;
  costingDate: string;
  createdAt: string;
  createdBy: RevisionUserSummary | string;
  submittedBy: RevisionUserSummary | string | null;
  submittedAt: string | null;
  approvedBy: RevisionUserSummary | string | null;
  approvedAt: string | null;
  rejectedBy: RevisionUserSummary | string | null;
  rejectedAt: string | null;
  rejectionComment: string | null;
  sentBy: RevisionUserSummary | string | null;
  sentAt: string | null;
  events: RevisionEventSummary[];
}

export interface RevisionComparisonRow {
  key: string;
  label: string;
  category: 'SPEC_AND_RATES' | 'COST_BREAKDOWN' | 'SELLING_PRICE_AND_VOLUME' | 'GST';
  unit: 'INR_PER_KG' | 'INR_PER_PC' | 'INR' | 'KG' | 'PCT' | 'PCS';
  versionAValue: string;
  versionBValue: string;
  absoluteDifference: string;
  percentageDifference: string | null;
  direction: ChangeDirection;
  note?: string;
}

export type RoutingDiffStatus = 'UNCHANGED' | 'MODIFIED' | 'ADDED' | 'REMOVED';

export interface RoutingOperationDiff {
  stepNumberA: number | null;
  stepNumberB: number | null;
  operationName: string;
  status: RoutingDiffStatus;
  machineA: string | null;
  machineB: string | null;
  machineChanged: boolean;
  machineHourRateA: string | null;
  machineHourRateB: string | null;
  machineHourRateDiff: string | null;
  machineHourRatePctDiff: string | null;
  cycleTimeMinutesA: string | null;
  cycleTimeMinutesB: string | null;
  cycleTimeDiffMinutes: string | null;
  cycleTimePctDiff: string | null;
  operationCostA: string | null;
  operationCostB: string | null;
  operationCostDiff: string | null;
  operationCostPctDiff: string | null;
}

export interface TierMetricDiff {
  valueA: string;
  valueB: string;
  absoluteDifference: string;
  percentageDifference: string | null;
  direction: ChangeDirection;
}

export interface VolumeTierRevisionComparison {
  tierPercentage: 50 | 100 | 150;
  tierName: string;
  tierVolume: TierMetricDiff;
  setupAllocationPerPiece: TierMetricDiff;
  totalCostPerPiece: TierMetricDiff;
  sellingPriceExGst: TierMetricDiff;
  gstAmount: TierMetricDiff;
  sellingPriceIncludingGst: TierMetricDiff;
  tierAnnualQuoteValueExGst: TierMetricDiff;
}

export interface QuoteRevisionComparisonResult {
  rfq: {
    _id: string;
    rfqNo: string;
    customer: string;
  };
  part: {
    _id: string | null;
    partName: string;
    drawingNumber: string | null;
    materialA: string;
    materialB: string;
    materialChanged: boolean;
  };
  versionA: RevisionMetadata;
  versionB: RevisionMetadata;
  summary: {
    sellingPriceExGst: TierMetricDiff;
    totalCostPerPiece: TierMetricDiff;
    annualQuoteValue: TierMetricDiff;
    gstAmountPerPiece: TierMetricDiff;
    sellingPriceIncludingGst: TierMetricDiff;
    totalCycleTimeMinutes: TierMetricDiff;
  };
  parameterRows: RevisionComparisonRow[];
  gstRows: RevisionComparisonRow[];
  routingComparison: {
    operations: RoutingOperationDiff[];
    addedCount: number;
    removedCount: number;
    modifiedCount: number;
    unchangedCount: number;
  };
  tierComparisons: VolumeTierRevisionComparison[];
}


