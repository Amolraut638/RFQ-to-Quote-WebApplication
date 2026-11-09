import api from './client';
import {
  User,
  RFQ,
  RFQEvent,
  LostReason,
  HistoricalImportSummary,
  Part,
  ApiResponse,
  CostingContext,
  CostingPreviewResult,
  RoutingOperationInput,
  QuoteSummary,
  QuoteDetail,
  QuoteEvent,
  PendingApproval,
  IntakeAIStatus,
  IntakeDraft,
  FieldUpdateAction,
  RoutingSuggestionResult,
  SearchHistoricalQuotesResponse,
  HistoricalQuoteComparisonResult,
  QuoteRevisionComparisonResult,
} from '../types';

export const authApi = {
  login: (email: string, password: string) =>
    api.post<{ success: boolean; user: User }>('/api/auth/login', { email, password }),

  logout: () =>
    api.post<{ success: boolean }>('/api/auth/logout'),

  me: () =>
    api.get<{ user: User }>('/api/auth/me'),
};

export const rfqApi = {
  list: () =>
    api.get<ApiResponse<RFQ[]>>('/api/rfqs'),

  get: (id: string) =>
    api.get<ApiResponse<RFQ & { parts: Part[] }>>(`/api/rfqs/${id}`),

  updateOutcome: (
    rfqId: string,
    body: {
      outcome: 'WON' | 'LOST';
      lostReason?: LostReason;
      lostReasonNote?: string;
    },
  ) =>
    api.patch<ApiResponse<{ rfq: RFQ; auditEvent: RFQEvent }>>(
      `/api/rfqs/${rfqId}/outcome`,
      body,
    ),

  downloadHistoricalTemplate: () =>
    api.get('/api/rfqs/historical-import/template', { responseType: 'blob' }),

  downloadSyntheticDemoWorkbook: () =>
    api.get('/api/rfqs/historical-import/synthetic-demo', { responseType: 'blob' }),

  importHistoricalQuotes: (params: {
    file?: File | null;
    useSyntheticDemo?: boolean;
    dryRun?: boolean;
  }) => {
    const formData = new FormData();
    if (params.file) {
      formData.append('file', params.file);
    }
    if (params.useSyntheticDemo) {
      formData.append('useSyntheticDemo', 'true');
    }
    if (params.dryRun) {
      formData.append('dryRun', 'true');
    }
    const query = new URLSearchParams();
    if (params.dryRun) query.set('dryRun', 'true');
    if (params.useSyntheticDemo) query.set('useSyntheticDemo', 'true');
    const qs = query.toString();
    return api.post<ApiResponse<HistoricalImportSummary>>(
      `/api/rfqs/historical-import${qs ? `?${qs}` : ''}`,
      formData,
      { headers: { 'Content-Type': 'multipart/form-data' } },
    );
  },
};

export const costingApi = {
  getContext: (rfqId: string, partId: string, costingDate?: string) => {
    const params = new URLSearchParams({ partId });
    if (costingDate) params.set('costingDate', costingDate);
    return api.get<ApiResponse<CostingContext>>(
      `/api/rfqs/${rfqId}/costing-context?${params.toString()}`,
    );
  },

  preview: (
    rfqId: string,
    body: {
      partId: string;
      routingOperations: RoutingOperationInput[];
      scrapPct?: number;
      overheadPct?: number;
      packingFreight?: number;
      setupCost?: number;
      marginPct?: number;
      gstPct?: number;
      costingDate?: string;
    },
  ) =>
    api.post<ApiResponse<CostingPreviewResult>>(
      `/api/rfqs/${rfqId}/costing-preview`,
      body,
    ),

  saveQuote: (
    rfqId: string,
    body: {
      partId: string;
      routingOperations: RoutingOperationInput[];
      scrapPct?: number;
      overheadPct?: number;
      packingFreight?: number;
      setupCost?: number;
      marginPct?: number;
      gstPct?: number;
      costingDate?: string;
    },
  ) =>
    api.post<ApiResponse<QuoteSummary>>(`/api/rfqs/${rfqId}/quotes`, body),

  listQuotes: (rfqId: string) =>
    api.get<ApiResponse<QuoteSummary[]>>(`/api/rfqs/${rfqId}/quotes`),

  getQuote: (rfqId: string, quoteId: string) =>
    api.get<ApiResponse<QuoteSummary>>(`/api/rfqs/${rfqId}/quotes/${quoteId}`),

  /** Submit a DRAFT quote for approval / ready-for-sales. ESTIMATOR only. */
  submitQuote: (rfqId: string, quoteId: string) =>
    api.post<ApiResponse<QuoteSummary>>(`/api/rfqs/${rfqId}/quotes/${quoteId}/submit`),

  /** Mark an APPROVED or READY_FOR_SALES quote as sent. SALES_HEAD only. */
  markSent: (rfqId: string, quoteId: string) =>
    api.post<ApiResponse<QuoteSummary>>(`/api/rfqs/${rfqId}/quotes/${quoteId}/mark-sent`),

  /** Download the PDF for an APPROVED / READY_FOR_SALES / SENT quote. */
  downloadPdf: (rfqId: string, quoteId: string) =>
    api.get(`/api/rfqs/${rfqId}/quotes/${quoteId}/pdf`, { responseType: 'blob' }),
};

export const approvalApi = {
  /** GET /api/approvals/pending — Sales Head: list all PENDING_APPROVAL quotes. */
  getPending: () =>
    api.get<ApiResponse<PendingApproval[]>>('/api/approvals/pending'),

  /** GET /api/approvals/:quoteId — get quote + audit trail. */
  getQuote: (quoteId: string) =>
    api.get<ApiResponse<{ quote: QuoteDetail; events: QuoteEvent[] }>>(`/api/approvals/${quoteId}`),

  /** POST /api/approvals/:quoteId/approve */
  approve: (quoteId: string) =>
    api.post<ApiResponse<QuoteDetail>>(`/api/approvals/${quoteId}/approve`),

  /** POST /api/approvals/:quoteId/reject — body: { comment } */
  reject: (quoteId: string, comment: string) =>
    api.post<ApiResponse<QuoteDetail>>(`/api/approvals/${quoteId}/reject`, { comment }),
};

export const intakeApi = {
  getStatus: () =>
    api.get<ApiResponse<IntakeAIStatus>>('/api/intake/status'),

  extractEmail: (emailText: string, draftId?: string) =>
    api.post<ApiResponse<IntakeDraft>>('/api/intake/email', { emailText, draftId }),

  uploadFile: (file: File, draftId?: string) => {
    const formData = new FormData();
    formData.append('file', file);
    if (draftId) formData.append('draftId', draftId);
    return api.post<ApiResponse<IntakeDraft>>('/api/intake/upload', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
  },

  getDraft: (id: string) =>
    api.get<ApiResponse<IntakeDraft>>(`/api/intake/${id}`),

  patchFields: (id: string, body: { updates: FieldUpdateAction[]; addPart?: boolean }) =>
    api.patch<ApiResponse<IntakeDraft>>(`/api/intake/${id}/fields`, body),

  commit: (id: string) =>
    api.post<ApiResponse<{ rfq: RFQ; parts: Part[]; draft: IntakeDraft }>>(
      `/api/intake/${id}/commit`,
      {},
    ),
};

export const partApi = {
  getRoutingSuggestions: (partId: string) =>
    api.get<ApiResponse<RoutingSuggestionResult>>(`/api/parts/${partId}/routing-suggestions`),

  getHistoricalQuotes: (
    partId: string,
    params?: { limit?: number; weightTolerancePct?: number },
  ) => {
    const query = new URLSearchParams();
    if (params?.limit !== undefined) query.set('limit', String(params.limit));
    if (params?.weightTolerancePct !== undefined) {
      query.set('weightTolerancePct', String(params.weightTolerancePct));
    }
    const qs = query.toString();
    return api.get<ApiResponse<SearchHistoricalQuotesResponse>>(
      `/api/parts/${partId}/historical-quotes${qs ? `?${qs}` : ''}`,
    );
  },

  compareHistoricalQuote: (
    partId: string,
    quoteId: string,
    body: {
      rfqId: string;
      routingOperations: RoutingOperationInput[];
      scrapPct?: number;
      overheadPct?: number;
      packingFreight?: number;
      setupCost?: number;
      marginPct?: number;
      gstPct?: number;
      costingDate?: string;
      tierPercentage?: 50 | 100 | 150;
    },
  ) =>
    api.post<ApiResponse<HistoricalQuoteComparisonResult>>(
      `/api/parts/${partId}/historical-quotes/${quoteId}/compare`,
      body,
    ),
};

export const quoteApi = {
  /** GET /api/quotes/:quoteId/compare?versionA=1&versionB=2 */
  compareVersions: (quoteId: string, versionA: number, versionB: number) => {
    const query = new URLSearchParams({
      versionA: String(versionA),
      versionB: String(versionB),
    });
    return api.get<ApiResponse<QuoteRevisionComparisonResult>>(
      `/api/quotes/${quoteId}/compare?${query.toString()}`,
    );
  },
};
