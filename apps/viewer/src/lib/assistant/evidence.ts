/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { admitNativePins, nativePinBaseline } from '@/lib/actions/native-pin-transport';
import { preserveNativeExpectedProjection } from '@/lib/actions/native-authoring-evidence';
import { useViewerStore } from '@/store';
import { captureAnalysisStamp, isAnalysisStale, type AnalysisStamp } from '@/hooks/useAnalysisStaleness';
import type { AssistantSource } from './sources';
import { adapterFor } from './adapters/registry';
import { sameIdentity } from './adapters/types';
import { evidenceJson, ROW_LIMIT, TEXT_LIMIT } from './projection';
import { admitSelectionCosts, selectionCostBaseline } from './selection-cost-admission';

export type { AssistantSource } from './sources';
export { evidenceJson } from './projection';
export interface EvidenceSnapshot {
  id: string;
  source: AssistantSource;
  capturedAt: string;
  models: Array<{ id: string; name: string; fingerprint?: string }>;
  contextStamp: AnalysisStamp;
  reportStamp: AnalysisStamp | null;
  /** The native result captured, compared by reference (element-wise for composite identities). */
  sourceIdentity: unknown;
  /** Exact native row count; summary is never recomputed from the sample. */
  totalRows: number;
  includedRows: number;
  projectionTruncated: boolean;
  payload: string;
}

export function sourceIdentity(source: AssistantSource): unknown {
  return adapterFor(source).identity(useViewerStore.getState());
}

/** Freeze one source through its registered adapter into the common bounded envelope. */
export function captureEvidence(source: AssistantSource): EvidenceSnapshot {
  const s = useViewerStore.getState();
  const adapter = adapterFor(source);
  const identity = adapter.identity(s);
  const capture = adapter.capture(s, ROW_LIMIT);
  if (capture.rows.length > ROW_LIMIT || capture.rows.length > capture.totalRows) {
    throw new Error(`${source} adapter returned ${capture.rows.length} rows for a native total of ${capture.totalRows}`);
  }
  const competingCosts = source === 'selection' && capture.rows.length > 1;
  const rows = capture.rows.map((data, index) => ({ citation: `E${index + 1}`,
    data: source === 'selection' ? nativePinBaseline(competingCosts ? selectionCostBaseline(data) : data, ['nativeStoreyReassignments']) : data }));
  const totalRows = capture.totalRows;
  const models = [...s.models.values()].map(m => ({ id: m.id, name: m.name, fingerprint: m.sourceFingerprint }));
  let summaryProjection = evidenceJson(capture.summary);
  if (summaryProjection.text.length > 24_000) summaryProjection = { text: JSON.stringify({ omitted: 'Summary exceeded text budget' }), truncated: true };
  const modelProjection = evidenceJson(models);
  const promptModels: unknown = modelProjection.text.length <= 8000 ? JSON.parse(modelProjection.text) : [];
  const modelMetadataTruncated = modelProjection.truncated || modelProjection.text.length > 8000;
  const projectedRows: unknown[] = [];
  let projectionTruncated = summaryProjection.truncated || modelMetadataTruncated;
  // Reserve envelope space and include projected model metadata in the same budget.
  let textLength = summaryProjection.text.length + JSON.stringify(promptModels).length + 2000;
  for (const row of rows) {
    let projection = evidenceJson(row);
    let projected: unknown = JSON.parse(projection.text);
    // A complete optional Structural pin must not displace ordinary evidence.
    // Refuse that pin as a whole when it cannot fit in the remaining envelope.
    if ((typeof projected !== 'object' || projected === null || !('citation' in projected)
      || textLength + projection.text.length > TEXT_LIMIT)
      && typeof row.data === 'object' && row.data !== null && 'nativeStructural' in row.data) {
      const data = row.data as Record<string, unknown>;
      projection = evidenceJson({ ...row, data: { ...data,
        nativeStructural: { status: 'unavailable-selection-budget', recordCount: null, expectedJsonParts: null },
      } });
      projected = JSON.parse(projection.text);
    }
    preserveNativeExpectedProjection(row, projected);
    if (typeof projected !== 'object' || projected === null || !('citation' in projected) || textLength + projection.text.length > TEXT_LIMIT) {
      projectionTruncated = true;
      break;
    }
    textLength += projection.text.length + 2;
    projectionTruncated ||= projection.truncated;
    projectedRows.push(projection.truncated ? { ...projected, rowProjectionTruncated: true } : projected);
  }
  const snapshot = { id: crypto.randomUUID(), source, capturedAt: new Date().toISOString(), models,
    contextStamp: captureAnalysisStamp(true), reportStamp: adapter.reportStamp?.(s) ?? null, sourceIdentity: identity,
    totalRows, includedRows: projectedRows.length, projectionTruncated };
  const serialize = (evidenceRows: unknown[]) => JSON.stringify({ source, capturedAt: snapshot.capturedAt, models: promptModels,
    totalModels: models.length, modelMetadataTruncated,
    sourceAvailability: capture.availability,
    reportProvenance: snapshot.reportStamp ? { mutationVersion: snapshot.reportStamp.mutationVersion,
      geometryContentVersion: snapshot.reportStamp.geometryContentVersion } : 'unknown',
    totalRows, includedRows: projectedRows.length, sampled: projectedRows.length < totalRows, projectionTruncated,
    evidence: { summary: JSON.parse(summaryProjection.text), rows: evidenceRows } });
  if (competingCosts) admitSelectionCosts(capture.rows, projectedRows, serialize);
  if (source === 'selection') {
    const data = projectedRows.map(row => typeof row === 'object' && row !== null && 'data' in row ? row.data : null);
    const wrap = (values: unknown[]) => projectedRows.map((row, index) => typeof row === 'object' && row !== null ? { ...row, data: values[index] } : row);
    admitNativePins(capture.rows, data, values => serialize(wrap(values)).length, TEXT_LIMIT,
      pin => JSON.parse(evidenceJson(pin).text) as unknown, ['nativeStoreyReassignments']);
    projectedRows.splice(0, projectedRows.length, ...wrap(data));
  }
  return { ...snapshot, payload: serialize(projectedRows) };
}

export function evidenceIsCurrent(snapshot: EvidenceSnapshot): boolean {
  const s = useViewerStore.getState();
  return sameIdentity(adapterFor(snapshot.source).identity(s), snapshot.sourceIdentity) &&
    !isAnalysisStale(snapshot.contextStamp, s) && !isAnalysisStale(snapshot.reportStamp, s) &&
    snapshot.models.length === s.models.size && snapshot.models.every(pin => {
      const model = s.models.get(pin.id);
      return model !== undefined && model.sourceFingerprint === pin.fingerprint;
    });
}
