import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { rfqApi } from '../api';
import { LostReason, QuoteStatus, RFQ, RFQStatus } from '../types';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { useAuth } from '../context/AuthContext';

export const LOST_REASON_OPTIONS: Array<{ value: LostReason; label: string }> = [
  { value: 'PRICE_TOO_HIGH', label: 'Price Too High' },
  { value: 'DELIVERY_TIMELINE', label: 'Delivery Timeline Not Met' },
  { value: 'COMPETITOR_SELECTED', label: 'Competitor Selected' },
  { value: 'TECHNICAL_REJECTION', label: 'Technical / Spec Rejection' },
  { value: 'CUSTOMER_CANCELLED', label: 'Customer Cancelled Program' },
  { value: 'OTHER', label: 'Other (Specify)' },
];

export function formatLostReason(reason?: LostReason | string): string {
  if (!reason) return '—';
  const found = LOST_REASON_OPTIONS.find((o) => o.value === reason);
  return found ? found.label : reason;
}

type OutcomeFilter = 'ALL' | 'ESTIMATING' | 'SENT' | 'WON' | 'LOST';

// Map RFQ commercial outcome to badge variant
function statusVariant(status: RFQStatus): 'blue' | 'yellow' | 'green' | 'gray' | 'red' {
  switch (status) {
    case 'ESTIMATING':
    case 'PENDING_APPROVAL':
      return 'blue';
    case 'SENT':
      return 'yellow';
    case 'WON':
      return 'green';
    case 'LOST':
      return 'red';
  }
}

function statusLabel(status: RFQStatus): string {
  switch (status) {
    case 'ESTIMATING':
    case 'PENDING_APPROVAL':
      return 'Estimating';
    case 'SENT':
      return 'Sent';
    case 'WON':
      return 'Won';
    case 'LOST':
      return 'Lost';
  }
}

function quoteStatusVariant(
  status: QuoteStatus,
): 'default' | 'blue' | 'green' | 'yellow' | 'red' | 'gray' {
  switch (status) {
    case 'DRAFT':
      return 'gray';
    case 'PENDING_APPROVAL':
      return 'yellow';
    case 'APPROVED':
      return 'green';
    case 'REJECTED':
      return 'red';
    case 'READY_FOR_SALES':
      return 'blue';
    case 'SENT':
      return 'blue';
  }
}

function quoteStatusLabel(status: QuoteStatus): string {
  switch (status) {
    case 'DRAFT':
      return 'Draft';
    case 'PENDING_APPROVAL':
      return 'Pending Approval';
    case 'APPROVED':
      return 'Approved';
    case 'REJECTED':
      return 'Rejected';
    case 'READY_FOR_SALES':
      return 'Ready for Sales';
    case 'SENT':
      return 'Sent';
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
  if (!ownerId) return '—';
  if (typeof ownerId === 'string') return ownerId;
  return ownerId.name ?? '—';
}

export function RFQListPage() {
  const { user } = useAuth();
  const [rfqs, setRfqs] = useState<RFQ[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<OutcomeFilter>('ALL');

  // Action feedback & modal state for Sales Head outcome updates
  const [actionError, setActionError] = useState('');
  const [submittingRfqId, setSubmittingRfqId] = useState<string | null>(null);
  const [lostModalRfq, setLostModalRfq] = useState<RFQ | null>(null);
  const [selectedLostReason, setSelectedLostReason] = useState<LostReason | ''>('');
  const [lostReasonNote, setLostReasonNote] = useState('');
  const [lostModalError, setLostModalError] = useState('');

  function loadRfqs() {
    setLoading(true);
    setError('');
    rfqApi
      .list()
      .then((res) => setRfqs(res.data.data))
      .catch((err) => setError(err.message || 'Failed to load RFQs'))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    loadRfqs();
  }, []);

  const counts = useMemo(() => {
    const c = { ALL: rfqs.length, ESTIMATING: 0, SENT: 0, WON: 0, LOST: 0 };
    for (const r of rfqs) {
      const normalized = r.status === 'PENDING_APPROVAL' ? 'ESTIMATING' : r.status;
      if (normalized in c) {
        c[normalized as keyof typeof c]++;
      }
    }
    return c;
  }, [rfqs]);

  const filteredRfqs = useMemo(() => {
    if (filter === 'ALL') return rfqs;
    return rfqs.filter((r) => {
      const normalized = r.status === 'PENDING_APPROVAL' ? 'ESTIMATING' : r.status;
      return normalized === filter;
    });
  }, [rfqs, filter]);

  async function handleMarkWon(rfq: RFQ) {
    setActionError('');
    setSubmittingRfqId(rfq._id);
    try {
      await rfqApi.updateOutcome(rfq._id, { outcome: 'WON' });
      loadRfqs();
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : 'Failed to mark RFQ as Won');
    } finally {
      setSubmittingRfqId(null);
    }
  }

  function openLostModal(rfq: RFQ) {
    setActionError('');
    setLostModalRfq(rfq);
    setSelectedLostReason('');
    setLostReasonNote('');
    setLostModalError('');
  }

  function closeLostModal() {
    setLostModalRfq(null);
    setSelectedLostReason('');
    setLostReasonNote('');
    setLostModalError('');
  }

  async function handleConfirmLost() {
    if (!lostModalRfq) return;
    if (!selectedLostReason) {
      setLostModalError('Please select a reason for losing this RFQ.');
      return;
    }
    if (selectedLostReason === 'OTHER' && lostReasonNote.trim().length < 5) {
      setLostModalError(
        'Please provide a meaningful explanation (at least 5 characters) when selecting "Other".',
      );
      return;
    }

    setLostModalError('');
    setSubmittingRfqId(lostModalRfq._id);
    try {
      await rfqApi.updateOutcome(lostModalRfq._id, {
        outcome: 'LOST',
        lostReason: selectedLostReason,
        ...(lostReasonNote.trim() ? { lostReasonNote: lostReasonNote.trim() } : {}),
      });
      closeLostModal();
      loadRfqs();
    } catch (err: unknown) {
      setLostModalError(err instanceof Error ? err.message : 'Failed to mark RFQ as Lost');
    } finally {
      setSubmittingRfqId(null);
    }
  }

  const filterTabs: Array<{ key: OutcomeFilter; label: string; count: number }> = [
    { key: 'ALL', label: 'All', count: counts.ALL },
    { key: 'ESTIMATING', label: 'Estimating', count: counts.ESTIMATING },
    { key: 'SENT', label: 'Sent', count: counts.SENT },
    { key: 'WON', label: 'Won', count: counts.WON },
    { key: 'LOST', label: 'Lost', count: counts.LOST },
  ];

  return (
    <div className="space-y-5">
      {/* Page header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-gray-900">RFQ Register</h1>
          <p className="mt-0.5 text-sm text-gray-500">
            Track RFQ commercial outcomes (Estimating, Sent, Won, Lost) and latest quotation
            lifecycle status
          </p>
        </div>
        {user?.role === 'ESTIMATOR' && (
          <Link to="/intake">
            <Button size="sm">+ AI-Assisted RFQ Intake</Button>
          </Link>
        )}
      </div>

      {/* Commercial Outcome Filter Bar */}
      {!loading && !error && rfqs.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 border-b border-gray-200 pb-3">
          {filterTabs.map((tab) => {
            const active = filter === tab.key;
            return (
              <button
                key={tab.key}
                type="button"
                onClick={() => setFilter(tab.key)}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                  active
                    ? 'bg-brand-600 text-white shadow-sm'
                    : 'bg-white text-gray-600 border border-gray-200 hover:bg-gray-50'
                }`}
              >
                <span>{tab.label}</span>
                <span
                  className={`px-1.5 py-0.5 rounded-full text-[11px] font-semibold tabular ${
                    active ? 'bg-brand-700 text-white' : 'bg-gray-100 text-gray-600'
                  }`}
                >
                  {tab.count}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {/* Action error banner */}
      {actionError && (
        <div className="p-3 rounded bg-red-50 border border-red-200 text-xs text-red-700 flex items-center justify-between">
          <span>{actionError}</span>
          <button
            type="button"
            onClick={() => setActionError('')}
            className="text-red-500 hover:text-red-700 font-medium ml-4"
          >
            Dismiss
          </button>
        </div>
      )}

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

      {/* Empty state (no RFQs in system) */}
      {!loading && !error && rfqs.length === 0 && (
        <div className="text-center py-20 text-sm text-gray-400 bg-white border border-gray-200 rounded-lg">
          No RFQs found. Create one to get started.
        </div>
      )}

      {/* Empty state for active filter */}
      {!loading && !error && rfqs.length > 0 && filteredRfqs.length === 0 && (
        <div className="text-center py-14 text-sm text-gray-400 bg-white border border-gray-200 rounded-lg">
          No RFQs match the <span className="font-medium text-gray-600">{filter}</span> filter.
        </div>
      )}

      {/* RFQ table */}
      {!loading && !error && filteredRfqs.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>RFQ No.</th>
                  <th>Customer</th>
                  <th>Parts</th>
                  <th>Owner</th>
                  <th>Due Date</th>
                  <th>Commercial Outcome</th>
                  <th>Latest Quote Status</th>
                  <th className="text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredRfqs.map((rfq) => {
                  const partCount = rfq.partCount ?? (rfq.partName ? 1 : 0);
                  const canUpdateOutcome =
                    user?.role === 'SALES_HEAD' &&
                    rfq.status === 'SENT' &&
                    rfq.hasSentQuote !== false;
                  const isBusy = submittingRfqId === rfq._id;

                  return (
                    <tr key={rfq._id} className={rfq.isOverdue ? 'bg-red-50/60' : ''}>
                      <td className="font-mono text-xs font-medium text-gray-900">
                        <Link
                          to={`/rfqs/${rfq._id}`}
                          className="hover:text-brand-600 hover:underline"
                        >
                          {rfq.rfqNo}
                        </Link>
                      </td>
                      <td className="text-gray-900 font-medium">{rfq.customer}</td>
                      <td>
                        <div className="flex items-center gap-1.5">
                          <span className="inline-flex items-center px-2 py-0.5 rounded bg-gray-100 text-gray-800 text-xs font-mono font-medium tabular">
                            {partCount} {partCount === 1 ? 'part' : 'parts'}
                          </span>
                          {rfq.partName && (
                            <span
                              className="text-xs text-gray-500 truncate max-w-[160px]"
                              title={rfq.partName}
                            >
                              {rfq.partName}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="text-sm text-gray-600">{ownerName(rfq.ownerId)}</td>
                      <td className="tabular text-sm">
                        <span
                          className={
                            rfq.isOverdue ? 'text-red-600 font-medium' : 'text-gray-700'
                          }
                        >
                          {formatDate(rfq.dueDate)}
                        </span>
                        {rfq.isOverdue && (
                          <span className="ml-2 text-xs text-red-500 font-medium">Overdue</span>
                        )}
                      </td>
                      <td>
                        <div className="flex flex-col items-start gap-0.5">
                          <Badge variant={statusVariant(rfq.status)}>
                            {statusLabel(rfq.status)}
                          </Badge>
                          {rfq.status === 'LOST' && rfq.lostReason && (
                            <span
                              className="text-[11px] text-red-700 font-medium truncate max-w-[180px]"
                              title={
                                rfq.lostReasonNote
                                  ? `${formatLostReason(rfq.lostReason)}: ${rfq.lostReasonNote}`
                                  : formatLostReason(rfq.lostReason)
                              }
                            >
                              {formatLostReason(rfq.lostReason)}
                            </span>
                          )}
                        </div>
                      </td>
                      <td>
                        {rfq.latestQuoteStatus ? (
                          <div className="inline-flex items-center gap-1.5">
                            {rfq.latestQuoteVersion != null && (
                              <span className="font-mono text-xs text-gray-500">
                                v{rfq.latestQuoteVersion}
                              </span>
                            )}
                            <Badge variant={quoteStatusVariant(rfq.latestQuoteStatus)}>
                              {quoteStatusLabel(rfq.latestQuoteStatus)}
                            </Badge>
                          </div>
                        ) : (
                          <span className="text-xs text-gray-400">No quotes yet</span>
                        )}
                      </td>
                      <td className="text-right">
                        <div className="inline-flex items-center justify-end gap-2">
                          {canUpdateOutcome && (
                            <>
                              <Button
                                size="sm"
                                variant="secondary"
                                disabled={isBusy}
                                onClick={() => void handleMarkWon(rfq)}
                                className="text-emerald-700 border-emerald-300 hover:bg-emerald-50"
                              >
                                {isBusy ? 'Saving…' : 'Mark Won'}
                              </Button>
                              <Button
                                size="sm"
                                variant="secondary"
                                disabled={isBusy}
                                onClick={() => openLostModal(rfq)}
                                className="text-red-700 border-red-300 hover:bg-red-50"
                              >
                                Mark Lost
                              </Button>
                            </>
                          )}
                          <Link
                            to={`/rfqs/${rfq._id}`}
                            className="text-xs text-brand-600 hover:text-brand-700 font-medium ml-1"
                          >
                            View →
                          </Link>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Lost Reason Modal Dialog (Sales Head) */}
      {lostModalRfq && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="lost-reason-dialog-title"
        >
          <div className="bg-white rounded-lg border border-gray-200 shadow-xl max-w-md w-full p-6 space-y-4">
            <div>
              <h2 id="lost-reason-dialog-title" className="text-base font-semibold text-gray-900">
                Mark RFQ as Lost — {lostModalRfq.rfqNo}
              </h2>
              <p className="text-xs text-gray-500 mt-1">
                Customer: <span className="font-medium text-gray-700">{lostModalRfq.customer}</span>.
                Please select the primary commercial reason for losing this RFQ.
              </p>
            </div>

            {lostModalError && (
              <div className="p-2.5 rounded bg-red-50 border border-red-200 text-xs text-red-700">
                {lostModalError}
              </div>
            )}

            <div className="space-y-3">
              <div>
                <label
                  htmlFor="lost-reason-select"
                  className="block text-xs font-semibold text-gray-700 uppercase tracking-wider mb-1"
                >
                  Lost Reason <span className="text-red-600">*</span>
                </label>
                <select
                  id="lost-reason-select"
                  value={selectedLostReason}
                  onChange={(e) => setSelectedLostReason(e.target.value as LostReason | '')}
                  className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-brand-500"
                >
                  <option value="">Select a reason…</option>
                  {LOST_REASON_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label
                  htmlFor="lost-reason-note"
                  className="block text-xs font-semibold text-gray-700 uppercase tracking-wider mb-1"
                >
                  Explanatory Note{' '}
                  {selectedLostReason === 'OTHER' ? (
                    <span className="text-red-600">* (Required for Other)</span>
                  ) : (
                    <span className="text-gray-400 font-normal">(Optional)</span>
                  )}
                </label>
                <textarea
                  id="lost-reason-note"
                  rows={3}
                  maxLength={500}
                  value={lostReasonNote}
                  onChange={(e) => setLostReasonNote(e.target.value)}
                  placeholder={
                    selectedLostReason === 'OTHER'
                      ? 'Provide a clear explanation (min 5 characters)…'
                      : 'Optional details (e.g., competitor price gap, lead-time constraint)…'
                  }
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-brand-500"
                />
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-gray-100">
              <Button
                variant="secondary"
                size="sm"
                onClick={closeLostModal}
                disabled={submittingRfqId === lostModalRfq._id}
              >
                Cancel
              </Button>
              <Button
                variant="danger"
                size="sm"
                onClick={() => void handleConfirmLost()}
                disabled={submittingRfqId === lostModalRfq._id}
              >
                {submittingRfqId === lostModalRfq._id ? 'Saving…' : 'Confirm Mark as Lost'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
