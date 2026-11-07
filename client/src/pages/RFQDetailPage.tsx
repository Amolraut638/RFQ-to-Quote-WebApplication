import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { rfqApi, costingApi } from '../api';
import { Part, QuoteSummary, QuoteStatus, RFQ, RFQStatus } from '../types';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { useAuth } from '../context/AuthContext';

// ─── Formatting helpers ───────────────────────────────────────────────────────

function formatDate(iso: string): string {
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

// ─── Status helpers ───────────────────────────────────────────────────────────

function rfqStatusVariant(status: RFQStatus): 'blue' | 'yellow' | 'green' | 'gray' | 'red' {
  switch (status) {
    case 'ESTIMATING':       return 'blue';
    case 'PENDING_APPROVAL': return 'yellow';
    case 'SENT':             return 'green';
    case 'WON':              return 'green';
    case 'LOST':             return 'gray';
  }
}

function rfqStatusLabel(status: RFQStatus): string {
  switch (status) {
    case 'ESTIMATING':       return 'Estimating';
    case 'PENDING_APPROVAL': return 'Pending Approval';
    case 'SENT':             return 'Sent';
    case 'WON':              return 'Won';
    case 'LOST':             return 'Lost';
  }
}

function quoteStatusVariant(
  status: QuoteStatus,
): 'default' | 'blue' | 'green' | 'yellow' | 'red' | 'gray' {
  switch (status) {
    case 'DRAFT':            return 'gray';
    case 'PENDING_APPROVAL': return 'yellow';
    case 'APPROVED':         return 'green';
    case 'REJECTED':         return 'red';
    case 'READY_FOR_SALES':  return 'blue';
    case 'SENT':             return 'blue';
  }
}

function quoteStatusLabel(status: QuoteStatus): string {
  switch (status) {
    case 'DRAFT':            return 'Draft';
    case 'PENDING_APPROVAL': return 'Pending Approval';
    case 'APPROVED':         return 'Approved';
    case 'REJECTED':         return 'Rejected';
    case 'READY_FOR_SALES':  return 'Ready for Sales';
    case 'SENT':             return 'Sent';
  }
}

function ownerName(ownerId: RFQ['ownerId']): string {
  if (typeof ownerId === 'string') return ownerId;
  return ownerId.name ?? '—';
}

// ─── Component ────────────────────────────────────────────────────────────────

export function RFQDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();

  const [rfq, setRfq] = useState<(RFQ & { parts: Part[] }) | null>(null);
  const [quotes, setQuotes] = useState<QuoteSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [quotesLoading, setQuotesLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!id) return;

    rfqApi
      .get(id)
      .then((res) => setRfq(res.data.data))
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));

    costingApi
      .listQuotes(id)
      .then((res) => setQuotes(res.data.data))
      .catch(() => setQuotes([]))
      .finally(() => setQuotesLoading(false));
  }, [id]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-sm text-gray-400">
        Loading RFQ…
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4 rounded bg-red-50 border border-red-200 text-sm text-red-700">
        Failed to load RFQ: {error}
      </div>
    );
  }

  if (!rfq) {
    return (
      <div className="text-center py-20 text-sm text-gray-400">RFQ not found.</div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Breadcrumb */}
      <Link to="/rfqs" className="text-sm text-brand-600 hover:underline">
        ← RFQ Register
      </Link>

      {/* RFQ Header Card */}
      <div className="bg-white border border-gray-200 rounded-lg p-6">
        <div className="flex items-start justify-between">
          <div>
            <div className="flex items-center gap-3 mb-1">
              <span className="font-mono text-lg font-semibold text-gray-900">{rfq.rfqNo}</span>
              <Badge variant={rfqStatusVariant(rfq.status)}>{rfqStatusLabel(rfq.status)}</Badge>
              {rfq.isOverdue && (
                <Badge variant="red">Overdue</Badge>
              )}
            </div>
            <p className="text-gray-700 text-base">{rfq.customer}</p>
          </div>
        </div>

        <dl className="mt-4 grid grid-cols-2 sm:grid-cols-3 gap-4 text-sm">
          <div>
            <dt className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Due Date</dt>
            <dd className={`mt-1 tabular ${rfq.isOverdue ? 'text-red-600 font-medium' : 'text-gray-900'}`}>
              {formatDate(rfq.dueDate)}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Received</dt>
            <dd className="mt-1 tabular text-gray-900">{formatDate(rfq.receivedDate)}</dd>
          </div>
          <div>
            <dt className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Assigned To</dt>
            <dd className="mt-1 text-gray-900">{ownerName(rfq.ownerId)}</dd>
          </div>
        </dl>
      </div>

      {/* Parts List */}
      <div>
        <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-3">
          Parts ({rfq.parts?.length ?? 0})
        </h2>

        {!rfq.parts || rfq.parts.length === 0 ? (
          <div className="bg-white border border-gray-200 rounded-lg py-10 text-center text-sm text-gray-400">
            No parts found for this RFQ.
          </div>
        ) : (
          <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Part Name</th>
                  <th>Material</th>
                  <th className="text-right">Gross Weight (kg)</th>
                  <th className="text-right">Annual Volume (pcs)</th>
                  {user?.role === 'ESTIMATOR' && <th></th>}
                </tr>
              </thead>
              <tbody>
                {rfq.parts.map((part) => (
                  <tr key={part._id}>
                    <td className="font-medium text-gray-900">{part.partName}</td>
                    <td className="text-gray-700">{part.material}</td>
                    <td className="tabular text-right text-gray-700">
                      {part.grossWeightKg.toFixed(3)}
                    </td>
                    <td className="tabular text-right text-gray-700">
                      {part.annualVolume.toLocaleString('en-IN')}
                    </td>
                    {user?.role === 'ESTIMATOR' && (
                      <td className="text-right">
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() =>
                            navigate(`/rfqs/${id}/parts/${part._id}/costing`)
                          }
                        >
                          Cost This Part →
                        </Button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Quote History */}
      <div>
        <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-3">
          Quote History
        </h2>

        {quotesLoading ? (
          <div className="text-sm text-gray-400 py-4">Loading quotes…</div>
        ) : quotes.length === 0 ? (
          <div className="bg-white border border-gray-200 rounded-lg py-10 text-center text-sm text-gray-400">
            No quotes yet.
            {user?.role === 'ESTIMATOR' && rfq.parts?.length > 0 && (
              <span> Select a part above to begin costing.</span>
            )}
          </div>
        ) : (
          <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Version</th>
                  <th>Status</th>
                  <th className="text-right">Annual Value (Ex-GST)</th>
                  <th>Costing Date</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {quotes.map((q) => (
                  <tr key={q._id}>
                    <td className="font-mono font-semibold text-gray-900">v{q.version}</td>
                    <td>
                      <Badge variant={quoteStatusVariant(q.status)}>
                        {quoteStatusLabel(q.status)}
                      </Badge>
                    </td>
                    <td className="tabular text-right text-gray-900 font-medium">
                      {formatInr(q.annualQuotationValue)}
                    </td>
                    <td className="tabular text-sm text-gray-600">
                      {formatDate(q.costingDate)}
                    </td>
                    <td className="tabular text-sm text-gray-500">
                      {formatDate(q.createdAt)}
                    </td>
                    <td className="text-right">
                      {user?.role === 'SALES_HEAD' &&
                        ['PENDING_APPROVAL', 'APPROVED', 'READY_FOR_SALES', 'SENT'].includes(q.status) && (
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => navigate(`/approvals/${q._id}`)}
                        >
                          Review →
                        </Button>
                      )}
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
