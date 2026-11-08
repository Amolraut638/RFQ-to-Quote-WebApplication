/**
 * pages/IntakePage.tsx
 *
 * 4-stage AI-Assisted RFQ Intake for Estimators:
 *   Stage 1 — Input (Email text, Excel part list, Drawing PDF) + genuine AI provider badge
 *   Stage 2 — Review extracted RFQ fields with field-level provenance (Accept / Edit / Reject)
 *   Stage 3 — Review extracted Parts with cell/page provenance (Accept / Edit / Reject / Add Part)
 *   Stage 4 — Create RFQ (enabled only when required fields are accepted or edited)
 */

import React, { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { intakeApi } from '../api';
import {
  IntakeAIStatus,
  IntakeDraft,
  IntakeDraftField,
  FieldStatus,
  FieldUpdateAction,
} from '../types';
import { Button } from '../components/ui/Button';
import { Badge } from '../components/ui/Badge';

const RFQ_FIELDS_META: Array<{ key: string; label: string; required: boolean; hint?: string }> = [
  { key: 'rfqNo', label: 'RFQ Number', required: true, hint: 'Unique RFQ identifier' },
  { key: 'customer', label: 'Customer', required: true, hint: 'Customer company name' },
  { key: 'dueDate', label: 'Due Date (YYYY-MM-DD)', required: false, hint: 'Defaults to +14 days if omitted' },
  { key: 'customerContact', label: 'Customer Contact', required: false },
];

const PART_FIELDS_META: Array<{
  key: string;
  label: string;
  required: boolean;
  isNumeric?: boolean;
}> = [
  { key: 'partName', label: 'Part Name', required: true },
  { key: 'material', label: 'Material', required: true },
  { key: 'grossWeightKg', label: 'Gross Weight (kg)', required: true, isNumeric: true },
  { key: 'annualVolume', label: 'Annual Volume (pcs/yr)', required: true, isNumeric: true },
  { key: 'drawingNumber', label: 'Drawing No.', required: false },
  { key: 'drawingRevision', label: 'Drawing Rev.', required: false },
];

function fieldStatusBadge(status: FieldStatus) {
  switch (status) {
    case 'ACCEPTED':
      return <Badge variant="green">Accepted</Badge>;
    case 'EDITED':
      return <Badge variant="blue">Edited</Badge>;
    case 'REJECTED':
      return <Badge variant="red">Rejected</Badge>;
    case 'PENDING':
    default:
      return <Badge variant="yellow">Pending Review</Badge>;
  }
}

function formatProvenance(field: IntakeDraftField | undefined): React.ReactNode {
  if (!field) return <span className="text-xs text-gray-400">No source</span>;
  const { source } = field;
  if (source.sourceType === 'MANUAL') {
    return <span className="text-xs text-gray-500">Estimator manual entry</span>;
  }

  return (
    <div className="space-y-1 text-xs">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-medium text-gray-700">{source.sourceType}</span>
        <span className="text-gray-400">·</span>
        <span className="text-gray-600 font-mono">{source.fileName}</span>
        {source.page !== null && (
          <span className="px-1.5 py-0.5 rounded bg-gray-100 text-gray-700 font-mono">
            Page {source.page}
          </span>
        )}
        {source.sheet && source.cell && (
          <span className="px-1.5 py-0.5 rounded bg-gray-100 text-gray-700 font-mono">
            {source.sheet}!{source.cell}
          </span>
        )}
        {field.value !== null && !field.verified && (
          <span className="px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 border border-amber-200">
            Unverified snippet
          </span>
        )}
      </div>
      {source.snippet && (
        <p className="text-gray-500 font-mono bg-gray-50 border border-gray-200 rounded px-2 py-1 break-words">
          “{source.snippet}”
        </p>
      )}
    </div>
  );
}

export function IntakePage() {
  const navigate = useNavigate();

  const [aiStatus, setAiStatus] = useState<IntakeAIStatus | null>(null);
  const [aiStatusError, setAiStatusError] = useState('');

  const [activeTab, setActiveTab] = useState<'EMAIL' | 'EXCEL' | 'PDF'>('EMAIL');
  const [emailText, setEmailText] = useState('');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [mergeIntoDraft, setMergeIntoDraft] = useState(true);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [draft, setDraft] = useState<IntakeDraft | null>(null);
  const [extracting, setExtracting] = useState(false);
  const [extractError, setExtractError] = useState('');

  // Editing inline state: key = `${scope}:${partIndex}:${fieldKey}`
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState<string>('');
  const [savingField, setSavingField] = useState(false);
  const [fieldError, setFieldError] = useState('');

  const [committing, setCommitting] = useState(false);
  const [commitError, setCommitError] = useState('');
  const [commitSuccess, setCommitSuccess] = useState<{
    rfqId: string;
    rfqNo: string;
    partCount: number;
  } | null>(null);

  useEffect(() => {
    intakeApi
      .getStatus()
      .then((res) => setAiStatus(res.data.data))
      .catch((err: Error) => setAiStatusError(err.message));
  }, []);

  function findField(
    scope: 'RFQ' | 'PART',
    partIndex: number,
    key: string,
  ): IntakeDraftField | undefined {
    return draft?.fields.find(
      (f) => f.scope === scope && f.partIndex === partIndex && f.key === key,
    );
  }

  async function handleExtractEmail() {
    setExtractError('');
    setFieldError('');
    setCommitError('');
    if (emailText.trim().length < 10) {
      setExtractError('Please paste the RFQ email content (at least 10 characters).');
      return;
    }
    setExtracting(true);
    try {
      const targetDraftId =
        mergeIntoDraft && draft && draft.status !== 'COMMITTED' ? draft._id : undefined;
      const res = await intakeApi.extractEmail(emailText, targetDraftId);
      setDraft(res.data.data);
    } catch (err: unknown) {
      setExtractError(err instanceof Error ? err.message : 'Email extraction failed');
    } finally {
      setExtracting(false);
    }
  }

  async function handleExtractFile() {
    setExtractError('');
    setFieldError('');
    setCommitError('');
    if (!selectedFile) {
      setExtractError('Please select a file to upload.');
      return;
    }
    if (selectedFile.size > 10 * 1024 * 1024) {
      setExtractError('File exceeds the 10 MB upload limit.');
      return;
    }
    setExtracting(true);
    try {
      const targetDraftId =
        mergeIntoDraft && draft && draft.status !== 'COMMITTED' ? draft._id : undefined;
      const res = await intakeApi.uploadFile(selectedFile, targetDraftId);
      setDraft(res.data.data);
      setSelectedFile(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
    } catch (err: unknown) {
      setExtractError(err instanceof Error ? err.message : 'File extraction failed');
    } finally {
      setExtracting(false);
    }
  }

  async function applyUpdates(updates: FieldUpdateAction[], addPart?: boolean) {
    if (!draft) return;
    setSavingField(true);
    setFieldError('');
    try {
      const res = await intakeApi.patchFields(draft._id, { updates, addPart });
      setDraft(res.data.data);
      setEditingKey(null);
    } catch (err: unknown) {
      setFieldError(err instanceof Error ? err.message : 'Failed to update field');
    } finally {
      setSavingField(false);
    }
  }

  function startEdit(
    scope: 'RFQ' | 'PART',
    partIndex: number,
    key: string,
    currentVal: string | number | null | undefined,
  ) {
    setFieldError('');
    setEditingKey(`${scope}:${partIndex}:${key}`);
    setEditingValue(currentVal !== null && currentVal !== undefined ? String(currentVal) : '');
  }

  async function saveEdit(scope: 'RFQ' | 'PART', partIndex: number, key: string) {
    await applyUpdates([
      {
        scope,
        partIndex,
        key,
        action: 'EDIT',
        value: editingValue,
      },
    ]);
  }

  async function handleCommit() {
    if (!draft) return;
    setCommitting(true);
    setCommitError('');
    try {
      const res = await intakeApi.commit(draft._id);
      const { rfq, parts, draft: updatedDraft } = res.data.data;
      setDraft(updatedDraft);
      setCommitSuccess({
        rfqId: rfq._id,
        rfqNo: rfq.rfqNo,
        partCount: parts.length,
      });
    } catch (err: unknown) {
      setCommitError(err instanceof Error ? err.message : 'Failed to create RFQ');
    } finally {
      setCommitting(false);
    }
  }

  function handleResetDraft() {
    setDraft(null);
    setCommitSuccess(null);
    setExtractError('');
    setFieldError('');
    setCommitError('');
  }

  return (
    <div className="space-y-6 max-w-6xl">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-sm mb-1">
            <Link to="/rfqs" className="text-brand-600 hover:underline">
              RFQ Register
            </Link>
            <span className="text-gray-400">›</span>
            <span className="text-gray-600">AI-Assisted Intake</span>
          </div>
          <h1 className="text-lg font-semibold text-gray-900">AI-Assisted RFQ Intake</h1>
          <p className="text-sm text-gray-500">
            Extract RFQ details from emails, Excel part lists, and drawing PDFs. Every value must be
            reviewed before creating the RFQ.
          </p>
        </div>

        {/* Genuine AI provider status */}
        <div className="bg-white border border-gray-200 rounded-lg px-3.5 py-2 text-xs">
          {aiStatus ? (
            <div className="flex items-center gap-2">
              <span className="text-gray-500">AI Provider:</span>
              <span className="font-mono font-semibold text-gray-900">
                {aiStatus.provider} / {aiStatus.model}
              </span>
              {aiStatus.configured ? (
                <Badge variant="green">Configured</Badge>
              ) : (
                <Badge variant="red">Not Configured</Badge>
              )}
            </div>
          ) : aiStatusError ? (
            <span className="text-red-600">{aiStatusError}</span>
          ) : (
            <span className="text-gray-400">Checking AI provider…</span>
          )}
        </div>
      </div>

      {/* Data policy notice */}
      {aiStatus?.dataPolicyNotice && (
        <div className="p-3 rounded bg-amber-50 border border-amber-200 text-xs text-amber-800">
          <span className="font-semibold">Confidentiality Notice: </span>
          {aiStatus.dataPolicyNotice}
        </div>
      )}

      {/* STAGE 1 — INPUT */}
      <section className="bg-white border border-gray-200 rounded-lg">
        <div className="px-5 py-3 border-b border-gray-100 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
              Stage 1 — RFQ Source Input
            </h2>
          </div>
          {draft && draft.status !== 'COMMITTED' && (
            <div className="flex items-center gap-4 text-xs">
              <label className="flex items-center gap-1.5 text-gray-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={mergeIntoDraft}
                  onChange={(e) => setMergeIntoDraft(e.target.checked)}
                  className="rounded border-gray-300"
                />
                Merge next extraction into current draft ({draft.sources.length} source
                {draft.sources.length === 1 ? '' : 's'} loaded)
              </label>
              <Button variant="secondary" size="sm" onClick={handleResetDraft}>
                Start New Draft
              </Button>
            </div>
          )}
        </div>

        {/* Source tabs */}
        <div className="px-5 pt-4 border-b border-gray-100 flex gap-2">
          {(
            [
              ['EMAIL', '1. Paste RFQ Email'],
              ['EXCEL', '2. Upload Excel Part List (.xlsx / .xls)'],
              ['PDF', '3. Upload Drawing PDF (.pdf)'],
            ] as const
          ).map(([tab, label]) => (
            <button
              key={tab}
              type="button"
              onClick={() => {
                setActiveTab(tab);
                setExtractError('');
                setSelectedFile(null);
                if (fileInputRef.current) fileInputRef.current.value = '';
              }}
              className={[
                'px-3.5 py-2 text-xs font-medium border-b-2 -mb-px transition-colors',
                activeTab === tab
                  ? 'border-brand-600 text-brand-700'
                  : 'border-transparent text-gray-600 hover:text-gray-900',
              ].join(' ')}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="p-5 space-y-4">
          {activeTab === 'EMAIL' ? (
            <div className="space-y-3">
              <label className="block text-sm font-medium text-gray-700">
                RFQ Email Content
              </label>
              <textarea
                rows={6}
                value={emailText}
                onChange={(e) => setEmailText(e.target.value)}
                placeholder="Paste the customer's RFQ email text here (including RFQ number, customer, due date, part names, materials, weights, annual volumes)…"
                className="block w-full rounded border border-gray-300 px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
              <div className="flex items-center justify-between">
                <p className="text-xs text-gray-500">
                  AI extracts only explicitly stated values; unknown fields remain null.
                </p>
                <Button onClick={handleExtractEmail} loading={extracting}>
                  Extract from Email
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <label className="block text-sm font-medium text-gray-700">
                {activeTab === 'EXCEL'
                  ? 'Select Excel Part List (.xlsx or .xls, max 10 MB)'
                  : 'Select Engineering Drawing PDF (.pdf, text-layer, max 10 MB)'}
              </label>
              <input
                ref={fileInputRef}
                type="file"
                accept={activeTab === 'EXCEL' ? '.xlsx,.xls' : '.pdf'}
                onChange={(e) => setSelectedFile(e.target.files?.[0] ?? null)}
                className="block w-full text-sm text-gray-700 file:mr-3 file:py-1.5 file:px-3 file:rounded file:border file:border-gray-300 file:text-xs file:font-medium file:bg-white file:text-gray-700 hover:file:bg-gray-50"
              />
              <div className="flex items-center justify-between">
                <p className="text-xs text-gray-500">
                  {activeTab === 'EXCEL'
                    ? 'Workbook is parsed in memory; cell coordinates (Sheet!Cell) are preserved for every extracted value.'
                    : 'Title-block text is extracted page by page in memory; page number and verbatim snippet are preserved.'}
                </p>
                <Button onClick={handleExtractFile} loading={extracting} disabled={!selectedFile}>
                  {activeTab === 'EXCEL' ? 'Extract from Excel' : 'Extract from Drawing PDF'}
                </Button>
              </div>
            </div>
          )}

          {extracting && (
            <div className="p-3 rounded bg-blue-50 border border-blue-200 text-xs text-blue-700">
              Running genuine AI inference via {aiStatus?.provider ?? 'configured provider'} (
              {aiStatus?.model ?? 'model'})…
            </div>
          )}

          {extractError && (
            <div className="p-3 rounded bg-red-50 border border-red-200 text-xs text-red-700">
              {extractError}
            </div>
          )}

          {draft && draft.sources.length > 0 && (
            <div className="pt-2 border-t border-gray-100 flex flex-wrap items-center gap-2 text-xs text-gray-600">
              <span className="font-medium text-gray-700">Sources in this draft:</span>
              {draft.sources.map((s, idx) => (
                <span
                  key={idx}
                  className="px-2 py-0.5 rounded bg-gray-100 border border-gray-200 font-mono"
                >
                  [{s.sourceType}] {s.fileName}
                </span>
              ))}
            </div>
          )}
        </div>
      </section>

      {fieldError && (
        <div className="p-3 rounded bg-red-50 border border-red-200 text-xs text-red-700">
          {fieldError}
        </div>
      )}

      {/* STAGE 2 — REVIEW EXTRACTED RFQ INFORMATION */}
      {draft && (
        <section className="bg-white border border-gray-200 rounded-lg overflow-hidden">
          <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between">
            <div>
              <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
                Stage 2 — Review Extracted RFQ Fields
              </h2>
              <p className="text-xs text-gray-500 mt-0.5">
                Extracted by <span className="font-mono">{draft.ai.provider}/{draft.ai.model}</span>.
                Accept, edit, or reject each value.
              </p>
            </div>
          </div>

          <table className="data-table">
            <thead>
              <tr>
                <th>Field</th>
                <th>Extracted / Current Value</th>
                <th>Source Attribution</th>
                <th>Status</th>
                <th className="text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {RFQ_FIELDS_META.map((meta) => {
                const field = findField('RFQ', -1, meta.key);
                const rowEditKey = `RFQ:-1:${meta.key}`;
                const isEditing = editingKey === rowEditKey;
                const val = field?.value ?? null;
                const isMissingRequired =
                  meta.required && (val === null || String(val).trim() === '');

                return (
                  <tr
                    key={meta.key}
                    className={isMissingRequired ? 'bg-amber-50/40' : undefined}
                  >
                    <td className="font-medium text-gray-900 text-sm">
                      {meta.label}
                      {meta.required && <span className="text-red-500 ml-0.5">*</span>}
                      {meta.hint && (
                        <p className="text-xs text-gray-400 font-normal">{meta.hint}</p>
                      )}
                    </td>

                    <td className="text-sm">
                      {isEditing ? (
                        <div className="flex items-center gap-2">
                          <input
                            type="text"
                            value={editingValue}
                            onChange={(e) => setEditingValue(e.target.value)}
                            className="rounded border border-gray-300 px-2.5 py-1 text-sm w-48 focus:outline-none focus:ring-2 focus:ring-brand-500"
                          />
                          <Button
                            size="sm"
                            onClick={() => saveEdit('RFQ', -1, meta.key)}
                            loading={savingField}
                          >
                            Save
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setEditingKey(null)}
                          >
                            Cancel
                          </Button>
                        </div>
                      ) : val !== null && String(val).trim() !== '' ? (
                        <span className="font-mono text-gray-900">{String(val)}</span>
                      ) : (
                        <span className="text-xs text-amber-700 font-medium">
                          Not found in source — click Edit to enter
                        </span>
                      )}
                    </td>

                    <td>{formatProvenance(field)}</td>

                    <td>{fieldStatusBadge(field?.status ?? 'PENDING')}</td>

                    <td className="text-right">
                      {draft.status !== 'COMMITTED' && !isEditing && (
                        <div className="inline-flex items-center gap-1.5">
                          <Button
                            variant="secondary"
                            size="sm"
                            disabled={
                              savingField || val === null || String(val).trim() === ''
                            }
                            onClick={() =>
                              applyUpdates([
                                { scope: 'RFQ', partIndex: -1, key: meta.key, action: 'ACCEPT' },
                              ])
                            }
                          >
                            Accept
                          </Button>
                          <Button
                            variant="secondary"
                            size="sm"
                            disabled={savingField}
                            onClick={() => startEdit('RFQ', -1, meta.key, val)}
                          >
                            Edit
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={savingField}
                            onClick={() =>
                              applyUpdates([
                                { scope: 'RFQ', partIndex: -1, key: meta.key, action: 'REJECT' },
                              ])
                            }
                          >
                            Reject
                          </Button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}

      {/* STAGE 3 — REVIEW PARTS */}
      {draft && (
        <section className="bg-white border border-gray-200 rounded-lg overflow-hidden">
          <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between">
            <div>
              <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
                Stage 3 — Review Extracted Parts ({draft.partCount})
              </h2>
              <p className="text-xs text-gray-500 mt-0.5">
                Every required part field (Name, Material, Gross Weight, Annual Volume) must be
                accepted or edited before commit.
              </p>
            </div>
            {draft.status !== 'COMMITTED' && (
              <Button
                variant="secondary"
                size="sm"
                disabled={savingField}
                onClick={() => applyUpdates([], true)}
              >
                + Add Part Manually
              </Button>
            )}
          </div>

          {draft.partCount === 0 ? (
            <div className="p-8 text-center text-sm text-gray-500">
              No parts extracted yet. Upload an Excel part list or drawing PDF, or click{' '}
              <span className="font-medium">+ Add Part Manually</span>.
            </div>
          ) : (
            <div className="divide-y divide-gray-200">
              {Array.from({ length: draft.partCount }).map((_, partIdx) => (
                <div key={partIdx} className="p-5 space-y-3">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-semibold text-gray-900">
                      Part #{partIdx + 1}
                    </h3>
                    {draft.status !== 'COMMITTED' && (
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={savingField}
                        onClick={() => {
                          const acceptable: FieldUpdateAction[] = [];
                          for (const pm of PART_FIELDS_META) {
                            const pf = findField('PART', partIdx, pm.key);
                            if (
                              pf &&
                              pf.value !== null &&
                              String(pf.value).trim() !== '' &&
                              pf.status === 'PENDING'
                            ) {
                              acceptable.push({
                                scope: 'PART',
                                partIndex: partIdx,
                                key: pm.key,
                                action: 'ACCEPT',
                              });
                            }
                          }
                          if (acceptable.length > 0) applyUpdates(acceptable);
                        }}
                      >
                        Accept All Populated Fields for Part #{partIdx + 1}
                      </Button>
                    )}
                  </div>

                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Part Field</th>
                        <th>Extracted / Current Value</th>
                        <th>Source Attribution</th>
                        <th>Status</th>
                        <th className="text-right">Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {PART_FIELDS_META.map((meta) => {
                        const field = findField('PART', partIdx, meta.key);
                        const rowEditKey = `PART:${partIdx}:${meta.key}`;
                        const isEditing = editingKey === rowEditKey;
                        const val = field?.value ?? null;
                        const isMissingRequired =
                          meta.required && (val === null || String(val).trim() === '');

                        return (
                          <tr
                            key={meta.key}
                            className={isMissingRequired ? 'bg-amber-50/40' : undefined}
                          >
                            <td className="font-medium text-gray-900 text-sm">
                              {meta.label}
                              {meta.required && <span className="text-red-500 ml-0.5">*</span>}
                            </td>

                            <td className="text-sm">
                              {isEditing ? (
                                <div className="flex items-center gap-2">
                                  <input
                                    type={meta.isNumeric ? 'number' : 'text'}
                                    step={meta.isNumeric ? 'any' : undefined}
                                    value={editingValue}
                                    onChange={(e) => setEditingValue(e.target.value)}
                                    className="rounded border border-gray-300 px-2.5 py-1 text-sm w-44 focus:outline-none focus:ring-2 focus:ring-brand-500"
                                  />
                                  <Button
                                    size="sm"
                                    onClick={() => saveEdit('PART', partIdx, meta.key)}
                                    loading={savingField}
                                  >
                                    Save
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => setEditingKey(null)}
                                  >
                                    Cancel
                                  </Button>
                                </div>
                              ) : val !== null && String(val).trim() !== '' ? (
                                <span className="font-mono text-gray-900">{String(val)}</span>
                              ) : (
                                <span className="text-xs text-amber-700 font-medium">
                                  Missing — click Edit to enter
                                </span>
                              )}
                            </td>

                            <td>{formatProvenance(field)}</td>

                            <td>{fieldStatusBadge(field?.status ?? 'PENDING')}</td>

                            <td className="text-right">
                              {draft.status !== 'COMMITTED' && !isEditing && (
                                <div className="inline-flex items-center gap-1.5">
                                  <Button
                                    variant="secondary"
                                    size="sm"
                                    disabled={
                                      savingField || val === null || String(val).trim() === ''
                                    }
                                    onClick={() =>
                                      applyUpdates([
                                        {
                                          scope: 'PART',
                                          partIndex: partIdx,
                                          key: meta.key,
                                          action: 'ACCEPT',
                                        },
                                      ])
                                    }
                                  >
                                    Accept
                                  </Button>
                                  <Button
                                    variant="secondary"
                                    size="sm"
                                    disabled={savingField}
                                    onClick={() => startEdit('PART', partIdx, meta.key, val)}
                                  >
                                    Edit
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    disabled={savingField}
                                    onClick={() =>
                                      applyUpdates([
                                        {
                                          scope: 'PART',
                                          partIndex: partIdx,
                                          key: meta.key,
                                          action: 'REJECT',
                                        },
                                      ])
                                    }
                                  >
                                    Reject
                                  </Button>
                                </div>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {/* STAGE 4 — CREATE RFQ */}
      {draft && (
        <section className="bg-white border border-gray-200 rounded-lg p-5 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
                Stage 4 — Create RFQ & Parts
              </h2>
              <p className="text-xs text-gray-500 mt-0.5">
                Commits accepted and edited values atomically into the RFQ Register. Costing is
                performed afterward by the deterministic costing engine.
              </p>
            </div>
            {draft.readiness.ready ? (
              <Badge variant="green">Ready to Commit</Badge>
            ) : (
              <Badge variant="yellow">Review Required</Badge>
            )}
          </div>

          {!draft.readiness.ready && draft.status !== 'COMMITTED' && (
            <div className="p-3 rounded bg-gray-50 border border-gray-200 text-xs text-gray-700 space-y-1">
              <p className="font-medium text-gray-800">
                Complete the following before creating the RFQ:
              </p>
              <ul className="list-disc list-inside space-y-0.5 text-gray-600">
                {draft.readiness.missingReasons.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            </div>
          )}

          {commitError && (
            <div className="p-3 rounded bg-red-50 border border-red-200 text-xs text-red-700">
              {commitError}
            </div>
          )}

          {commitSuccess ? (
            <div className="p-4 rounded bg-green-50 border border-green-200 text-sm text-green-800 flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="font-semibold">
                  RFQ <span className="font-mono">{commitSuccess.rfqNo}</span> created with{' '}
                  {commitSuccess.partCount} part{commitSuccess.partCount === 1 ? '' : 's'}.
                </p>
                <p className="text-xs text-green-700 mt-0.5">
                  Proceed to the RFQ detail page to open Part Costing and view historical routing
                  suggestions.
                </p>
              </div>
              <Button onClick={() => navigate(`/rfqs/${commitSuccess.rfqId}`)}>
                Open RFQ {commitSuccess.rfqNo} →
              </Button>
            </div>
          ) : (
            <div className="flex justify-end">
              <Button
                size="lg"
                disabled={!draft.readiness.ready || draft.status === 'COMMITTED'}
                loading={committing}
                onClick={handleCommit}
              >
                Create RFQ & Parts
              </Button>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

