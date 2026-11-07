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
