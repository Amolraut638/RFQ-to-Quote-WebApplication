/**
 * components/AppLayout.tsx
 *
 * Protected shell: renders nav + main content area.
 * Redirects to /login if the user is not authenticated.
 */

import { Navigate, Outlet, Link, useLocation } from 'react-router-dom';
import { Calculator, ClipboardCheck, FileText, Sparkles, User } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { Button } from './ui/Button';
import { Badge } from './ui/Badge';

function roleBadgeVariant(role: string) {
  return role === 'SALES_HEAD' ? 'blue' : 'green';
}

function roleLabel(role: string) {
  return role === 'SALES_HEAD' ? 'Sales Head' : 'Estimator';
}

export function AppLayout() {
  const { user, isLoading, logout } = useAuth();
  const location = useLocation();

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-sm text-gray-400">Loading…</p>
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  async function handleLogout() {
    await logout();
  }

  const navLinks = [
    { to: '/rfqs', label: 'RFQ Register', Icon: FileText },
    ...(user.role === 'ESTIMATOR' ? [{ to: '/intake', label: 'AI Intake', Icon: Sparkles }] : []),
    ...(user.role === 'SALES_HEAD'
      ? [{ to: '/approval', label: 'Approvals', Icon: ClipboardCheck }]
      : []),
  ];

  return (
    <div className="min-h-screen flex flex-col bg-gray-50">
      {/* Top navigation */}
      <header className="bg-white border-b border-gray-200 sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-14">
            {/* Brand */}
            <div className="flex items-center gap-6">
              <span className="inline-flex items-center gap-2 font-semibold text-gray-900 text-sm">
                <Calculator className="w-4 h-4 text-brand-600 shrink-0" strokeWidth={1.8} />
                <span>RFQ-to-Quote</span>
              </span>
              <nav className="hidden sm:flex items-center gap-1">
                {navLinks.map(({ to, label, Icon }) => (
                  <Link
                    key={to}
                    to={to}
                    className={[
                      'inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-sm font-medium transition-colors',
                      location.pathname.startsWith(to)
                        ? 'bg-brand-50 text-brand-700'
                        : 'text-gray-600 hover:text-gray-900 hover:bg-gray-100',
                    ].join(' ')}
                  >
                    <Icon className="w-4 h-4 shrink-0" strokeWidth={1.8} />
                    <span>{label}</span>
                  </Link>
                ))}
              </nav>
            </div>

            {/* User info + logout */}
            <div className="flex items-center gap-3">
              <div className="hidden sm:flex items-center gap-2">
                <User className="w-4 h-4 text-gray-400 shrink-0" strokeWidth={1.8} />
                <span className="text-sm text-gray-700">{user.name}</span>
                <Badge variant={roleBadgeVariant(user.role)}>{roleLabel(user.role)}</Badge>
              </div>
              <Button variant="ghost" size="sm" onClick={handleLogout}>
                Sign out
              </Button>
            </div>
          </div>
        </div>
      </header>

      {/* Page content */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <Outlet />
      </main>
    </div>
  );
}

