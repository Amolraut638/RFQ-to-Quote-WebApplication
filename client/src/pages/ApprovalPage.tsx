/**
 * pages/ApprovalPage.tsx
 *
 * Sales Head approval dashboard.
 * Shows all quotes currently in PENDING_APPROVAL status.
 * Backend enforces SALES_HEAD authorization; this page also gates access client-side.
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertCircle, ArrowRight, CheckCircle, ClipboardCheck } from 'lucide-react';
import { approvalApi } from '../api';
import { PendingApproval, PopulatedRFQRef, PopulatedUserRef } from '../types';
import { Button } from '../components/ui/Button';
import { useAuth } from '../context/AuthContext';

// ─── Formatting helpers ───────────────────────────────────────────────────────

function formatDate(iso: string | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

function formatInr(str: string): string {
  const n = parseFloat(str);
  if (isNaN(n)) return str;
  return n.toLocaleString('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function getRfqNo(rfqId: PendingApproval['rfqId']): string {
  if (typeof rfqId === 'string') return rfqId;
  return (rfqId as PopulatedRFQRef).rfqNo ?? '—';
}

function getCustomer(rfqId: PendingApproval['rfqId']): string {
  if (typeof rfqId === 'string') return '—';
  return (rfqId as PopulatedRFQRef).customer ?? '—';
}

function getEstimatorName(createdBy: PendingApproval['createdBy']): string {
  if (typeof createdBy === 'string') return createdBy;
  return (createdBy as PopulatedUserRef).name ?? '—';
}

// ─── Component ────────────────────────────────────────────────────────────────

export function ApprovalPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [pending, setPending] = useState<PendingApproval[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (user?.role !== 'SALES_HEAD') return;
    approvalApi
      .getPending()
      .then((res) => setPending(res.data.data))
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, [user?.role]);

  if (user?.role !== 'SALES_HEAD') {
    return (
      <div className="p-4 rounded bg-red-50 border border-red-200 text-sm text-red-700 flex items-center gap-2">
        <AlertCircle className="w-4 h-4 shrink-0" strokeWidth={1.8} />
        <span>Access denied. Sales Head only.</span>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div>
        <div className="flex items-center gap-2">
          <ClipboardCheck className="w-5 h-5 text-brand-600 shrink-0" strokeWidth={1.8} />
          <h1 className="text-lg font-semibold text-gray-900">Approval Queue</h1>
        </div>
        <p className="mt-1 text-sm text-gray-500">
          Quotes requiring Sales Head approval (annual value &gt; ₹25,00,000)
        </p>
      </div>

      {/* Summary card */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-white border border-yellow-200 rounded-lg p-4">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
            Pending Approvals
          </p>
          <p className="mt-1 text-3xl font-bold tabular text-yellow-600">
            {loading ? '…' : pending.length}
          </p>
        </div>
      </div>

      {/* Pending approvals table */}
      <div>
        <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-3">
          Pending Approvals
        </h2>

        {loading ? (
          <div className="text-sm text-gray-400 py-4">Loading…</div>
        ) : error ? (
          <div className="p-4 rounded bg-red-50 border border-red-200 text-sm text-red-700 flex items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0" strokeWidth={1.8} />
            <span>{error}</span>
          </div>
        ) : pending.length === 0 ? (
          <div className="bg-white border border-gray-200 rounded-lg py-12 text-center text-sm text-gray-400">
            <CheckCircle className="w-6 h-6 text-gray-300 mx-auto mb-2" strokeWidth={1.8} />
            <p>No quotes pending approval.</p>
          </div>
        ) : (
          <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
            <table className="data-table">
              <thead>
                <tr>
                  <th>RFQ No.</th>
                  <th>Customer</th>
                  <th>Version</th>
                  <th className="text-right">Annual Value</th>
                  <th>Submitted</th>
                  <th>Estimator</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {pending.map((q) => (
                  <tr key={q._id}>
                    <td className="font-mono font-semibold text-gray-900">
                      {getRfqNo(q.rfqId)}
                    </td>
                    <td className="text-gray-700">{getCustomer(q.rfqId)}</td>
                    <td className="font-mono text-gray-700">v{q.version}</td>
                    <td className="tabular text-right text-gray-900 font-medium">
                      {formatInr(q.annualQuotationValue)}
                    </td>
                    <td className="tabular text-sm text-gray-500">
                      {formatDate(q.submittedAt)}
                    </td>
                    <td className="text-sm text-gray-700">
                      {getEstimatorName(q.createdBy)}
                    </td>
                    <td className="text-right">
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => navigate(`/approvals/${q._id}`)}
                      >
                        <span>Review</span>
                        <ArrowRight className="w-3.5 h-3.5 shrink-0" strokeWidth={1.8} />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
