/**
 * api/client.ts
 *
 * Axios instance configured for this application.
 * - baseURL from Vite env (falls back to proxy path in dev)
 * - withCredentials: true — required for httpOnly cookie auth
 * - Consistent error normalisation
 */

import axios from 'axios';

const api = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL ?? '',
  withCredentials: true,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Normalise error messages so components get a string, not an AxiosError
api.interceptors.response.use(
  (response) => response,
  (error) => {
    const message: string =
      error.response?.data?.error ??
      error.message ??
      'An unexpected error occurred';
    return Promise.reject(new Error(message));
  }
);

export default api;

