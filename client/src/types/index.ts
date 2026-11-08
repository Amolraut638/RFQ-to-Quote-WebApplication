// Shared TypeScript types used by both client and server.
// No business logic here — types only.

export type UserRole = 'ESTIMATOR' | 'SALES_HEAD';

export type RFQStatus = 'ESTIMATING' | 'PENDING_APPROVAL' | 'SENT' | 'WON' | 'LOST';

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

export interface RFQ {
  _id: string;
  rfqNo: string;
  customer: string;
  receivedDate: string;
  dueDate: string;
  ownerId: User | string;
  status: RFQStatus;
  lostReason?: string;
  isOverdue?: boolean;
  partName?: string;
  createdAt: string;
  updatedAt: string;
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
