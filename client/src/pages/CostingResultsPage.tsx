import { useState } from 'react';
import { Link, Navigate, useLocation, useNavigate, useParams } from 'react-router-dom';
import { AlertCircle, ArrowLeft, ArrowRight, CheckCircle2, ChevronRight } from 'lucide-react';
import { costingApi } from '../api';
import { CostingFormInputs, CostingPreviewResult, VolumeTier, QuoteSummary } from '../types';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { useAuth } from '../context/AuthContext';
// ─── Formatting helpers ───────────────────────────────────────────────────────

function fmt(str: string, decimals = 2): string {
  const n = parseFloat(str);
  if (isNaN(n)) return str;
  return '₹' + n.toLocaleString('en-IN', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function fmtVol(n: number): string {
  return n.toLocaleString('en-IN');
}

// ─── Cost breakdown table ─────────────────────────────────────────────────────

type BreakdownRow = {
  label: string;
  value: string;
  highlight?: boolean;
  separator?: boolean;
};

function buildRows(bd: CostingPreviewResult['breakdown']): BreakdownRow[] {
  return [
    { label: 'Material', value: bd.materialCost },
    { label: 'Scrap', value: bd.scrapCost },
    { label: 'Conversion', value: bd.conversionCost },
    { label: 'Overhead', value: bd.overheadCost },
    { label: 'Packing & Freight', value: bd.packingFreight },
    { label: 'Setup Allocation', value: bd.setupAllocationPerPiece },
    { label: 'Total Cost', value: bd.totalCost, highlight: true },
    { label: 'Selling Price (Ex-GST)', value: bd.sellingPriceExGst, highlight: true },
    { label: 'GST', value: bd.gstAmount },
    { label: 'Selling Price (Incl. GST)', value: bd.sellingPriceIncludingGst, highlight: true },
  ];
}

// ─── Tier card ────────────────────────────────────────────────────────────────

function TierCard({ tier, isBase }: { tier: VolumeTier; isBase: boolean }) {
  return (
    <div
      className={[
        'rounded-lg border p-4 flex flex-col gap-3',
        isBase
          ? 'border-brand-500 ring-2 ring-brand-500 bg-brand-50'
          : 'border-gray-200 bg-white',
      ].join(' ')}
    >
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold text-gray-700">{tier.tierName}</span>
        <Badge variant={isBase ? 'blue' : 'default'}>{tier.tierPercentage}%</Badge>
      </div>
      <div className="text-xs text-gray-500">Volume: {fmtVol(tier.tierVolume)} pcs</div>
      <div className="space-y-1 text-sm">
        <div className="flex justify-between">
          <span className="text-gray-600">Ex-GST</span>
          <span className="tabular font-medium text-gray-900">{fmt(tier.sellingPriceExGst)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-gray-600">GST</span>
          <span className="tabular text-gray-500">{fmt(tier.gstAmount)}</span>
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
}

// ─── Saved quote panel ────────────────────────────────────────────────────────

function SavedQuotePanel({
  quote,
  rfqId,
  approvalRequired,
}: {
  quote: QuoteSummary;
  rfqId: string;
  approvalRequired: boolean;
}) {
  return (
    <div className="bg-green-50 border border-green-200 rounded-lg p-5 space-y-3">
      <div className="flex items-center gap-2">
        <CheckCircle2 className="w-4 h-4 text-green-700 shrink-0" strokeWidth={1.8} />
        <span className="text-green-700 font-semibold text-sm">
          Quote v{quote.version} saved successfully
        </span>
        <Badge variant="gray">DRAFT</Badge>
      </div>
      <dl className="grid grid-cols-2 gap-3 text-sm">
        <div>
          <dt className="text-gray-500">Annual Quotation Value</dt>
          <dd className="mt-0.5 tabular font-semibold text-gray-900">
            {fmt(quote.annualQuotationValue)}
          </dd>
        </div>
        <div>
          <dt className="text-gray-500">Approval Requirement</dt>
          <dd className="mt-0.5">
            {approvalRequired ? (
              <Badge variant="yellow">Sales Head Approval Required</Badge>
            ) : (
              <Badge variant="green">No Approval Required</Badge>
            )}
          </dd>
        </div>
      </dl>
      <Link
        to={`/rfqs/${rfqId}`}
        className="inline-flex items-center gap-1.5 text-sm text-brand-600 hover:underline font-medium"
      >
        <span>View RFQ</span>
        <ArrowRight className="w-4 h-4 shrink-0" strokeWidth={1.8} />
      </Link>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

interface LocationState {
  preview: CostingPreviewResult;
  formInputs: CostingFormInputs;
}

export function CostingResultsPage() {
  const { rfqId, partId } = useParams<{ rfqId: string; partId: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const { user } = useAuth();

  const state = location.state as LocationState | null;

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [savedQuote, setSavedQuote] = useState<QuoteSummary | null>(null);

  // Day 4: submit-for-approval state
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [submitted, setSubmitted] = useState(false);

  if (!state?.preview) {
    return <Navigate to={`/rfqs/${rfqId}/parts/${partId}/costing`} replace />;
  }

  const { preview, formInputs } = state;
  const { breakdown, volumeTiers, annualQuotationValue, approvalDecision } = preview;

  const baseTierIndex = volumeTiers.findIndex((t) => t.tierPercentage === 100);

  async function handleSave() {
    if (!rfqId) return;
    setSaving(true);
    setSaveError('');

    try {
      const res = await costingApi.saveQuote(rfqId, formInputs);
      setSavedQuote(res.data.data);
    } catch (err: unknown) {
      setSaveError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  async function handleSubmit() {
    if (!rfqId || !savedQuote) return;
    setSubmitting(true);
    setSubmitError('');
    try {
      await costingApi.submitQuote(rfqId, savedQuote._id);
      setSubmitted(true);
    } catch (err: unknown) {
      setSubmitError(err instanceof Error ? err.message : 'Submit failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-6 max-w-4xl">
      {/* Breadcrumb */}
      <div className="flex items-center gap-1.5 text-sm">
        <Link to="/rfqs" className="text-brand-600 hover:underline">RFQ Register</Link>
        <ChevronRight className="w-3.5 h-3.5 text-gray-400 shrink-0" strokeWidth={1.8} />
        <Link to={`/rfqs/${rfqId}`} className="text-brand-600 hover:underline">RFQ</Link>
        <ChevronRight className="w-3.5 h-3.5 text-gray-400 shrink-0" strokeWidth={1.8} />
        <Link to={`/rfqs/${rfqId}/parts/${partId}/costing`} className="text-brand-600 hover:underline">
          Part Costing
        </Link>
        <ChevronRight className="w-3.5 h-3.5 text-gray-400 shrink-0" strokeWidth={1.8} />
        <span className="text-gray-600">Results</span>
      </div>

      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-gray-900">Costing Results</h1>
        <span className="text-xs text-gray-400 tabular">
          Costing Date: {new Date(preview.costingDate).toLocaleDateString('en-IN', {
            day: '2-digit', month: 'short', year: 'numeric',
          })}
        </span>
      </div>

      {/* COST BREAKDOWN */}
      <section className="bg-white border border-gray-200 rounded-lg overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-100">
          <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
            Cost Breakdown — Per Piece (Base Tier)
          </h2>
        </div>
        <table className="w-full text-sm">
          <tbody>
            {buildRows(breakdown).map((row) => (
              <tr
                key={row.label}
                className={[
                  'border-b border-gray-100 last:border-0',
                  row.highlight ? 'bg-brand-50' : 'hover:bg-gray-50',
                ].join(' ')}
              >
                <td
                  className={[
                    'px-5 py-2.5',
                    row.highlight ? 'font-semibold text-gray-800' : 'text-gray-600',
                  ].join(' ')}
                >
                  {row.label}
                </td>
                <td
                  className={[
                    'px-5 py-2.5 text-right tabular',
                    row.highlight ? 'font-semibold text-gray-900' : 'text-gray-700',
                    row.label === 'Selling Price (Incl. GST)'
                      ? 'text-brand-700 font-bold text-base'
                      : '',
                  ].join(' ')}
                >
                  {fmt(row.value)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {/* VOLUME TIERS */}
      <section>
        <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">
          Volume Tiers
        </h2>
        <div className="grid grid-cols-3 gap-4">
          {volumeTiers.map((tier, i) => (
            <TierCard key={tier.tierName} tier={tier} isBase={i === baseTierIndex} />
          ))}
        </div>
      </section>

      {/* ANNUAL QUOTATION VALUE */}
      <section className="bg-white border border-gray-200 rounded-lg px-5 py-4">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
              Annual Quotation Value
            </p>
            <p className="mt-1 text-2xl font-bold tabular text-gray-900">
              {fmt(annualQuotationValue)}
            </p>
            <p className="mt-0.5 text-xs text-gray-400">
              Base tier (Ex-GST) × Annual Volume · Threshold: ₹25,00,000
            </p>
          </div>
          <div className="shrink-0">
            {approvalDecision.requiresApproval ? (
              <Badge variant="yellow" className="text-sm px-3 py-1">
                Sales Head Approval Required
              </Badge>
            ) : (
              <Badge variant="green" className="text-sm px-3 py-1">
                No Approval Required
              </Badge>
            )}
          </div>
        </div>
      </section>

      {/* Saved quote confirmation */}
      {savedQuote && (
        <SavedQuotePanel
          quote={savedQuote}
          rfqId={rfqId!}
          approvalRequired={approvalDecision.requiresApproval}
        />
      )}

      {/* Submit for approval — shown after save, before submission */}
      {savedQuote && !submitted && user?.role === 'ESTIMATOR' && (
        <div className="flex items-center gap-3 flex-wrap">
          <Button
            variant="primary"
            size="md"
            loading={submitting}
            onClick={handleSubmit}
          >
            Submit for Approval
          </Button>
          {submitError && (
            <span className="text-sm text-red-600">{submitError}</span>
          )}
        </div>
      )}

      {/* Submitted confirmation banner */}
      {submitted && (
        <div className="p-4 rounded bg-blue-50 border border-blue-200 text-sm text-blue-700 flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 text-blue-700 shrink-0" strokeWidth={1.8} />
          <span>
            Quote submitted.{' '}
            {approvalDecision.requiresApproval
              ? 'It is now pending Sales Head approval.'
              : 'It is ready for sales (no approval required).'}
          </span>
        </div>
      )}

      {/* Save error */}
      {saveError && (
        <div className="p-4 rounded bg-red-50 border border-red-200 text-sm text-red-700 flex items-center gap-2">
          <AlertCircle className="w-4 h-4 shrink-0" strokeWidth={1.8} />
          <span>{saveError}</span>
        </div>
      )}

      {/* Actions */}
      {!savedQuote && (
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="md"
            onClick={() => navigate(-1)}
          >
            <ArrowLeft className="w-4 h-4 shrink-0" strokeWidth={1.8} />
            <span>Revise Inputs</span>
          </Button>

          {user?.role === 'ESTIMATOR' && (
            <Button
              variant="primary"
              size="lg"
              loading={saving}
              onClick={handleSave}
            >
              Save Draft Quote
            </Button>
          )}
        </div>
      )}

      {savedQuote && (
        <Button
          variant="secondary"
          size="md"
          onClick={() => navigate(`/rfqs/${rfqId}/parts/${partId}/costing`)}
        >
          Create Another Revision
        </Button>
      )}
    </div>
  );
}

