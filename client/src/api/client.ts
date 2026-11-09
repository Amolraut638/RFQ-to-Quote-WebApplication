/**
 * api/client.ts
 *
 * Axios instance configured for this application.
 * - baseURL from Vite env (falls back to proxy path in dev)
 * - withCredentials: true — required for httpOnly cookie auth
 * - Consistent error normalisation
 */

import axios from 'axios';

export const AUTH_EXPIRED_EVENT = 'rfq:auth_expired';

const api = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL ?? '',
  withCredentials: true,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Attach Authorization Bearer token header if stored (fallback when cross-site cookies are restricted)
api.interceptors.request.use((reqConfig) => {
  if (typeof window !== 'undefined') {
    const token = localStorage.getItem('rfq_auth_token');
    if (token && reqConfig.headers) {
      reqConfig.headers.Authorization = `Bearer ${token}`;
    }
  }
  return reqConfig;
});

// Normalise error messages so components get a string, not an AxiosError
api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      if (typeof window !== 'undefined') {
        localStorage.removeItem('rfq_auth_token');
        window.dispatchEvent(new CustomEvent(AUTH_EXPIRED_EVENT));
      }
    }
    const message: string =
      error.response?.data?.error ??
      error.message ??
      'An unexpected error occurred';
    return Promise.reject(new Error(message));
  }
);

export default api;

