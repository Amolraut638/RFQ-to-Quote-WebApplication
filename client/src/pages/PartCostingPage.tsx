import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  AlertCircle,
  AlertTriangle,
  ArrowLeft,
  Boxes,
  Calculator,
  CheckCircle2,
  ChevronRight,
  History,
  Package,
  Plus,
  Settings,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { costingApi, partApi } from '../api';
import {
  CostingContext,
  MachineOption,
  RoutingOperationInput,
  CostingFormInputs,
  RoutingSuggestionResult,
  HistoricalQuoteMatch,
  HistoricalQuoteComparisonResult,
  ComparisonRow,
} from '../types';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { Badge } from '../components/ui/Badge';

// ─── Routing operation row state ──────────────────────────────────────────────

interface OpRow extends RoutingOperationInput {
  id: string; // local key for React
}

function newOpRow(machine: string): OpRow {
  return {
    id: Math.random().toString(36).slice(2),
    operationName: '',
    machine,
    cycleTimeMinutes: 0,
  };
}

// ─── Component ────────────────────────────────────────────────────────────────

export function PartCostingPage() {
  const { rfqId, partId } = useParams<{ rfqId: string; partId: string }>();
  const navigate = useNavigate();

  const [context, setContext] = useState<CostingContext | null>(null);
  const [loading, setLoading] = useState(true);
  const [contextError, setContextError] = useState('');

  // Form state — initialised from context once loaded
  const [ops, setOps] = useState<OpRow[]>([]);
  const [scrapPct, setScrapPct] = useState('');
  const [overheadPct, setOverheadPct] = useState('');
  const [packingFreight, setPackingFreight] = useState('');
  const [setupCost, setSetupCost] = useState('');
  const [marginPct, setMarginPct] = useState('');
  const [gstPct, setGstPct] = useState('');
  const [costingDate, setCostingDate] = useState(
    () => new Date().toISOString().split('T')[0],
  );

  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState('');

  // Historical routing suggestion state
  const [routingSuggestion, setRoutingSuggestion] = useState<RoutingSuggestionResult | null>(null);
  const [suggestionLoading, setSuggestionLoading] = useState(false);
  const [suggestionError, setSuggestionError] = useState('');
  const [suggestionAccepted, setSuggestionAccepted] = useState(false);

  // Historical Quote Comparison state (read-only)
  const [historicalMatches, setHistoricalMatches] = useState<HistoricalQuoteMatch[]>([]);
  const [historicalWeightTolPct, setHistoricalWeightTolPct] = useState<number>(35);
  const [historicalSearchLoading, setHistoricalSearchLoading] = useState(false);
  const [historicalSearchError, setHistoricalSearchError] = useState('');
  const [selectedHistoricalQuoteId, setSelectedHistoricalQuoteId] = useState<string | null>(null);
  const [comparisonTier, setComparisonTier] = useState<50 | 100 | 150>(100);
  const [comparisonResult, setComparisonResult] = useState<HistoricalQuoteComparisonResult | null>(
    null,
  );
  const [comparisonLoading, setComparisonLoading] = useState(false);
  const [comparisonError, setComparisonError] = useState('');

  function loadRoutingSuggestion() {
    if (!partId) return;
    setSuggestionLoading(true);
    setSuggestionError('');
    partApi
      .getRoutingSuggestions(partId)
      .then((res) => setRoutingSuggestion(res.data.data))
      .catch((err: Error) => setSuggestionError(err.message))
      .finally(() => setSuggestionLoading(false));
  }

  function loadHistoricalQuotes() {
    if (!partId) return;
    setHistoricalSearchLoading(true);
    setHistoricalSearchError('');
    partApi
      .getHistoricalQuotes(partId)
      .then((res) => {
        setHistoricalMatches(res.data.data.matches);
        setHistoricalWeightTolPct(res.data.data.weightTolerancePct);
      })
      .catch((err: Error) => setHistoricalSearchError(err.message))
      .finally(() => setHistoricalSearchLoading(false));
  }

  async function handleCompareHistoricalQuote(
    quoteId: string,
    tierOverride?: 50 | 100 | 150,
  ) {
    if (!rfqId || !partId) return;
    if (!validate()) {
      setComparisonError(
        'Please complete valid routing operations and costing inputs above before comparing.',
      );
      return;
    }

    const activeTier = tierOverride ?? comparisonTier;
    setSelectedHistoricalQuoteId(quoteId);
    setComparisonTier(activeTier);
    setComparisonLoading(true);
    setComparisonError('');

    try {
      const res = await partApi.compareHistoricalQuote(partId, quoteId, {
        rfqId,
        routingOperations: ops.map((op) => ({
          operationName: op.operationName,
          machine: op.machine,
          cycleTimeMinutes: Number(op.cycleTimeMinutes),
        })),
        scrapPct: parseFloat(scrapPct),
        overheadPct: parseFloat(overheadPct),
        packingFreight: parseFloat(packingFreight),
        setupCost: parseFloat(setupCost),
        marginPct: parseFloat(marginPct),
        gstPct: parseFloat(gstPct),
        costingDate,
        tierPercentage: activeTier,
      });
      setComparisonResult(res.data.data);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Comparison failed';
      setComparisonError(msg);
    } finally {
      setComparisonLoading(false);
    }
  }

  function acceptRoutingSuggestion() {
    if (!routingSuggestion || !routingSuggestion.hasSuggestion) return;
    setOps(
      routingSuggestion.suggestedOperations.map((so, idx) => ({
        id: `sug-${idx}-${Date.now()}`,
        operationName: so.operationName,
        machine: so.machine,
        cycleTimeMinutes: so.cycleTimeMinutes,
      })),
    );
    setSuggestionAccepted(true);
  }

  // Load context on mount
  useEffect(() => {
    if (!rfqId || !partId) return;
    costingApi
      .getContext(rfqId, partId, costingDate)
      .then((res) => {
        const ctx = res.data.data;
        setContext(ctx);
        // Pre-fill defaults
        setScrapPct(String(ctx.rateSettings.scrapPct));
        setOverheadPct(String(ctx.rateSettings.overheadPct));
        setPackingFreight(ctx.rateSettings.packingFreight);
        setSetupCost(ctx.rateSettings.setupCostPerPart);
        setMarginPct(String(ctx.rateSettings.defaultMarginPct));
        setGstPct(String(ctx.rateSettings.gstPct));
        // Default first operation
        const firstMachine = ctx.availableMachines[0]?.machine ?? '';
        const preloadedCycle = ctx.part.cycleTimeMinutes
          ? String(ctx.part.cycleTimeMinutes)
          : '';
        setOps([
          {
            id: 'op-0',
            operationName: 'Turning',
            machine: firstMachine,
            cycleTimeMinutes: ctx.part.cycleTimeMinutes ?? 0,
          },
        ]);
        void preloadedCycle; // suppress unused warning
        // Also fetch AI-assisted historical routing suggestion & historical quote matches
        loadRoutingSuggestion();
        loadHistoricalQuotes();
      })
      .catch((err: Error) => setContextError(err.message))
      .finally(() => setLoading(false));
  }, [rfqId, partId]); // intentionally omit costingDate to avoid re-fetch on date change

  function getMachineInfo(machine: string): MachineOption | undefined {
    return context?.availableMachines.find((m) => m.machine === machine);
  }

  // ─── Operation row handlers ─────────────────────────────────────────────────

  function addOp() {
    const firstMachine = context?.availableMachines[0]?.machine ?? '';
    setOps((prev) => [...prev, newOpRow(firstMachine)]);
  }

  function removeOp(id: string) {
    setOps((prev) => prev.filter((op) => op.id !== id));
  }

  function updateOp(id: string, field: keyof Omit<OpRow, 'id'>, value: string | number) {
    setOps((prev) =>
      prev.map((op) =>
        op.id === id ? { ...op, [field]: value } : op,
      ),
    );
  }

  // ─── Validation ─────────────────────────────────────────────────────────────

  function validate(): boolean {
    const errs: Record<string, string> = {};

    if (ops.length === 0) {
      errs.ops = 'At least one routing operation is required';
    }
    ops.forEach((op, i) => {
      if (!op.operationName.trim()) errs[`op_${i}_name`] = 'Operation name is required';
      if (!op.machine) errs[`op_${i}_machine`] = 'Machine is required';
      if (!op.cycleTimeMinutes || op.cycleTimeMinutes <= 0)
        errs[`op_${i}_cycle`] = 'Cycle time must be > 0';
    });

    const numFields: [string, string, number, number][] = [
      ['scrapPct', scrapPct, 0, 100],
      ['overheadPct', overheadPct, 0, 1000],
      ['packingFreight', packingFreight, 0, Infinity],
      ['setupCost', setupCost, 0, Infinity],
      ['marginPct', marginPct, 0, 100],
      ['gstPct', gstPct, 0, 100],
    ];
    for (const [key, val, min, max] of numFields) {
      const n = parseFloat(val);
      if (isNaN(n) || n < min || n > max) {
        errs[key] = `Must be a number between ${min} and ${max === Infinity ? '∞' : max}`;
      }
    }

    setFormErrors(errs);
    return Object.keys(errs).length === 0;
  }

  // ─── Preview submit ──────────────────────────────────────────────────────────

  async function handlePreview() {
    if (!validate() || !rfqId || !partId) return;

    setPreviewLoading(true);
    setPreviewError('');

    const formInputs: CostingFormInputs = {
      partId,
      routingOperations: ops.map((op) => ({
        operationName: op.operationName,
        machine: op.machine,
        cycleTimeMinutes: Number(op.cycleTimeMinutes),
      })),
      scrapPct: parseFloat(scrapPct),
      overheadPct: parseFloat(overheadPct),
      packingFreight: parseFloat(packingFreight),
      setupCost: parseFloat(setupCost),
      marginPct: parseFloat(marginPct),
      gstPct: parseFloat(gstPct),
      costingDate,
    };

    try {
      const res = await costingApi.preview(rfqId, formInputs);
      navigate(`/rfqs/${rfqId}/parts/${partId}/results`, {
        state: { preview: res.data.data, formInputs },
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Preview failed';
      setPreviewError(msg);
    } finally {
      setPreviewLoading(false);
    }
  }

  // ─── Render ──────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-sm text-gray-400">
        Loading costing context…
      </div>
    );
  }

  if (contextError) {
    return (
      <div className="space-y-4">
        <Link
          to={`/rfqs/${rfqId}`}
          className="inline-flex items-center gap-1.5 text-sm text-brand-600 hover:underline"
        >
          <ArrowLeft className="w-4 h-4 shrink-0" strokeWidth={1.8} />
          <span>Back to RFQ</span>
        </Link>
        <div className="p-4 rounded bg-red-50 border border-red-200 text-sm text-red-700 flex items-start gap-2.5">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" strokeWidth={1.8} />
          <div>
            <p className="font-medium">Cannot load costing context</p>
            <p className="mt-1">{contextError}</p>
          </div>
        </div>
      </div>
    );
  }

  if (!context) return null;

  const { part, materialRate, rateSettings, availableMachines } = context;

  return (
    <div className="space-y-6 max-w-4xl">
      {/* Breadcrumb */}
      <div className="flex items-center gap-1.5 text-sm">
        <Link to="/rfqs" className="text-brand-600 hover:underline">RFQ Register</Link>
        <ChevronRight className="w-3.5 h-3.5 text-gray-400 shrink-0" strokeWidth={1.8} />
        <Link to={`/rfqs/${rfqId}`} className="text-brand-600 hover:underline">
          {context.rfq.rfqNo}
        </Link>
        <ChevronRight className="w-3.5 h-3.5 text-gray-400 shrink-0" strokeWidth={1.8} />
        <span className="text-gray-600">Cost Part</span>
      </div>

      <div className="flex items-center gap-2">
        <Calculator className="w-5 h-5 text-brand-600 shrink-0" strokeWidth={1.8} />
        <h1 className="text-lg font-semibold text-gray-900">Part Costing</h1>
      </div>

      {/* PART INFORMATION */}
      <section className="bg-white border border-gray-200 rounded-lg">
        <div className="px-5 py-3 border-b border-gray-100 flex items-center gap-2">
          <Package className="w-4 h-4 text-gray-400 shrink-0" strokeWidth={1.8} />
          <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
            Part Information
          </h2>
        </div>
        <dl className="px-5 py-4 grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
          <div>
            <dt className="text-gray-500">Part Name</dt>
            <dd className="mt-0.5 font-medium text-gray-900">{part.partName}</dd>
          </div>
          <div>
            <dt className="text-gray-500">Material</dt>
            <dd className="mt-0.5 font-medium text-gray-900">{part.material}</dd>
          </div>
          <div>
            <dt className="text-gray-500">Gross Weight</dt>
            <dd className="mt-0.5 tabular font-medium text-gray-900">
              {part.grossWeightKg.toFixed(3)} kg
            </dd>
          </div>
          <div>
            <dt className="text-gray-500">Annual Volume</dt>
            <dd className="mt-0.5 tabular font-medium text-gray-900">
              {part.annualVolume.toLocaleString('en-IN')} pcs
            </dd>
          </div>
        </dl>
      </section>

      {/* MATERIAL COSTING */}
      <section className="bg-white border border-gray-200 rounded-lg">
        <div className="px-5 py-3 border-b border-gray-100 flex items-center gap-2">
          <Boxes className="w-4 h-4 text-gray-400 shrink-0" strokeWidth={1.8} />
          <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
            Material Costing
          </h2>
        </div>
        <dl className="px-5 py-4 grid grid-cols-2 gap-4 text-sm">
          <div>
            <dt className="text-gray-500">Material Rate</dt>
            <dd className="mt-0.5 tabular font-medium text-gray-900">
              ₹{parseFloat(materialRate.ratePerKg).toFixed(2)} / kg
            </dd>
          </div>
          <div>
            <dt className="text-gray-500">Rate Effective From</dt>
            <dd className="mt-0.5 text-gray-700">
              {new Date(materialRate.effectiveFrom).toLocaleDateString('en-IN', {
                day: '2-digit',
                month: 'short',
                year: 'numeric',
              })}
            </dd>
          </div>
        </dl>
      </section>

      {/* HISTORICAL ROUTING SUGGESTION */}
      <section className="bg-white border border-gray-200 rounded-lg">
        <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-brand-600 shrink-0" strokeWidth={1.8} />
            <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
              AI Historical Routing Suggestion
            </h2>
            {routingSuggestion && (
              <span className="text-xs text-gray-400 font-mono">
                ({routingSuggestion.provider}/{routingSuggestion.model})
              </span>
            )}
          </div>
          <Button
            variant="secondary"
            size="sm"
            loading={suggestionLoading}
            onClick={loadRoutingSuggestion}
          >
            Refresh Suggestion
          </Button>
        </div>

        <div className="px-5 py-4 text-sm space-y-3">
          {suggestionLoading && (
            <p className="text-xs text-gray-500">
              Checking historical parts & quotes for matching material ({part.material})…
            </p>
          )}

          {!suggestionLoading && suggestionError && (
            <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2">
              Routing suggestion unavailable: {suggestionError}
            </p>
          )}

          {!suggestionLoading && !suggestionError && routingSuggestion && (
            <>
              {routingSuggestion.hasSuggestion ? (
                <div className="space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="space-y-0.5">
                      <p className="font-medium text-gray-900">
                        Based on Historical Part:{' '}
                        <span className="font-semibold">
                          {routingSuggestion.historicalPartName}
                        </span>{' '}
                        (RFQ{' '}
                        <span className="font-mono">{routingSuggestion.historicalRFQNo}</span>,
                        Quote{' '}
                        <span className="font-mono">
                          v{routingSuggestion.historicalQuoteVersion}
                        </span>
                        )
                      </p>
                      <p className="text-xs text-gray-600">{routingSuggestion.reason}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      {suggestionAccepted && <Badge variant="green">Applied to Routing</Badge>}
                      <Button size="sm" onClick={acceptRoutingSuggestion}>
                        {suggestionAccepted
                          ? 'Re-apply Suggested Routing'
                          : 'Accept & Prefill Routing'}
                      </Button>
                    </div>
                  </div>

                  <div className="border border-gray-200 rounded overflow-hidden">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>#</th>
                          <th>Suggested Operation</th>
                          <th>Machine</th>
                          <th>Historical Cycle Time (min)</th>
                        </tr>
                      </thead>
                      <tbody>
                        {routingSuggestion.suggestedOperations.map((so, idx) => (
                          <tr key={idx}>
                            <td className="text-xs text-gray-500">{idx + 1}</td>
                            <td className="font-medium text-gray-900">{so.operationName}</td>
                            <td className="text-gray-700">{so.machine}</td>
                            <td className="tabular font-mono text-gray-900">
                              {so.cycleTimeMinutes}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : (
                <p className="text-xs text-gray-500">{routingSuggestion.reason}</p>
              )}
            </>
          )}
        </div>
      </section>

      {/* ROUTING OPERATIONS */}
      <section className="bg-white border border-gray-200 rounded-lg">
        <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Settings className="w-4 h-4 text-gray-400 shrink-0" strokeWidth={1.8} />
            <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
              Routing Operations
            </h2>
          </div>
          <Button variant="secondary" size="sm" onClick={addOp}>
            <Plus className="w-3.5 h-3.5 shrink-0" strokeWidth={1.8} />
            <span>Add Operation</span>
          </Button>
        </div>

        {formErrors.ops && (
          <p className="px-5 pt-3 text-xs text-red-600">{formErrors.ops}</p>
        )}

        <div className="divide-y divide-gray-100">
          {ops.map((op, i) => {
            const machineInfo = getMachineInfo(op.machine);
            return (
              <div key={op.id} className="px-5 py-4 grid grid-cols-1 sm:grid-cols-4 gap-3 items-start">
                <Input
                  label="Operation Name"
                  value={op.operationName}
                  onChange={(e) => updateOp(op.id, 'operationName', e.target.value)}
                  error={formErrors[`op_${i}_name`]}
                  placeholder="e.g. Turning"
                />

                <div className="flex flex-col gap-1">
                  <label className="text-sm font-medium text-gray-700">Machine</label>
                  <select
                    value={op.machine}
                    onChange={(e) => updateOp(op.id, 'machine', e.target.value)}
                    className="block w-full rounded border border-gray-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
                  >
                    {availableMachines.length === 0 && (
                      <option value="">No machines available</option>
                    )}
                    {availableMachines.map((m) => (
                      <option key={m.machine} value={m.machine}>
                        {m.machine}
                      </option>
                    ))}
                  </select>
                  {formErrors[`op_${i}_machine`] && (
                    <p className="text-xs text-red-600">{formErrors[`op_${i}_machine`]}</p>
                  )}
                  {machineInfo && (
                    <p className="text-xs text-gray-500 tabular">
                      ₹{parseFloat(machineInfo.hourRate).toFixed(2)}/hr ·{' '}
                      {new Date(machineInfo.effectiveFrom).toLocaleDateString('en-IN', {
                        month: 'short',
                        year: 'numeric',
                      })}
                    </p>
                  )}
                </div>

                <Input
                  label="Cycle Time (min)"
                  type="number"
                  min="0"
                  step="0.1"
                  value={op.cycleTimeMinutes || ''}
                  onChange={(e) =>
                    updateOp(op.id, 'cycleTimeMinutes', parseFloat(e.target.value) || 0)
                  }
                  error={formErrors[`op_${i}_cycle`]}
                  placeholder="e.g. 3.2"
                />

                <div className="flex items-end pb-0.5">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={ops.length === 1}
                    onClick={() => removeOp(op.id)}
                    aria-label={`Remove operation ${i + 1}`}
                    title="Remove routing operation"
                    className="text-red-500 hover:text-red-700 disabled:text-gray-300"
                  >
                    <Trash2 className="w-3.5 h-3.5 shrink-0" strokeWidth={1.8} />
                    <span>Remove</span>
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* OTHER COSTING INPUTS */}
      <section className="bg-white border border-gray-200 rounded-lg">
        <div className="px-5 py-3 border-b border-gray-100">
          <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
            Other Costing Inputs
          </h2>
          <p className="mt-0.5 text-xs text-gray-400">
            Pre-filled from rate settings effective{' '}
            {new Date(rateSettings.effectiveFrom).toLocaleDateString('en-IN', {
              month: 'short',
              year: 'numeric',
            })}
            . Edit to override.
          </p>
        </div>
        <div className="px-5 py-4 grid grid-cols-2 sm:grid-cols-3 gap-4">
          <Input
            label="Scrap %"
            type="number"
            min="0"
            max="100"
            step="0.1"
            value={scrapPct}
            onChange={(e) => setScrapPct(e.target.value)}
            error={formErrors.scrapPct}
          />
          <Input
            label="Overhead %"
            type="number"
            min="0"
            step="1"
            value={overheadPct}
            onChange={(e) => setOverheadPct(e.target.value)}
            error={formErrors.overheadPct}
          />
          <Input
            label="Packing & Freight (₹/pc)"
            type="number"
            min="0"
            step="0.01"
            value={packingFreight}
            onChange={(e) => setPackingFreight(e.target.value)}
            error={formErrors.packingFreight}
          />
          <Input
            label="Setup Cost per Part (₹)"
            type="number"
            min="0"
            step="0.01"
            value={setupCost}
            onChange={(e) => setSetupCost(e.target.value)}
            error={formErrors.setupCost}
          />
          <Input
            label="Margin %"
            type="number"
            min="0"
            max="100"
            step="0.1"
            value={marginPct}
            onChange={(e) => setMarginPct(e.target.value)}
            error={formErrors.marginPct}
          />
          <Input
            label="GST %"
            type="number"
            min="0"
            max="100"
            step="0.1"
            value={gstPct}
            onChange={(e) => setGstPct(e.target.value)}
            error={formErrors.gstPct}
          />
        </div>
      </section>

      {/* COSTING DATE */}
      <section className="bg-white border border-gray-200 rounded-lg px-5 py-4">
        <div className="max-w-xs">
          <Input
            label="Costing Date"
            type="date"
            value={costingDate}
            onChange={(e) => setCostingDate(e.target.value)}
          />
          <p className="mt-1 text-xs text-gray-400">
            Rates effective on this date will be used for lookup.
          </p>
        </div>
      </section>

      {/* HISTORICAL QUOTE COMPARISON (STRICTLY READ-ONLY) */}
      <section className="bg-white border border-gray-200 rounded-lg">
        <div className="px-5 py-3 border-b border-gray-100 flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="flex items-center gap-2">
              <History className="w-4 h-4 text-gray-400 shrink-0" strokeWidth={1.8} />
              <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
                Historical Quote Comparison
              </h2>
              <Badge variant="gray">Read-Only Snapshot</Badge>
            </div>
            <p className="mt-0.5 text-xs text-gray-400">
              Deterministic match against frozen historical quote snapshots (weight tolerance: ±
              {historicalWeightTolPct}%). Does not modify current inputs.
            </p>
          </div>
          <Button
            variant="secondary"
            size="sm"
            loading={historicalSearchLoading}
            onClick={loadHistoricalQuotes}
          >
            Refresh Matches
          </Button>
        </div>

        <div className="px-5 py-4 space-y-5 text-sm">
          {historicalSearchLoading && (
            <p className="text-xs text-gray-500">
              Searching historical quote snapshots for similar parts…
            </p>
          )}

          {!historicalSearchLoading && historicalSearchError && (
            <div className="p-3 rounded bg-red-50 border border-red-200 text-xs text-red-700">
              Failed to load historical quotes: {historicalSearchError}
            </div>
          )}

          {!historicalSearchLoading &&
            !historicalSearchError &&
            historicalMatches.length === 0 && (
              <p className="text-xs text-gray-500">
                No matching historical quotes found for this part&apos;s drawing number, material (
                {part.material}), weight ({part.grossWeightKg.toFixed(3)} kg), or name.
              </p>
            )}

          {!historicalSearchLoading &&
            !historicalSearchError &&
            historicalMatches.length > 0 && (
              <div className="space-y-4">
                <div className="border border-gray-200 rounded overflow-x-auto">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Historical Part &amp; Drawing</th>
                        <th>Customer &amp; RFQ</th>
                        <th>Quote Snapshot</th>
                        <th>Spec (Material / Wt)</th>
                        <th className="text-right">100% Price / pc</th>
                        <th className="text-right">Annual Vol / Value</th>
                        <th>Match Basis</th>
                        <th className="text-right">Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {historicalMatches.map((m) => {
                        const isSelected = selectedHistoricalQuoteId === m.quoteId;
                        return (
                          <tr
                            key={m.quoteId}
                            className={isSelected ? 'bg-brand-50/50' : undefined}
                          >
                            <td>
                              <div className="font-medium text-gray-900">
                                {m.historicalPartName}
                              </div>
                              <div className="text-xs text-gray-500 font-mono">
                                {m.drawingNumber ? `Dwg: ${m.drawingNumber}` : 'No Drawing #'}
                              </div>
                            </td>
                            <td>
                              <div className="text-gray-900">{m.customerName}</div>
                              <div className="text-xs text-gray-500 font-mono">{m.rfqNo}</div>
                            </td>
                            <td>
                              <div className="flex flex-wrap items-center gap-1.5">
                                <span className="font-mono font-semibold text-gray-900">
                                  v{m.quoteVersion}
                                </span>
                                <Badge
                                  variant={
                                    m.historicalQuoteStatus === 'APPROVED' ||
                                    m.historicalQuoteStatus === 'SENT'
                                      ? 'green'
                                      : m.historicalQuoteStatus === 'READY_FOR_SALES'
                                      ? 'blue'
                                      : 'yellow'
                                  }
                                >
                                  {m.historicalQuoteStatus}
                                </Badge>
                                {m.importSource === 'HISTORICAL_EXCEL' && (
                                  <Badge variant="yellow">
                                    {m.isSyntheticDemo ? 'Imported · Synthetic Demo' : 'Imported'}
                                  </Badge>
                                )}
                              </div>
                              <div className="text-xs text-gray-500 mt-0.5">
                                {new Date(m.quoteDate).toLocaleDateString('en-IN', {
                                  day: '2-digit',
                                  month: 'short',
                                  year: 'numeric',
                                })}
                              </div>
                              {m.priceDiscrepancyFlag && m.historicalStatedPriceExGst && (
                                <div className="text-[11px] text-amber-800 mt-0.5">
                                  Sheet Stated: ₹{m.historicalStatedPriceExGst}
                                </div>
                              )}
                            </td>
                            <td>
                              <div className="font-medium text-gray-900">{m.material}</div>
                              <div className="text-xs text-gray-500 tabular">
                                {m.partWeightKg.toFixed(3)} kg
                              </div>
                            </td>
                            <td className="text-right tabular font-medium text-gray-900">
                              ₹
                              {parseFloat(m.historicalPricePerPieceExGst).toLocaleString('en-IN', {
                                minimumFractionDigits: 2,
                                maximumFractionDigits: 2,
                              })}
                            </td>
                            <td className="text-right tabular">
                              <div className="text-gray-900">
                                {m.historicalAnnualVolume.toLocaleString('en-IN')} pcs
                              </div>
                              <div className="text-xs text-gray-500">
                                ₹
                                {parseFloat(m.historicalAnnualQuoteValue).toLocaleString('en-IN', {
                                  minimumFractionDigits: 2,
                                  maximumFractionDigits: 2,
                                })}
                              </div>
                            </td>
                            <td>
                              <div className="flex flex-wrap gap-1 max-w-xs">
                                {m.matchFlags.exactDrawingMatch && (
                                  <Badge variant="green">Exact Drawing</Badge>
                                )}
                                {m.matchFlags.sameMaterial && (
                                  <Badge variant="blue">Same Material</Badge>
                                )}
                                {m.matchFlags.similarWeight && (
                                  <Badge variant="yellow">
                                    Wt Δ {m.weightDifferencePct.toFixed(1)}%
                                  </Badge>
                                )}
                                {m.matchFlags.similarName && (
                                  <Badge variant="default">Similar Name</Badge>
                                )}
                              </div>
                              <p className="text-[11px] text-gray-500 mt-1">
                                {m.matchReasons.join(' · ')}
                              </p>
                            </td>
                            <td className="text-right">
                              <Button
                                variant={isSelected ? 'primary' : 'secondary'}
                                size="sm"
                                loading={comparisonLoading && isSelected}
                                onClick={() => handleCompareHistoricalQuote(m.quoteId)}
                              >
                                {isSelected ? 'Refresh Compare' : 'Select & Compare'}
                              </Button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                {comparisonError && (
                  <div className="p-3 rounded bg-red-50 border border-red-200 text-xs text-red-700 flex items-center gap-2">
                    <AlertCircle className="w-4 h-4 shrink-0" strokeWidth={1.8} />
                    <span>{comparisonError}</span>
                  </div>
                )}

                {comparisonResult && (
                  <div className="border border-gray-200 rounded-lg bg-gray-50/60 p-4 space-y-4">
                    {/* Comparison Header + Volume Tier Switcher */}
                    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-200 pb-3">
                      <div>
                        <h3 className="text-sm font-semibold text-gray-900">
                          Side-by-Side Comparison vs. {comparisonResult.historical.rfqNo} (v
                          {comparisonResult.historical.quoteVersion} —{' '}
                          {comparisonResult.historical.historicalPartName})
                        </h3>
                        <p className="text-xs text-gray-500">
                          Customer: {comparisonResult.historical.customerName} · Frozen on{' '}
                          {new Date(comparisonResult.historical.quoteDate).toLocaleDateString(
                            'en-IN',
                            { day: '2-digit', month: 'short', year: 'numeric' },
                          )}{' '}
                          · Status: {comparisonResult.historical.historicalQuoteStatus}
                        </p>
                      </div>

                      <div className="flex items-center gap-1.5">
                        <span className="text-xs text-gray-500 mr-1">Compare at Volume Tier:</span>
                        {([50, 100, 150] as const).map((tier) => (
                          <Button
                            key={tier}
                            size="sm"
                            variant={comparisonTier === tier ? 'primary' : 'secondary'}
                            disabled={comparisonLoading}
                            onClick={() => {
                              if (selectedHistoricalQuoteId) {
                                handleCompareHistoricalQuote(selectedHistoricalQuoteId, tier);
                              }
                            }}
                          >
                            {tier}% Tier
                          </Button>
                        ))}
                      </div>
                    </div>

                    {/* Equivalence Indicator / Warnings */}
                    {comparisonResult.isDirectlyEquivalent ? (
                      <div className="p-2.5 rounded bg-green-50 border border-green-200 text-xs text-green-800 flex items-center gap-2">
                        <CheckCircle2
                          className="w-4 h-4 text-green-700 shrink-0"
                          strokeWidth={1.8}
                        />
                        <Badge variant="green">Directly Equivalent</Badge>
                        <span>
                          Material grade, gross weight, annual volume, and rate percentages match at
                          the {comparisonResult.tierPercentage}% volume tier.
                        </span>
                      </div>
                    ) : (
                      <div className="p-3 rounded bg-amber-50 border border-amber-200 text-xs text-amber-800 space-y-1">
                        <div className="font-semibold flex items-center gap-2">
                          <AlertTriangle
                            className="w-4 h-4 text-amber-700 shrink-0"
                            strokeWidth={1.8}
                          />
                          <Badge variant="yellow">Equivalence Differences Noted</Badge>
                          <span>
                            Comparing at equivalent {comparisonResult.tierPercentage}% volume tier (
                            {comparisonResult.current.tierVolume.toLocaleString('en-IN')} pcs vs{' '}
                            {comparisonResult.historical.comparedTierVolume.toLocaleString('en-IN')}{' '}
                            pcs):
                          </span>
                        </div>
                        <ul className="list-disc list-inside space-y-0.5 pl-1">
                          {comparisonResult.equivalenceWarnings.map((w, idx) => (
                            <li key={idx}>{w}</li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {/* Historical Frozen Snapshot Metadata Summary */}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs bg-white border border-gray-200 rounded p-3">
                      <div className="space-y-1">
                        <div className="font-semibold text-gray-700 uppercase tracking-wider">
                          Historical Snapshot Rates (Read-Only)
                        </div>
                        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-gray-600">
                          <div>
                            Material ({comparisonResult.historical.material}):{' '}
                            <span className="font-medium text-gray-900 tabular">
                              ₹{comparisonResult.historical.historicalMaterialRate}/kg
                            </span>
                          </div>
                          <div>
                            Part Weight:{' '}
                            <span className="font-medium text-gray-900 tabular">
                              {comparisonResult.historical.partWeightKg.toFixed(3)} kg
                            </span>
                          </div>
                          <div>
                            Scrap %:{' '}
                            <span className="font-medium text-gray-900 tabular">
                              {comparisonResult.historical.historicalScrapPct}%
                            </span>
                          </div>
                          <div>
                            Overhead %:{' '}
                            <span className="font-medium text-gray-900 tabular">
                              {comparisonResult.historical.historicalOverheadPct}%
                            </span>
                          </div>
                          <div>
                            Margin %:{' '}
                            <span className="font-medium text-gray-900 tabular">
                              {comparisonResult.historical.historicalMarginPct}%
                            </span>
                          </div>
                          <div>
                            Setup Cost (Total):{' '}
                            <span className="font-medium text-gray-900 tabular">
                              ₹{comparisonResult.historical.historicalSetupCost}
                            </span>
                          </div>
                        </div>
                      </div>

                      <div className="space-y-1">
                        <div className="font-semibold text-gray-700 uppercase tracking-wider">
                          Historical Routing &amp; Machine Rates
                        </div>
                        <div className="space-y-1 max-h-28 overflow-y-auto">
                          {comparisonResult.historical.historicalRoutingOperations.map(
                            (op, idx) => (
                              <div
                                key={idx}
                                className="flex items-center justify-between text-gray-700 bg-gray-50 px-2 py-1 rounded"
                              >
                                <span>
                                  {idx + 1}. <strong className="text-gray-900">{op.operationName}</strong>{' '}
                                  ({op.machine})
                                </span>
                                <span className="tabular font-mono text-gray-800">
                                  {op.cycleTimeMinutes} min @ ₹{op.machineHourRate}/hr
                                </span>
                              </div>
                            ),
                          )}
                        </div>
                      </div>
                    </div>

                    {/* Side-by-Side Comparison Table */}
                    <div className="border border-gray-200 rounded bg-white overflow-x-auto">
                      <table className="data-table">
                        <thead>
                          <tr>
                            <th>Parameter</th>
                            <th className="text-right">Current Costing</th>
                            <th className="text-right">Historical Quote</th>
                            <th className="text-right">Absolute Diff</th>
                            <th className="text-right">% Diff</th>
                          </tr>
                        </thead>
                        <tbody>
                          {comparisonResult.rows.map((row: ComparisonRow) => {
                            const absNum = parseFloat(row.absoluteDifference);
                            const isZero = absNum === 0;
                            const isHighlightRow =
                              row.key === 'sellingPricePerPiece' ||
                              row.key === 'annualQuoteValue';

                            const formatVal = (val: string) => {
                              const n = parseFloat(val);
                              if (row.unit === 'PCS') {
                                return `${Math.round(n).toLocaleString('en-IN')} pcs`;
                              }
                              const formatted = n.toLocaleString('en-IN', {
                                minimumFractionDigits: 2,
                                maximumFractionDigits: 2,
                              });
                              if (row.unit === 'PCT') return `${formatted}%`;
                              return row.unit === 'INR_PER_KG'
                                ? `₹${formatted}/kg`
                                : `₹${formatted}`;
                            };

                            const formatDiff = (val: string) => {
                              const n = parseFloat(val);
                              const sign = n > 0 ? '+' : n < 0 ? '-' : '';
                              const absVal = Math.abs(n);
                              if (row.unit === 'PCS') {
                                return `${sign}${Math.round(absVal).toLocaleString('en-IN')} pcs`;
                              }
                              const formatted = absVal.toLocaleString('en-IN', {
                                minimumFractionDigits: 2,
                                maximumFractionDigits: 2,
                              });
                              if (row.unit === 'PCT') return `${sign}${formatted}%`;
                              return row.unit === 'INR_PER_KG'
                                ? `${sign}₹${formatted}/kg`
                                : `${sign}₹${formatted}`;
                            };

                            return (
                              <tr
                                key={row.key}
                                className={
                                  isHighlightRow ? 'bg-gray-50 font-semibold' : undefined
                                }
                              >
                                <td>
                                  <span className="text-gray-900">{row.label}</span>
                                  {row.note && (
                                    <span className="ml-2 text-xs text-gray-500 font-normal">
                                      ({row.note})
                                    </span>
                                  )}
                                </td>
                                <td className="text-right tabular text-gray-900">
                                  {formatVal(row.currentValue)}
                                </td>
                                <td className="text-right tabular text-gray-700">
                                  {formatVal(row.historicalValue)}
                                </td>
                                <td
                                  className={[
                                    'text-right tabular font-medium',
                                    isZero
                                      ? 'text-gray-500'
                                      : absNum > 0
                                      ? 'text-amber-700'
                                      : 'text-emerald-700',
                                  ].join(' ')}
                                >
                                  {formatDiff(row.absoluteDifference)}
                                </td>
                                <td
                                  className={[
                                    'text-right tabular font-mono text-xs',
                                    row.percentageDifference === null || isZero
                                      ? 'text-gray-400'
                                      : parseFloat(row.percentageDifference) > 0
                                      ? 'text-amber-700'
                                      : 'text-emerald-700',
                                  ].join(' ')}
                                >
                                  {row.percentageDifference === null
                                    ? 'N/A'
                                    : `${
                                        parseFloat(row.percentageDifference) > 0 ? '+' : ''
                                      }${row.percentageDifference}%`}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            )}
        </div>
      </section>

      {/* Error */}
      {previewError && (
        <div className="p-4 rounded bg-red-50 border border-red-200 text-sm text-red-700 flex items-center gap-2">
          <AlertCircle className="w-4 h-4 shrink-0" strokeWidth={1.8} />
          <span>{previewError}</span>
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center gap-3">
        <Button
          variant="primary"
          size="lg"
          loading={previewLoading}
          onClick={handlePreview}
        >
          <Calculator className="w-4 h-4 shrink-0" strokeWidth={1.8} />
          <span>Calculate Preview</span>
        </Button>
        <Link to={`/rfqs/${rfqId}`} className="text-sm text-gray-500 hover:text-gray-700">
          Cancel
        </Link>
      </div>
    </div>
  );
}

