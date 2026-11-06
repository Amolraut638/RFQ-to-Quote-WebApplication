// Shared TypeScript types used by both client and server.
// No business logic here — types only.

export type UserRole = 'ESTIMATOR' | 'SALES_HEAD';

export type RFQStatus = 'ESTIMATING' | 'PENDING_APPROVAL' | 'SENT' | 'WON' | 'LOST';

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

