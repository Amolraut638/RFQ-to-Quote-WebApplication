import api from './client';
import { User, RFQ, ApiResponse } from '../types';

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
    api.get<ApiResponse<RFQ>>(`/api/rfqs/${id}`),
};

