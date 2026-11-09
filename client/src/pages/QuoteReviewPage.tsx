/**
 * pages/QuoteReviewPage.tsx
 *
 * Sales Head quote review page.
 * Route: /approvals/:quoteId
 *
 * Features:
 *  - Full cost breakdown display
 *  - Volume tier pricing
 *  - Rate traceability snapshot
 *  - Approve / Reject (with mandatory comment) actions
 *  - Mark as Sent (APPROVED or READY_FOR_SALES → SENT)
 *  - PDF download (APPROVED / READY_FOR_SALES / SENT)
 *  - Audit trail table
 */
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  CheckCircle,
  CheckCircle2,
  Download,
  Send,
  XCircle,
} from 'lucide-react';
import { approvalApi, costingApi } from '../api';
import {
  QuoteDetail,
  QuoteEvent,
  PopulatedRFQRef,
  PopulatedUserRef,
  CostBreakdown,
  VolumeTier,
} from '../types';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { useAuth } from '../context/AuthContext';

// ─── Formatting helpers ───────────────────────────────────────────────────────

function fmt(str: string, decimals = 2): string {
  const n = parseFloat(str);
  if (isNaN(n)) return str;
  return (
    '₹' +
    n.toLocaleString('en-IN', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    })
  );
}

function formatDate(iso: string | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

function formatDateTime(iso: string | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// ─── Status helpers ───────────────────────────────────────────────────────────

function statusVariant(
  status: string,
): 'default' | 'blue' | 'green' | 'yellow' | 'red' | 'gray' {
  switch (status) {
    case 'DRAFT':            return 'gray';
    case 'PENDING_APPROVAL': return 'yellow';
    case 'APPROVED':         return 'green';
    case 'REJECTED':         return 'red';
    case 'READY_FOR_SALES':  return 'blue';
    case 'SENT':             return 'green';
    default:                 return 'default';
  }
}

function statusLabel(status: string): string {
  switch (status) {
    case 'DRAFT':            return 'Draft';
    case 'PENDING_APPROVAL': return 'Pending Approval';
    case 'APPROVED':         return 'Approved';
    case 'REJECTED':         return 'Rejected';
    case 'READY_FOR_SALES':  return 'Ready for Sales';
    case 'SENT':             return 'Sent';
    default:                 return status;
  }
}

function actionLabel(action: string): string {
  switch (action) {
    case 'SUBMITTED': return 'Submitted';
    case 'APPROVED':  return 'Approved';
    case 'REJECTED':  return 'Rejected';
    case 'SENT':      return 'Marked as Sent';
    default:          return action;
  }
}

function actionVariant(action: string): 'default' | 'blue' | 'green' | 'yellow' | 'red' | 'gray' {
  switch (action) {
    case 'SUBMITTED': return 'yellow';
    case 'APPROVED':  return 'green';
    case 'REJECTED':  return 'red';
    case 'SENT':      return 'blue';
    default:          return 'default';
  }
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function CostBreakdownTable({ bd }: { bd: CostBreakdown }) {
  const rows: Array<[string, string, boolean?]> = [
    ['Material', bd.materialCost],
    ['Scrap', bd.scrapCost],
    ['Conversion (Routing)', bd.conversionCost],
    ['Overhead', bd.overheadCost],
    ['Packing & Freight', bd.packingFreight],
    ['Setup Allocation / Piece', bd.setupAllocationPerPiece],
    ['Total Cost / Piece', bd.totalCost, true],
    ['Selling Price (Ex-GST)', bd.sellingPriceExGst, true],
    ['GST Amount', bd.gstAmount],
    ['Selling Price (Incl. GST)', bd.sellingPriceIncludingGst, true],
  ];

  return (
    <section className="bg-white border border-gray-200 rounded-lg overflow-hidden">
      <div className="px-5 py-3 border-b border-gray-100">
        <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
          Cost Breakdown — Per Piece (Base Tier)
        </h2>
      </div>
      <table className="w-full text-sm">
        <tbody>
          {rows.map(([label, value, highlight]) => (
            <tr
              key={label}
              className={[
                'border-b border-gray-100 last:border-0',
                highlight ? 'bg-brand-50' : 'hover:bg-gray-50',
              ].join(' ')}
            >
              <td
                className={[
                  'px-5 py-2.5',
                  highlight ? 'font-semibold text-gray-800' : 'text-gray-600',
                ].join(' ')}
              >
                {label}
              </td>
              <td
                className={[
                  'px-5 py-2.5 text-right tabular',
                  highlight ? 'font-semibold text-gray-900' : 'text-gray-700',
                ].join(' ')}
              >
                {fmt(value)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function TierGrid({ tiers }: { tiers: VolumeTier[] }) {
  return (
    <section>
      <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">
        Volume Tiers
      </h2>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {tiers.map((tier) => {
          const isBase = tier.tierPercentage === 100;
          return (
            <div
              key={tier.tierName}
              className={[
                'rounded-lg border p-4 flex flex-col gap-2',
                isBase
                  ? 'border-brand-500 ring-2 ring-brand-500 bg-brand-50'
                  : 'border-gray-200 bg-white',
              ].join(' ')}
            >
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold text-gray-700">{tier.tierName}</span>
                <Badge variant={isBase ? 'blue' : 'default'}>{tier.tierPercentage}%</Badge>
              </div>
              <div className="text-xs text-gray-500">
                Volume: {tier.tierVolume.toLocaleString('en-IN')} pcs
              </div>
              <div className="space-y-1 text-sm">
                <div className="flex justify-between">
                  <span className="text-gray-600">Ex-GST</span>
                  <span className="tabular font-medium text-gray-900">
                    {fmt(tier.sellingPriceExGst)}
                  </span>
                </div>
                <div className="flex justify-between border-t border-gray-200 pt-1 mt-1">
                  <span className="font-semibold text-gray-800">Incl. GST</span>
                  <span
                    className={[
                      'tabular font-bold',
                      isBase ? 'text-brand-700' : 'text-gray-900',
                    ].join(' ')}
                  >
                    {fmt(tier.sellingPriceIncludingGst)}
                  </span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function QuoteReviewPage() {
  const { quoteId } = useParams<{ quoteId: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();

  const [quote, setQuote] = useState<QuoteDetail | null>(null);
  const [events, setEvents] = useState<QuoteEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Action state
  const [approving, setApproving] = useState(false);
  const [showRejectForm, setShowRejectForm] = useState(false);
  const [rejectComment, setRejectComment] = useState('');
  const [rejecting, setRejecting] = useState(false);
  const [sending, setSending] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [actionError, setActionError] = useState('');
  const [actionSuccess, setActionSuccess] = useState('');

  useEffect(() => {
    if (!quoteId) return;
    approvalApi
      .getQuote(quoteId)
      .then((res) => {
        setQuote(res.data.data.quote);
        setEvents(res.data.data.events);
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, [quoteId]);

  async function handleApprove() {
    if (!quoteId || !quote) return;
    if (!window.confirm('Approve this quote? This action cannot be undone.')) return;
    setApproving(true);
    setActionError('');
    setActionSuccess('');
    try {
      const res = await approvalApi.approve(quoteId);
      setQuote(res.data.data as QuoteDetail);
      setActionSuccess('Quote approved successfully.');
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : 'Approval failed');
    } finally {
      setApproving(false);
    }
  }

  async function handleReject() {
    if (!quoteId || !quote) return;
    if (!rejectComment.trim()) {
      setActionError('Rejection comment is required.');
      return;
    }
    setRejecting(true);
    setActionError('');
    setActionSuccess('');
    try {
      const res = await approvalApi.reject(quoteId, rejectComment.trim());
      setQuote(res.data.data as QuoteDetail);
      setActionSuccess('Quote rejected.');
      setShowRejectForm(false);
      setRejectComment('');
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : 'Rejection failed');
    } finally {
      setRejecting(false);
    }
  }

  async function handleMarkSent() {
    if (!quoteId || !quote) return;
    if (!window.confirm('Mark this quotation as sent to customer?')) return;
    setSending(true);
    setActionError('');
    setActionSuccess('');
    try {
      const rfqId =
        typeof quote.rfqId === 'object'
          ? (quote.rfqId as PopulatedRFQRef)._id
          : quote.rfqId;
      const res = await costingApi.markSent(rfqId, quoteId);
      setQuote((prev) =>
        prev ? { ...prev, status: res.data.data.status } : prev,
      );
      setActionSuccess('Quotation marked as sent.');
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : 'Mark sent failed');
    } finally {
      setSending(false);
    }
  }

  async function handleDownloadPdf() {
    if (!quoteId || !quote) return;
    setDownloading(true);
    setActionError('');
    try {
      const rfqId =
        typeof quote.rfqId === 'object'
          ? (quote.rfqId as PopulatedRFQRef)._id
          : quote.rfqId;
      const rfqNo =
        typeof quote.rfqId === 'object'
          ? (quote.rfqId as PopulatedRFQRef).rfqNo
          : rfqId;

      const res = await costingApi.downloadPdf(rfqId, quoteId);
      const blob = new Blob([res.data as unknown as BlobPart], {
        type: 'application/pdf',
      });
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `Quotation-${rfqNo}-v${quote.version}.pdf`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : 'PDF download failed');
    } finally {
      setDownloading(false);
    }
  }

  // ── Access guard ────────────────────────────────────────────────────────────
  if (user?.role !== 'SALES_HEAD') {
    return (
      <div className="p-4 rounded bg-red-50 border border-red-200 text-sm text-red-700 flex items-center gap-2">
        <AlertCircle className="w-4 h-4 shrink-0" strokeWidth={1.8} />
        <span>Access denied. Sales Head only.</span>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-sm text-gray-400">
        Loading quote…
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4 rounded bg-red-50 border border-red-200 text-sm text-red-700 flex items-center gap-2">
        <AlertCircle className="w-4 h-4 shrink-0" strokeWidth={1.8} />
        <span>Failed to load quote: {error}</span>
      </div>
    );
  }

  if (!quote) {
    return (
      <div className="text-center py-20 text-sm text-gray-400">Quote not found.</div>
    );
  }

  const rfqRef =
    typeof quote.rfqId === 'object' ? (quote.rfqId as PopulatedRFQRef) : null;
  const bd = quote.costBreakdown;
  const tiers = quote.volumeTierResults ?? [];
  const pdfAllowed = ['APPROVED', 'READY_FOR_SALES', 'SENT'].includes(quote.status);
  const canApproveReject = quote.status === 'PENDING_APPROVAL';
  const canMarkSent = ['APPROVED', 'READY_FOR_SALES'].includes(quote.status);

  return (
    <div className="space-y-6">
      {/* Breadcrumb */}
      <button
        onClick={() => navigate('/approval')}
        className="inline-flex items-center gap-1.5 text-sm text-brand-600 hover:underline"
      >
        <ArrowLeft className="w-4 h-4 shrink-0" strokeWidth={1.8} />
        <span>Approval Queue</span>
      </button>

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
        <div>
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-lg font-semibold text-gray-900">
              {rfqRef ? rfqRef.rfqNo : 'Quote'} — v{quote.version}
            </h1>
            <Badge variant={statusVariant(quote.status)}>
              {statusLabel(quote.status)}
            </Badge>
          </div>
          {rfqRef && (
            <div className="flex items-center gap-3 mt-1 text-sm text-gray-600">
              <span>{rfqRef.customer}</span>
              <span className="text-gray-300">·</span>
              <Link
                to={`/rfqs/${rfqRef._id}`}
                className="inline-flex items-center gap-1 text-brand-600 hover:underline text-xs font-medium"
              >
                <span>View RFQ &amp; Compare Versions</span>
                <ArrowRight className="w-3.5 h-3.5 shrink-0" strokeWidth={1.8} />
              </Link>
            </div>
          )}
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-2 flex-wrap shrink-0">
          {pdfAllowed && (
            <Button
              variant="secondary"
              size="sm"
              loading={downloading}
              onClick={handleDownloadPdf}
            >
              <Download className="w-3.5 h-3.5 shrink-0" strokeWidth={1.8} />
              <span>Download PDF</span>
            </Button>
          )}
          {canMarkSent && (
            <Button
              variant="secondary"
              size="sm"
              loading={sending}
              onClick={handleMarkSent}
            >
              <Send className="w-3.5 h-3.5 shrink-0" strokeWidth={1.8} />
              <span>Mark as Sent</span>
            </Button>
          )}
          {canApproveReject && !showRejectForm && (
            <>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowRejectForm(true)}
              >
                <XCircle className="w-3.5 h-3.5 shrink-0" strokeWidth={1.8} />
                <span>Reject</span>
              </Button>
              <Button
                variant="primary"
                size="sm"
                loading={approving}
                onClick={handleApprove}
              >
                <CheckCircle className="w-3.5 h-3.5 shrink-0" strokeWidth={1.8} />
                <span>Approve</span>
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Feedback banners */}
      {actionError && (
        <div className="p-3 rounded bg-red-50 border border-red-200 text-sm text-red-700 flex items-center gap-2">
          <AlertCircle className="w-4 h-4 shrink-0" strokeWidth={1.8} />
          <span>{actionError}</span>
        </div>
      )}
      {actionSuccess && (
        <div className="p-3 rounded bg-green-50 border border-green-200 text-sm text-green-700 flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 text-green-700 shrink-0" strokeWidth={1.8} />
          <span>{actionSuccess}</span>
        </div>
      )}

      {/* Reject form */}
      {showRejectForm && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 space-y-3">
          <p className="text-sm font-semibold text-red-800">Reject Quote</p>
          <textarea
            className="w-full border border-red-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-400"
            rows={3}
            placeholder="Rejection comment (required)"
            value={rejectComment}
            onChange={(e) => setRejectComment(e.target.value)}
          />
          <div className="flex gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setShowRejectForm(false);
                setRejectComment('');
                setActionError('');
              }}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              loading={rejecting}
              onClick={handleReject}
            >
              Confirm Rejection
            </Button>
          </div>
        </div>
      )}

      {/* Quote Meta */}
      <div className="bg-white border border-gray-200 rounded-lg p-5">
        <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">
          Quote Details
        </h2>
        <dl className="grid grid-cols-2 sm:grid-cols-3 gap-4 text-sm">
          <div>
            <dt className="text-gray-500">Annual Quotation Value</dt>
            <dd className="mt-0.5 font-semibold tabular text-gray-900">
              {fmt(quote.annualQuotationValue)}
            </dd>
          </div>
          <div>
            <dt className="text-gray-500">Costing Date</dt>
            <dd className="mt-0.5 text-gray-900">{formatDate(quote.costingDate)}</dd>
          </div>
          <div>
            <dt className="text-gray-500">Created</dt>
            <dd className="mt-0.5 text-gray-900">{formatDate(quote.createdAt)}</dd>
          </div>
          {quote.submittedAt && (
            <div>
              <dt className="text-gray-500">Submitted At</dt>
              <dd className="mt-0.5 text-gray-900">{formatDateTime(quote.submittedAt)}</dd>
            </div>
          )}
          {quote.approvedAt && (
            <div>
              <dt className="text-gray-500">Approved At</dt>
              <dd className="mt-0.5 text-gray-900">{formatDateTime(quote.approvedAt)}</dd>
            </div>
          )}
          {quote.sentAt && (
            <div>
              <dt className="text-gray-500">Sent At</dt>
              <dd className="mt-0.5 text-gray-900">{formatDateTime(quote.sentAt)}</dd>
            </div>
          )}
          {quote.rejectionComment && (
            <div className="col-span-2 sm:col-span-3">
              <dt className="text-gray-500">Rejection Comment</dt>
              <dd className="mt-0.5 text-red-700 font-medium">
                {quote.rejectionComment}
              </dd>
            </div>
          )}
        </dl>
      </div>

      {/* Cost Breakdown */}
      {bd && <CostBreakdownTable bd={bd} />}

      {/* Volume Tiers */}
      {tiers.length > 0 && <TierGrid tiers={tiers} />}

      {/* Annual Quotation Value summary */}
      <div className="bg-white border border-gray-200 rounded-lg px-5 py-4">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
              Annual Quotation Value
            </p>
            <p className="mt-1 text-2xl font-bold tabular text-gray-900">
              {fmt(quote.annualQuotationValue)}
            </p>
            <p className="mt-0.5 text-xs text-gray-400">
              Base tier (Ex-GST) × Annual Volume · Approval threshold: ₹25,00,000
            </p>
          </div>
        </div>
      </div>

      {/* Rate Traceability Snapshot */}
      {quote.rateSnapshot && (
        <section className="bg-white border border-gray-200 rounded-lg p-5">
          <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">
            Rate Traceability Snapshot
          </h2>
          <dl className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm">
            <div>
              <dt className="text-gray-500">Material</dt>
              <dd className="mt-0.5 font-medium text-gray-900">
                {quote.rateSnapshot.material}
              </dd>
            </div>
            <div>
              <dt className="text-gray-500">Material Rate</dt>
              <dd className="mt-0.5 tabular text-gray-900">
                {fmt(quote.rateSnapshot.materialRatePerKg)}/kg
              </dd>
            </div>
            <div>
              <dt className="text-gray-500">Rate Effective</dt>
              <dd className="mt-0.5 text-gray-900">
                {formatDate(quote.rateSnapshot.materialRateEffectiveFrom)}
              </dd>
            </div>
            <div>
              <dt className="text-gray-500">Scrap %</dt>
              <dd className="mt-0.5 text-gray-900">{quote.rateSnapshot.scrapPct}%</dd>
            </div>
            <div>
              <dt className="text-gray-500">Overhead %</dt>
              <dd className="mt-0.5 text-gray-900">{quote.rateSnapshot.overheadPct}%</dd>
            </div>
            <div>
              <dt className="text-gray-500">Margin %</dt>
              <dd className="mt-0.5 text-gray-900">{quote.rateSnapshot.marginPct}%</dd>
            </div>
            <div>
              <dt className="text-gray-500">GST %</dt>
              <dd className="mt-0.5 text-gray-900">{quote.rateSnapshot.gstPct}%</dd>
            </div>
          </dl>

          {quote.rateSnapshot.operations?.length > 0 && (
            <div className="mt-4">
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
                Routing Operations
              </p>
              <div className="space-y-1">
                {quote.rateSnapshot.operations.map((op, i) => (
                  <div key={i} className="text-sm text-gray-700">
                    {op.operationName} — {op.machine} — {op.cycleTimeMinutes} min — {fmt(op.machineHourRate)}/hr
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>
      )}

      {/* Audit Trail */}
      {events.length > 0 && (
        <section>
          <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">
            Audit Trail
          </h2>
          <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Action</th>
                    <th>Actor</th>
                    <th>Timestamp</th>
                    <th>Comment</th>
                  </tr>
                </thead>
                <tbody>
                  {events.map((event) => {
                    const actor =
                      typeof event.actorId === 'object'
                        ? (event.actorId as PopulatedUserRef).name
                        : event.actorId;
                    return (
                      <tr key={event._id}>
                        <td className="whitespace-nowrap">
                          <Badge variant={actionVariant(event.action)}>
                            {actionLabel(event.action)}
                          </Badge>
                        </td>
                        <td className="text-sm text-gray-700 whitespace-nowrap">{actor}</td>
                        <td className="tabular text-sm text-gray-500 whitespace-nowrap">
                          {formatDateTime(event.timestamp)}
                        </td>
                        <td className="text-sm text-gray-600">{event.comment ?? '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}

