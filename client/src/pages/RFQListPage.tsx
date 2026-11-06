import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { rfqApi } from '../api';
import { RFQ, RFQStatus } from '../types';
import { Badge } from '../components/ui/Badge';

// Map RFQ status to badge variant
function statusVariant(status: RFQStatus): 'blue' | 'yellow' | 'green' | 'gray' | 'red' {
  switch (status) {
    case 'ESTIMATING':     return 'blue';
    case 'PENDING_APPROVAL': return 'yellow';
    case 'SENT':           return 'green';
    case 'WON':            return 'green';
    case 'LOST':           return 'gray';
  }
}

function statusLabel(status: RFQStatus): string {
  switch (status) {
    case 'ESTIMATING':       return 'Estimating';
    case 'PENDING_APPROVAL': return 'Pending Approval';
    case 'SENT':             return 'Sent';
    case 'WON':              return 'Won';
    case 'LOST':             return 'Lost';
  }
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

function ownerName(ownerId: RFQ['ownerId']): string {
  if (typeof ownerId === 'string') return ownerId;
  return ownerId.name ?? '—';
}

export function RFQListPage() {
  const [rfqs, setRfqs] = useState<RFQ[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    rfqApi
      .list()
      .then((res) => setRfqs(res.data.data))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div>
      {/* Page header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-lg font-semibold text-gray-900">RFQ Register</h1>
          <p className="mt-0.5 text-sm text-gray-500">
            All open and active requests for quotation
          </p>
        </div>
      </div>

      {/* Loading state */}
      {loading && (
        <div className="flex items-center justify-center py-20 text-sm text-gray-400">
          Loading RFQs…
        </div>
      )}

      {/* Error state */}
      {!loading && error && (
        <div className="p-4 rounded bg-red-50 border border-red-200 text-sm text-red-700">
          Failed to load RFQs: {error}
        </div>
      )}

      {/* Empty state */}
      {!loading && !error && rfqs.length === 0 && (
        <div className="text-center py-20 text-sm text-gray-400">
          No RFQs found. Create one to get started.
        </div>
      )}

      {/* RFQ table */}
      {!loading && !error && rfqs.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
          <table className="data-table">
            <thead>
              <tr>
                <th>RFQ No.</th>
                <th>Customer</th>
                <th>Part</th>
                <th>Due Date</th>
                <th>Assigned To</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rfqs.map((rfq) => (
                <tr key={rfq._id} className={rfq.isOverdue ? 'bg-red-50' : ''}>
                  <td className="font-mono text-xs font-medium text-gray-900">
                    {rfq.rfqNo}
                  </td>
                  <td className="text-gray-900">{rfq.customer}</td>
                  <td className="text-gray-700">{rfq.partName ?? '—'}</td>
                  <td className="tabular text-sm">
                    <span className={rfq.isOverdue ? 'text-red-600 font-medium' : 'text-gray-700'}>
                      {formatDate(rfq.dueDate)}
                    </span>
                    {rfq.isOverdue && (
                      <span className="ml-2 text-xs text-red-500">Overdue</span>
                    )}
                  </td>
                  <td className="text-sm text-gray-600">{ownerName(rfq.ownerId)}</td>
                  <td>
                    <Badge variant={statusVariant(rfq.status)}>
                      {statusLabel(rfq.status)}
                    </Badge>
                  </td>
                  <td>
                    <Link
                      to={`/rfqs/${rfq._id}`}
                      className="text-xs text-brand-600 hover:text-brand-700 font-medium"
                    >
                      View →
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

