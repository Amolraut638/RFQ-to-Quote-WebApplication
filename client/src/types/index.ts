// Shared TypeScript types used by both client and server.
// No business logic here — types only.

export type UserRole = 'ESTIMATOR' | 'SALES_HEAD';

export type RFQStatus = 'ESTIMATING' | 'PENDING_APPROVAL' | 'SENT' | 'WON' | 'LOST';

export type QuoteStatus = 'DRAFT' | 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED' | 'SENT';

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

