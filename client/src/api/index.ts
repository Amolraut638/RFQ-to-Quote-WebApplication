import api from './client';
import {
  User,
  RFQ,
  Part,
  ApiResponse,
  CostingContext,
  CostingPreviewResult,
  RoutingOperationInput,
  QuoteSummary,
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
};
