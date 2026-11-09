/**
 * context/AuthContext.tsx
 *
 * React Context for authentication state.
 * Provides: user, isLoading, login(), logout()
 * On mount: calls /api/auth/me to restore session from httpOnly cookie.
 */

import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { authApi } from '../api';
import { AUTH_EXPIRED_EVENT } from '../api/client';
import { User } from '../types';

interface AuthContextValue {
  user: User | null;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Restore session on first render: verify session with backend /api/auth/me
  useEffect(() => {
    let isMounted = true;
    authApi
      .me()
      .then((res) => {
        if (isMounted) setUser(res.data.user);
      })
      .catch(() => {
        if (isMounted) {
          localStorage.removeItem('rfq_auth_token');
          setUser(null);
        }
      })
      .finally(() => {
        if (isMounted) setIsLoading(false);
      });

    return () => {
      isMounted = false;
    };
  }, []);

  // Clear authentication state if an API request returns 401
  useEffect(() => {
    const handleAuthExpired = () => {
      setUser(null);
    };
    window.addEventListener(AUTH_EXPIRED_EVENT, handleAuthExpired);
    return () => {
      window.removeEventListener(AUTH_EXPIRED_EVENT, handleAuthExpired);
    };
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const res = await authApi.login(email, password);
    const token = (res.data as { token?: string }).token;
    if (token) {
      localStorage.setItem('rfq_auth_token', token);
    }

    try {
      // Confirm the authenticated session with the backend before displaying protected dashboard
      const meRes = await authApi.me();
      setUser(meRes.data.user);
    } catch (verifyErr) {
      localStorage.removeItem('rfq_auth_token');
      setUser(null);
      throw new Error(
        verifyErr instanceof Error
          ? verifyErr.message
          : 'Session verification failed. Please try logging in again.'
      );
    }
  }, []);

  const logout = useCallback(async () => {
    try {
      await authApi.logout();
    } catch {
      // Clear local session even if network call encounters an issue
    } finally {
      localStorage.removeItem('rfq_auth_token');
      setUser(null);
    }
  }, []);

  return (
    <AuthContext.Provider value={{ user, isLoading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

