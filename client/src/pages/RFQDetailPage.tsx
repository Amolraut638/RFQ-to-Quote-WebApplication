import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { rfqApi, costingApi, quoteApi } from '../api';
import {
  Part,
  QuoteSummary,
  QuoteStatus,
  RFQ,
  RFQStatus,
  QuoteRevisionComparisonResult,
  RevisionComparisonRow,
  RoutingOperationDiff,
  VolumeTierRevisionComparison,
  RevisionMetadata,
  RevisionUserSummary,
} from '../types';
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

function userDisplay(u: RevisionUserSummary | string | null | undefined): string {
  if (!u) return '—';
  if (typeof u === 'string') return u;
  return u.name ? `${u.name} (${u.email})` : u.email ?? u._id;
}

function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatUnitValue(val: string, unit: RevisionComparisonRow['unit']): string {
  const n = parseFloat(val);
  if (isNaN(n)) return val;
  if (unit === 'PCS') return `${Math.round(n).toLocaleString('en-IN')} pcs`;
  if (unit === 'KG') return `${n.toFixed(3)} kg`;
  if (unit === 'PCT') return `${n.toFixed(2)}%`;
  const formatted = n.toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return unit === 'INR_PER_KG' ? `₹${formatted}/kg` : `₹${formatted}`;
}

function formatUnitDelta(val: string, unit: RevisionComparisonRow['unit']): string {
  const n = parseFloat(val);
  if (isNaN(n)) return val;
  const sign = n > 0 ? '+' : n < 0 ? '-' : '';
  const absVal = Math.abs(n);
  if (unit === 'PCS') return `${sign}${Math.round(absVal).toLocaleString('en-IN')} pcs`;
  if (unit === 'KG') return `${sign}${absVal.toFixed(3)} kg`;
  if (unit === 'PCT') return `${sign}${absVal.toFixed(2)}%`;
  const formatted = absVal.toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return unit === 'INR_PER_KG' ? `${sign}₹${formatted}/kg` : `${sign}₹${formatted}`;
}

function directionColorClass(direction: 'INCREASED' | 'DECREASED' | 'UNCHANGED'): string {
  if (direction === 'INCREASED') return 'text-amber-700';
  if (direction === 'DECREASED') return 'text-emerald-700';
  return 'text-gray-400';
}

function directionBadge(direction: 'INCREASED' | 'DECREASED' | 'UNCHANGED') {
  if (direction === 'INCREASED') return <Badge variant="yellow">▲ Increased</Badge>;
  if (direction === 'DECREASED') return <Badge variant="green">▼ Decreased</Badge>;
  return <Badge variant="gray">Unchanged</Badge>;
}

function VersionMetadataCard({ label, meta }: { label: string; meta: RevisionMetadata }) {
  return (
    <div className="bg-white border border-gray-200 rounded-lg p-4 space-y-2.5 text-xs">
      <div className="flex items-center justify-between border-b border-gray-100 pb-2">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold uppercase tracking-wider text-gray-500">
            {label}
          </span>
          <span className="font-mono text-sm font-bold text-gray-900">v{meta.version}</span>
        </div>
        <Badge variant={quoteStatusVariant(meta.status)}>{quoteStatusLabel(meta.status)}</Badge>
      </div>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5">
        <div>
          <dt className="text-gray-500">Created By</dt>
          <dd className="font-medium text-gray-900 truncate" title={userDisplay(meta.createdBy)}>
            {userDisplay(meta.createdBy)}
          </dd>
        </div>
        <div>
          <dt className="text-gray-500">Created At</dt>
          <dd className="tabular text-gray-800">{formatDateTime(meta.createdAt)}</dd>
        </div>
        <div>
          <dt className="text-gray-500">Costing Date</dt>
          <dd className="tabular text-gray-800">{formatDate(meta.costingDate)}</dd>
        </div>
        {meta.submittedAt && (
          <div>
            <dt className="text-gray-500">Submitted</dt>
            <dd className="tabular text-gray-800">{formatDateTime(meta.submittedAt)}</dd>
          </div>
        )}
        {meta.approvedAt && (
          <div className="col-span-2">
            <dt className="text-gray-500">Approved By</dt>
            <dd className="text-emerald-700 font-medium">
              {userDisplay(meta.approvedBy)} on {formatDateTime(meta.approvedAt)}
            </dd>
          </div>
        )}
        {meta.rejectedAt && (
          <div className="col-span-2">
            <dt className="text-gray-500">Rejected By</dt>
            <dd className="text-red-700 font-medium">
              {userDisplay(meta.rejectedBy)} on {formatDateTime(meta.rejectedAt)}
              {meta.rejectionComment ? ` — "${meta.rejectionComment}"` : ''}
            </dd>
          </div>
        )}
        {meta.sentAt && (
          <div className="col-span-2">
            <dt className="text-gray-500">Sent to Customer</dt>
            <dd className="text-brand-700 font-medium">
              {userDisplay(meta.sentBy)} on {formatDateTime(meta.sentAt)}
            </dd>
          </div>
        )}
      </dl>
    </div>
  );
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

  // Quote Revision Comparison state
  const [showComparePanel, setShowComparePanel] = useState(false);
  const [versionA, setVersionA] = useState<number>(1);
  const [versionB, setVersionB] = useState<number>(2);
  const [revisionComparison, setRevisionComparison] =
    useState<QuoteRevisionComparisonResult | null>(null);
  const [compareLoading, setCompareLoading] = useState(false);
  const [compareError, setCompareError] = useState('');

  useEffect(() => {
    if (!id) return;

    rfqApi
      .get(id)
      .then((res) => setRfq(res.data.data))
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));

    costingApi
      .listQuotes(id)
      .then((res) => {
        const list = res.data.data;
        setQuotes(list);
        if (list.length >= 2) {
          const sorted = [...list].sort((a, b) => a.version - b.version);
          setVersionA(sorted[sorted.length - 2].version);
          setVersionB(sorted[sorted.length - 1].version);
        }
      })
      .catch(() => setQuotes([]))
      .finally(() => setQuotesLoading(false));
  }, [id]);

  async function runRevisionCompare(vA = versionA, vB = versionB) {
    if (quotes.length === 0) return;
    if (vA === vB) {
      setCompareError('Please select two distinct versions to compare.');
      return;
    }
    const anchorQuoteId = quotes[quotes.length - 1]._id;
    setCompareLoading(true);
    setCompareError('');
    try {
      const res = await quoteApi.compareVersions(anchorQuoteId, vA, vB);
      setRevisionComparison(res.data.data);
    } catch (err: unknown) {
      setCompareError(err instanceof Error ? err.message : 'Revision comparison failed');
    } finally {
      setCompareLoading(false);
    }
  }

  function handleOpenCompare(vA?: number, vB?: number) {
    const sorted = [...quotes].sort((a, b) => a.version - b.version);
    const nextA = vA ?? (sorted.length >= 2 ? sorted[sorted.length - 2].version : 1);
    const nextB = vB ?? (sorted.length >= 2 ? sorted[sorted.length - 1].version : 2);
    setVersionA(nextA);
    setVersionB(nextB);
    setShowComparePanel(true);
    void runRevisionCompare(nextA, nextB);
  }

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
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wider">
              Quote History ({quotes.length})
            </h2>
            {quotes.length === 1 && (
              <span className="text-xs text-gray-400">
                (Create a revision to enable version comparison)
              </span>
            )}
          </div>
          {quotes.length >= 2 && (
            <Button
              variant={showComparePanel ? 'primary' : 'secondary'}
              size="sm"
              onClick={() => {
                if (showComparePanel) {
                  setShowComparePanel(false);
                } else {
                  handleOpenCompare();
                }
              }}
            >
              {showComparePanel ? 'Hide Version Comparison' : 'Compare Versions'}
            </Button>
          )}
        </div>

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
                  <th className="text-right">Actions</th>
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
                      <div className="inline-flex items-center gap-2 justify-end">
                        {quotes.length >= 2 && q.version > 1 && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleOpenCompare(q.version - 1, q.version)}
                          >
                            Compare v{q.version - 1} → v{q.version}
                          </Button>
                        )}
                        {user?.role === 'SALES_HEAD' &&
                          ['PENDING_APPROVAL', 'APPROVED', 'READY_FOR_SALES', 'SENT'].includes(
                            q.status,
                          ) && (
                            <Button
                              variant="secondary"
                              size="sm"
                              onClick={() => navigate(`/approvals/${q._id}`)}
                            >
                              Review →
                            </Button>
                          )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Quote Revision Comparison Panel (Read-Only) */}
        {showComparePanel && quotes.length >= 2 && (
          <section className="bg-gray-50/70 border border-gray-200 rounded-lg p-5 space-y-6">
            {/* Selector Header */}
            <div className="flex flex-wrap items-center justify-between gap-4 border-b border-gray-200 pb-4">
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-semibold text-gray-900">
                    Quote Revision Comparison
                  </h3>
                  <Badge variant="gray">Immutable Snapshot Diff</Badge>
                </div>
                <p className="text-xs text-gray-500 mt-0.5">
                  Side-by-side comparison of frozen rate, routing, and costing snapshots across
                  quote revisions.
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2 text-sm">
                <label className="text-xs font-medium text-gray-600">Base Version (A):</label>
                <select
                  value={versionA}
                  onChange={(e) => setVersionA(Number(e.target.value))}
                  className="rounded border border-gray-300 bg-white px-2.5 py-1.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-brand-500"
                >
                  {quotes.map((q) => (
                    <option key={q._id} value={q.version}>
                      v{q.version} ({quoteStatusLabel(q.status)})
                    </option>
                  ))}
                </select>

                <span className="text-gray-400 font-semibold">→</span>

                <label className="text-xs font-medium text-gray-600">Revised Version (B):</label>
                <select
                  value={versionB}
                  onChange={(e) => setVersionB(Number(e.target.value))}
                  className="rounded border border-gray-300 bg-white px-2.5 py-1.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-brand-500"
                >
                  {quotes.map((q) => (
                    <option key={q._id} value={q.version}>
                      v{q.version} ({quoteStatusLabel(q.status)})
                    </option>
                  ))}
                </select>

                <Button
                  variant="primary"
                  size="sm"
                  loading={compareLoading}
                  onClick={() => runRevisionCompare(versionA, versionB)}
                >
                  Compare
                </Button>
              </div>
            </div>

            {compareLoading && (
              <div className="py-8 text-center text-xs text-gray-500">
                Loading frozen revision snapshots for v{versionA} and v{versionB}…
              </div>
            )}

            {!compareLoading && compareError && (
              <div className="p-3 rounded bg-red-50 border border-red-200 text-xs text-red-700">
                {compareError}
              </div>
            )}

            {!compareLoading && !compareError && revisionComparison && (
              <div className="space-y-6">
                {/* Part & Material Header */}
                <div className="flex flex-wrap items-center justify-between gap-2 bg-white border border-gray-200 rounded-lg px-4 py-3 text-xs">
                  <div className="flex flex-wrap items-center gap-4">
                    <div>
                      <span className="text-gray-500">Part:</span>{' '}
                      <strong className="text-gray-900">{revisionComparison.part.partName}</strong>
                      {revisionComparison.part.drawingNumber && (
                        <span className="ml-1.5 font-mono text-gray-500">
                          ({revisionComparison.part.drawingNumber})
                        </span>
                      )}
                    </div>
                    <div>
                      <span className="text-gray-500">Material:</span>{' '}
                      {revisionComparison.part.materialChanged ? (
                        <span className="font-semibold text-amber-700">
                          {revisionComparison.part.materialA} → {revisionComparison.part.materialB}
                        </span>
                      ) : (
                        <strong className="text-gray-900">
                          {revisionComparison.part.materialB}
                        </strong>
                      )}
                    </div>
                  </div>
                  <div className="text-gray-400">
                    Deltas shown as <span className="font-mono">v{revisionComparison.versionB.version} − v{revisionComparison.versionA.version}</span>
                  </div>
                </div>

                {/* Version Metadata Cards */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <VersionMetadataCard
                    label="Base Version (A)"
                    meta={revisionComparison.versionA}
                  />
                  <VersionMetadataCard
                    label="Revised Version (B)"
                    meta={revisionComparison.versionB}
                  />
                </div>

                {/* Executive Summary KPI Strip */}
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <div className="bg-white border border-gray-200 rounded-lg p-4 space-y-1">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
                        Selling Price / pc (Ex-GST)
                      </span>
                      {directionBadge(revisionComparison.summary.sellingPriceExGst.direction)}
                    </div>
                    <div className="text-base font-bold tabular text-gray-900">
                      ₹{revisionComparison.summary.sellingPriceExGst.valueA} → ₹
                      {revisionComparison.summary.sellingPriceExGst.valueB}
                    </div>
                    <div
                      className={`text-xs font-mono tabular ${directionColorClass(
                        revisionComparison.summary.sellingPriceExGst.direction,
                      )}`}
                    >
                      {formatUnitDelta(
                        revisionComparison.summary.sellingPriceExGst.absoluteDifference,
                        'INR_PER_PC',
                      )}{' '}
                      (
                      {revisionComparison.summary.sellingPriceExGst.percentageDifference !== null
                        ? `${
                            parseFloat(
                              revisionComparison.summary.sellingPriceExGst.percentageDifference,
                            ) > 0
                              ? '+'
                              : ''
                          }${revisionComparison.summary.sellingPriceExGst.percentageDifference}%`
                        : 'N/A'}
                      )
                    </div>
                  </div>

                  <div className="bg-white border border-gray-200 rounded-lg p-4 space-y-1">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
                        Total Cost / pc (100% Tier)
                      </span>
                      {directionBadge(revisionComparison.summary.totalCostPerPiece.direction)}
                    </div>
                    <div className="text-base font-bold tabular text-gray-900">
                      ₹{revisionComparison.summary.totalCostPerPiece.valueA} → ₹
                      {revisionComparison.summary.totalCostPerPiece.valueB}
                    </div>
                    <div
                      className={`text-xs font-mono tabular ${directionColorClass(
                        revisionComparison.summary.totalCostPerPiece.direction,
                      )}`}
                    >
                      {formatUnitDelta(
                        revisionComparison.summary.totalCostPerPiece.absoluteDifference,
                        'INR_PER_PC',
                      )}{' '}
                      (
                      {revisionComparison.summary.totalCostPerPiece.percentageDifference !== null
                        ? `${
                            parseFloat(
                              revisionComparison.summary.totalCostPerPiece.percentageDifference,
                            ) > 0
                              ? '+'
                              : ''
                          }${revisionComparison.summary.totalCostPerPiece.percentageDifference}%`
                        : 'N/A'}
                      )
                    </div>
                  </div>

                  <div className="bg-white border border-gray-200 rounded-lg p-4 space-y-1">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
                        Annual Quote Value (Ex-GST)
                      </span>
                      {directionBadge(revisionComparison.summary.annualQuoteValue.direction)}
                    </div>
                    <div className="text-base font-bold tabular text-gray-900">
                      {formatInr(revisionComparison.summary.annualQuoteValue.valueA)} →{' '}
                      {formatInr(revisionComparison.summary.annualQuoteValue.valueB)}
                    </div>
                    <div
                      className={`text-xs font-mono tabular ${directionColorClass(
                        revisionComparison.summary.annualQuoteValue.direction,
                      )}`}
                    >
                      {formatUnitDelta(
                        revisionComparison.summary.annualQuoteValue.absoluteDifference,
                        'INR',
                      )}{' '}
                      (
                      {revisionComparison.summary.annualQuoteValue.percentageDifference !== null
                        ? `${
                            parseFloat(
                              revisionComparison.summary.annualQuoteValue.percentageDifference,
                            ) > 0
                              ? '+'
                              : ''
                          }${revisionComparison.summary.annualQuoteValue.percentageDifference}%`
                        : 'N/A'}
                      )
                    </div>
                  </div>
                </div>

                {/* Cost Component & Rate Comparison Table (Ex-GST) */}
                <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
                  <div className="px-4 py-3 border-b border-gray-100">
                    <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
                      Rates, Specifications &amp; Cost Breakdown Comparison (Base 100% Tier)
                    </h4>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>Parameter</th>
                          <th className="text-right">v{revisionComparison.versionA.version}</th>
                          <th className="text-right">v{revisionComparison.versionB.version}</th>
                          <th className="text-right">Absolute Diff</th>
                          <th className="text-right">% Diff</th>
                          <th>Change</th>
                        </tr>
                      </thead>
                      <tbody>
                        {revisionComparison.parameterRows.map((row: RevisionComparisonRow) => {
                          const isHighlight =
                            row.key === 'totalCostPerPiece' ||
                            row.key === 'sellingPriceExGst' ||
                            row.key === 'annualQuoteValue';
                          return (
                            <tr
                              key={row.key}
                              className={isHighlight ? 'bg-brand-50/40 font-semibold' : undefined}
                            >
                              <td>
                                <span className="text-gray-900">{row.label}</span>
                                {row.note && (
                                  <span className="ml-2 text-xs text-gray-500 font-normal">
                                    ({row.note})
                                  </span>
                                )}
                              </td>
                              <td className="text-right tabular text-gray-700">
                                {formatUnitValue(row.versionAValue, row.unit)}
                              </td>
                              <td className="text-right tabular text-gray-900">
                                {formatUnitValue(row.versionBValue, row.unit)}
                              </td>
                              <td
                                className={`text-right tabular font-medium ${directionColorClass(
                                  row.direction,
                                )}`}
                              >
                                {formatUnitDelta(row.absoluteDifference, row.unit)}
                              </td>
                              <td
                                className={`text-right tabular font-mono text-xs ${directionColorClass(
                                  row.direction,
                                )}`}
                              >
                                {row.percentageDifference === null
                                  ? 'N/A'
                                  : `${
                                      parseFloat(row.percentageDifference) > 0 ? '+' : ''
                                    }${row.percentageDifference}%`}
                              </td>
                              <td>{directionBadge(row.direction)}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* Routing Operations & Machine Rate Changes */}
                <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
                  <div className="px-4 py-3 border-b border-gray-100 flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
                        Routing Operations, Machine Rates &amp; Cycle Time Comparison
                      </h4>
                      <p className="text-xs text-gray-400 mt-0.5">
                        Total Cycle Time: {revisionComparison.summary.totalCycleTimeMinutes.valueA}{' '}
                        min → {revisionComparison.summary.totalCycleTimeMinutes.valueB} min (Δ{' '}
                        {parseFloat(
                          revisionComparison.summary.totalCycleTimeMinutes.absoluteDifference,
                        ) > 0
                          ? '+'
                          : ''}
                        {revisionComparison.summary.totalCycleTimeMinutes.absoluteDifference} min)
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {revisionComparison.routingComparison.addedCount > 0 && (
                        <Badge variant="green">
                          +{revisionComparison.routingComparison.addedCount} Added
                        </Badge>
                      )}
                      {revisionComparison.routingComparison.removedCount > 0 && (
                        <Badge variant="red">
                          −{revisionComparison.routingComparison.removedCount} Removed
                        </Badge>
                      )}
                      {revisionComparison.routingComparison.modifiedCount > 0 && (
                        <Badge variant="yellow">
                          {revisionComparison.routingComparison.modifiedCount} Modified
                        </Badge>
                      )}
                      {revisionComparison.routingComparison.unchangedCount > 0 && (
                        <Badge variant="gray">
                          {revisionComparison.routingComparison.unchangedCount} Unchanged
                        </Badge>
                      )}
                    </div>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>Step (A → B)</th>
                          <th>Operation</th>
                          <th>Status</th>
                          <th>Machine (vA → vB)</th>
                          <th className="text-right">Hour Rate (₹/hr)</th>
                          <th className="text-right">Cycle Time (min)</th>
                          <th className="text-right">Op Conversion Cost (₹/pc)</th>
                        </tr>
                      </thead>
                      <tbody>
                        {revisionComparison.routingComparison.operations.map(
                          (op: RoutingOperationDiff, idx: number) => (
                            <tr key={idx}>
                              <td className="font-mono text-xs text-gray-500">
                                {op.stepNumberA ?? '—'} → {op.stepNumberB ?? '—'}
                              </td>
                              <td className="font-medium text-gray-900">{op.operationName}</td>
                              <td>
                                {op.status === 'ADDED' && <Badge variant="green">Added</Badge>}
                                {op.status === 'REMOVED' && <Badge variant="red">Removed</Badge>}
                                {op.status === 'MODIFIED' && (
                                  <Badge variant="yellow">Modified</Badge>
                                )}
                                {op.status === 'UNCHANGED' && (
                                  <Badge variant="gray">Unchanged</Badge>
                                )}
                              </td>
                              <td className="text-xs">
                                {op.status === 'ADDED' ? (
                                  <span className="text-emerald-700 font-medium">{op.machineB}</span>
                                ) : op.status === 'REMOVED' ? (
                                  <span className="text-red-700 line-through">{op.machineA}</span>
                                ) : op.machineChanged ? (
                                  <span className="text-amber-700 font-medium">
                                    {op.machineA} → {op.machineB}
                                  </span>
                                ) : (
                                  <span className="text-gray-700">{op.machineB}</span>
                                )}
                              </td>
                              <td className="text-right tabular text-xs">
                                {op.status === 'ADDED' ? (
                                  <span className="text-emerald-700 font-medium">
                                    ₹{op.machineHourRateB}/hr
                                  </span>
                                ) : op.status === 'REMOVED' ? (
                                  <span className="text-red-700 line-through">
                                    ₹{op.machineHourRateA}/hr
                                  </span>
                                ) : (
                                  <div>
                                    <span className="text-gray-900">
                                      ₹{op.machineHourRateA} → ₹{op.machineHourRateB}
                                    </span>
                                    {op.machineHourRateDiff &&
                                      parseFloat(op.machineHourRateDiff) !== 0 && (
                                        <div className="font-mono text-[11px] text-amber-700">
                                          ({parseFloat(op.machineHourRateDiff) > 0 ? '+' : ''}₹
                                          {op.machineHourRateDiff} /{' '}
                                          {op.machineHourRatePctDiff ?? '0.00'}%)
                                        </div>
                                      )}
                                  </div>
                                )}
                              </td>
                              <td className="text-right tabular text-xs">
                                {op.status === 'ADDED' ? (
                                  <span className="text-emerald-700 font-medium">
                                    {op.cycleTimeMinutesB} min
                                  </span>
                                ) : op.status === 'REMOVED' ? (
                                  <span className="text-red-700 line-through">
                                    {op.cycleTimeMinutesA} min
                                  </span>
                                ) : (
                                  <div>
                                    <span className="text-gray-900">
                                      {op.cycleTimeMinutesA} → {op.cycleTimeMinutesB} min
                                    </span>
                                    {op.cycleTimeDiffMinutes &&
                                      parseFloat(op.cycleTimeDiffMinutes) !== 0 && (
                                        <div className="font-mono text-[11px] text-amber-700">
                                          ({parseFloat(op.cycleTimeDiffMinutes) > 0 ? '+' : ''}
                                          {op.cycleTimeDiffMinutes} min /{' '}
                                          {op.cycleTimePctDiff ?? '0.00'}%)
                                        </div>
                                      )}
                                  </div>
                                )}
                              </td>
                              <td className="text-right tabular text-xs">
                                {op.status === 'ADDED' ? (
                                  <span className="text-emerald-700 font-medium">
                                    ₹{op.operationCostB}
                                  </span>
                                ) : op.status === 'REMOVED' ? (
                                  <span className="text-red-700 line-through">
                                    ₹{op.operationCostA}
                                  </span>
                                ) : (
                                  <div>
                                    <span className="text-gray-900">
                                      ₹{op.operationCostA} → ₹{op.operationCostB}
                                    </span>
                                    {op.operationCostDiff &&
                                      parseFloat(op.operationCostDiff) !== 0 && (
                                        <div className="font-mono text-[11px] text-amber-700">
                                          ({parseFloat(op.operationCostDiff) > 0 ? '+' : ''}₹
                                          {op.operationCostDiff})
                                        </div>
                                      )}
                                  </div>
                                )}
                              </td>
                            </tr>
                          ),
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* Three Volume Tiers Comparison (50%, 100%, 150%) */}
                <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
                  <div className="px-4 py-3 border-b border-gray-100">
                    <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
                      Three-Tier Volume Comparison (50%, 100%, 150%)
                    </h4>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>Tier</th>
                          <th className="text-right">Tier Volume (pcs)</th>
                          <th className="text-right">Setup Alloc / pc</th>
                          <th className="text-right">Total Cost / pc</th>
                          <th className="text-right">Selling Price (Ex-GST)</th>
                          <th className="text-right">GST / pc</th>
                          <th className="text-right">Selling Price (Incl. GST)</th>
                          <th className="text-right">Tier Quote Value (Ex-GST)</th>
                        </tr>
                      </thead>
                      <tbody>
                        {revisionComparison.tierComparisons.map(
                          (tc: VolumeTierRevisionComparison) => (
                            <tr
                              key={tc.tierPercentage}
                              className={
                                tc.tierPercentage === 100 ? 'bg-brand-50/40 font-medium' : undefined
                              }
                            >
                              <td>
                                <Badge variant={tc.tierPercentage === 100 ? 'blue' : 'default'}>
                                  {tc.tierPercentage}% ({tc.tierName})
                                </Badge>
                              </td>
                              <td className="text-right tabular text-xs">
                                <div>
                                  {Number(tc.tierVolume.valueA).toLocaleString('en-IN')} →{' '}
                                  {Number(tc.tierVolume.valueB).toLocaleString('en-IN')}
                                </div>
                                {tc.tierVolume.direction !== 'UNCHANGED' && (
                                  <div
                                    className={`font-mono text-[11px] ${directionColorClass(
                                      tc.tierVolume.direction,
                                    )}`}
                                  >
                                    ({formatUnitDelta(tc.tierVolume.absoluteDifference, 'PCS')})
                                  </div>
                                )}
                              </td>
                              <td className="text-right tabular text-xs">
                                <div>
                                  ₹{tc.setupAllocationPerPiece.valueA} → ₹
                                  {tc.setupAllocationPerPiece.valueB}
                                </div>
                                <div
                                  className={`font-mono text-[11px] ${directionColorClass(
                                    tc.setupAllocationPerPiece.direction,
                                  )}`}
                                >
                                  (
                                  {formatUnitDelta(
                                    tc.setupAllocationPerPiece.absoluteDifference,
                                    'INR_PER_PC',
                                  )}
                                  )
                                </div>
                              </td>
                              <td className="text-right tabular text-xs">
                                <div>
                                  ₹{tc.totalCostPerPiece.valueA} → ₹{tc.totalCostPerPiece.valueB}
                                </div>
                                <div
                                  className={`font-mono text-[11px] ${directionColorClass(
                                    tc.totalCostPerPiece.direction,
                                  )}`}
                                >
                                  (
                                  {formatUnitDelta(
                                    tc.totalCostPerPiece.absoluteDifference,
                                    'INR_PER_PC',
                                  )}{' '}
                                  / {tc.totalCostPerPiece.percentageDifference ?? '0.00'}%)
                                </div>
                              </td>
                              <td className="text-right tabular text-xs font-semibold">
                                <div>
                                  ₹{tc.sellingPriceExGst.valueA} → ₹{tc.sellingPriceExGst.valueB}
                                </div>
                                <div
                                  className={`font-mono text-[11px] ${directionColorClass(
                                    tc.sellingPriceExGst.direction,
                                  )}`}
                                >
                                  (
                                  {formatUnitDelta(
                                    tc.sellingPriceExGst.absoluteDifference,
                                    'INR_PER_PC',
                                  )}{' '}
                                  / {tc.sellingPriceExGst.percentageDifference ?? '0.00'}%)
                                </div>
                              </td>
                              <td className="text-right tabular text-xs">
                                <div>
                                  ₹{tc.gstAmount.valueA} → ₹{tc.gstAmount.valueB}
                                </div>
                                <div
                                  className={`font-mono text-[11px] ${directionColorClass(
                                    tc.gstAmount.direction,
                                  )}`}
                                >
                                  ({formatUnitDelta(tc.gstAmount.absoluteDifference, 'INR_PER_PC')})
                                </div>
                              </td>
                              <td className="text-right tabular text-xs">
                                <div>
                                  ₹{tc.sellingPriceIncludingGst.valueA} → ₹
                                  {tc.sellingPriceIncludingGst.valueB}
                                </div>
                                <div
                                  className={`font-mono text-[11px] ${directionColorClass(
                                    tc.sellingPriceIncludingGst.direction,
                                  )}`}
                                >
                                  (
                                  {formatUnitDelta(
                                    tc.sellingPriceIncludingGst.absoluteDifference,
                                    'INR_PER_PC',
                                  )}{' '}
                                  / {tc.sellingPriceIncludingGst.percentageDifference ?? '0.00'}%)
                                </div>
                              </td>
                              <td className="text-right tabular text-xs">
                                <div>
                                  {formatInr(tc.tierAnnualQuoteValueExGst.valueA)} →{' '}
                                  {formatInr(tc.tierAnnualQuoteValueExGst.valueB)}
                                </div>
                                <div
                                  className={`font-mono text-[11px] ${directionColorClass(
                                    tc.tierAnnualQuoteValueExGst.direction,
                                  )}`}
                                >
                                  (
                                  {formatUnitDelta(
                                    tc.tierAnnualQuoteValueExGst.absoluteDifference,
                                    'INR',
                                  )}{' '}
                                  / {tc.tierAnnualQuoteValueExGst.percentageDifference ?? '0.00'}%)
                                </div>
                              </td>
                            </tr>
                          ),
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* GST Displayed Separately */}
                <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
                  <div className="px-4 py-3 border-b border-gray-100">
                    <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
                      Tax / GST Comparison (Displayed Separately — Base 100% Tier)
                    </h4>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>GST Parameter</th>
                          <th className="text-right">v{revisionComparison.versionA.version}</th>
                          <th className="text-right">v{revisionComparison.versionB.version}</th>
                          <th className="text-right">Absolute Diff</th>
                          <th className="text-right">% Diff</th>
                          <th>Change</th>
                        </tr>
                      </thead>
                      <tbody>
                        {revisionComparison.gstRows.map((row: RevisionComparisonRow) => (
                          <tr key={row.key}>
                            <td className="font-medium text-gray-900">{row.label}</td>
                            <td className="text-right tabular text-gray-700">
                              {formatUnitValue(row.versionAValue, row.unit)}
                            </td>
                            <td className="text-right tabular text-gray-900">
                              {formatUnitValue(row.versionBValue, row.unit)}
                            </td>
                            <td
                              className={`text-right tabular font-medium ${directionColorClass(
                                row.direction,
                              )}`}
                            >
                              {formatUnitDelta(row.absoluteDifference, row.unit)}
                            </td>
                            <td
                              className={`text-right tabular font-mono text-xs ${directionColorClass(
                                row.direction,
                              )}`}
                            >
                              {row.percentageDifference === null
                                ? 'N/A'
                                : `${
                                    parseFloat(row.percentageDifference) > 0 ? '+' : ''
                                  }${row.percentageDifference}%`}
                            </td>
                            <td>{directionBadge(row.direction)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
