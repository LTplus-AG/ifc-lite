/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useViewerStore } from '@/store';
import { analysisStampOf, captureAnalysisStamp, isAnalysisStale, type AnalysisStamp } from '@/hooks/useAnalysisStaleness';
import { buildLoadReports } from '../loadReport';
import type { AssistantSource } from './sources';

export type { AssistantSource } from './sources';
export interface EvidenceSnapshot {
  id: string;
  source: AssistantSource;
  capturedAt: string;
  models: Array<{ id: string; name: string; fingerprint?: string }>;
  contextStamp: AnalysisStamp;
  reportStamp: AnalysisStamp | null;
  sourceIdentity: object | null;
  /** Exact native row count; summary is never recomputed from the sample. */
  totalRows: number;
  includedRows: number;
  projectionTruncated: boolean;
  payload: string;
}

const ROW_LIMIT = 100;
const TEXT_LIMIT = 48_000;

/** Explicitly bounded projection. No source buffers, stores, typed arrays or credentials. */
export function evidenceJson(value: unknown): { text: string; truncated: boolean } {
  let remaining = 1800;
  let truncated = false;
  const seen = new Set<object>();
  function project(item: unknown, depth: number): unknown {
    if (--remaining < 0 || depth > 8) { truncated = true; return '[omitted: evidence limit]'; }
    if (typeof item === 'string') {
      if (item.length > 1200) truncated = true;
      return item.slice(0, 1200);
    }
    if (item === null || typeof item === 'number' || typeof item === 'boolean') return item;
    if (typeof item === 'bigint') return String(item);
    if (item instanceof Date) return item.toISOString();
    if (ArrayBuffer.isView(item) || item instanceof ArrayBuffer) { truncated = true; return undefined; }
    if (typeof item !== 'object') return undefined;
    if (seen.has(item)) { truncated = true; return '[omitted: repeated reference]'; }
    seen.add(item);
    if (Array.isArray(item)) {
      if (item.length > 100) truncated = true;
      return item.slice(0, 100).map(child => project(child, depth + 1));
    }
    if (Object.getPrototypeOf(item) !== Object.prototype) { truncated = true; return '[omitted: unsupported object]'; }
    const entries = Object.entries(item);
    if (entries.length > 64) truncated = true;
    return Object.fromEntries(entries.slice(0, 64).map(([key, child]) => [key, project(child, depth + 1)]));
  }
  const projected = project(value, 0);
  const text = JSON.stringify(projected);
  // Keep valid JSON: never cut a serialization in the middle of a value.
  if (!text || text.length > TEXT_LIMIT) return { text: JSON.stringify({ omitted: 'Evidence exceeded text budget' }), truncated: true };
  return { text, truncated };
}

export function sourceIdentity(source: AssistantSource): object | null {
  const s = useViewerStore.getState();
  if (source === 'clash') return s.clashResult;
  if (source === 'validation') return s.idsValidationReport;
  if (source === 'compare') return s.compareResult;
  if (source === 'loadReport') return s.models;
  return s.flowDoc;
}

export function captureEvidence(source: AssistantSource): EvidenceSnapshot {
  const s = useViewerStore.getState();
  const identity = sourceIdentity(source);
  let summary: unknown = null;
  const rows: Array<{ citation: string; data: unknown }> = [];
  let totalRows = 0;
  function add(data: unknown) {
    totalRows++;
    if (rows.length < ROW_LIMIT) rows.push({ citation: `E${rows.length + 1}`, data });
  }
  if (source === 'clash' && s.clashResult) {
    summary = { ...s.clashResult.summary, truncated: s.clashResult.truncated, settings: s.clashResult.settings };
    totalRows = s.clashResult.clashes.length;
    for (const c of s.clashResult.clashes.slice(0, ROW_LIMIT)) {
      rows.push({ citation: `E${rows.length + 1}`, data: { id: c.id, a: c.a, b: c.b, rule: c.rule,
        status: c.status, severity: c.severity, distance: c.distance, distanceKind: c.distanceKind } });
    }
  } else if (source === 'validation' && s.idsValidationReport) {
    const report = s.idsValidationReport;
    summary = { summary: report.summary, source: report.source.kind, timestamp: report.timestamp, modelInfo: report.modelInfo };
    for (const spec of report.specificationResults) {
      add({ specification: spec.specification, status: spec.status, applicableCount: spec.applicableCount,
        passedCount: spec.passedCount, failedCount: spec.failedCount, error: spec.error, cardinalityResult: spec.cardinalityResult });
      totalRows += spec.entityResults.length + (spec.setResults?.length ?? 0);
      for (const entity of spec.entityResults.slice(0, ROW_LIMIT - rows.length)) {
        rows.push({ citation: `E${rows.length + 1}`, data: { specificationId: spec.specification.id, ...entity } });
      }
      for (const set of (spec.setResults ?? []).slice(0, ROW_LIMIT - rows.length)) {
        rows.push({ citation: `E${rows.length + 1}`, data: { specificationId: spec.specification.id, ...set } });
      }
    }
  } else if (source === 'compare' && s.compareResult) {
    const r = s.compareResult;
    summary = { counts: r.diff.counts, scope: r.scope, baseModelId: r.baseModelId, headModelId: r.headModelId,
      geometryUnavailable: r.geometryUnavailable, placementOnlyGeometry: r.placementOnlyGeometry, excludedTypes: r.diff.excludedTypes };
    totalRows = r.diff.entries.length;
    for (const e of r.diff.entries.slice(0, ROW_LIMIT)) {
      rows.push({ citation: `E${rows.length + 1}`, data: { key: e.key, state: e.state, changeKinds: e.changeKinds,
        base: e.base?.ref, head: e.head?.ref } });
    }
  } else if (source === 'loadReport') {
    const reports = buildLoadReports(s.models);
    summary = { kind: 'model-load-reports', modelCount: reports.length,
      diagnosticsAvailable: reports.filter(report => report.diagnosticsAvailable).length,
      diagnosticsUnavailable: reports.filter(report => !report.diagnosticsAvailable).length,
      cleanLoads: reports.filter(report => report.isClean).length,
      limitations: 'Load diagnostics describe the original load, not validation of later edits. Affected entities are only those supplied by native diagnostics; missing diagnostics never mean clean.' };
    totalRows = reports.length;
    for (const report of reports.slice(0, ROW_LIMIT)) rows.push({ citation: `E${rows.length + 1}`, data: report });
  } else if (source === 'flow' && s.flowDoc) {
    summary = { kind: 'graph-only', executionStatus: 'not included' };
    const graph = evidenceJson({ id: s.flowDoc.id, name: s.flowDoc.name, description: s.flowDoc.description,
      nodes: s.flowDoc.nodes.slice(0, 100).map(node => ({ id: node.id, type: node.type, label: node.label })),
      edges: s.flowDoc.edges.slice(0, 100), nodeCount: s.flowDoc.nodes.length, edgeCount: s.flowDoc.edges.length,
      omitted: 'Node parameters and input/output values are excluded from this discussion snapshot' });
    add({ graph: JSON.parse(graph.text), graphTruncated: graph.truncated });
  }
  const models = [...s.models.values()].map(m => ({ id: m.id, name: m.name, fingerprint: m.sourceFingerprint }));
  let summaryProjection = evidenceJson(summary);
  if (summaryProjection.text.length > 24_000) summaryProjection = { text: JSON.stringify({ omitted: 'Summary exceeded text budget' }), truncated: true };
  const modelProjection = evidenceJson(models);
  const promptModels: unknown = modelProjection.text.length <= 8000 ? JSON.parse(modelProjection.text) : [];
  const modelMetadataTruncated = modelProjection.truncated || modelProjection.text.length > 8000;
  const projectedRows: unknown[] = [];
  let projectionTruncated = summaryProjection.truncated || modelMetadataTruncated;
  // Reserve envelope space and include projected model metadata in the same budget.
  let textLength = summaryProjection.text.length + JSON.stringify(promptModels).length + 2000;
  for (const row of rows) {
    const projection = evidenceJson(row);
    const projected: unknown = JSON.parse(projection.text);
    if (typeof projected !== 'object' || projected === null || !('citation' in projected) || textLength + projection.text.length > TEXT_LIMIT) {
      projectionTruncated = true;
      break;
    }
    textLength += projection.text.length + 2;
    projectionTruncated ||= projection.truncated;
    projectedRows.push(projection.truncated ? { ...projected, rowProjectionTruncated: true } : projected);
  }
  const snapshot = { id: crypto.randomUUID(), source, capturedAt: new Date().toISOString(), models,
    contextStamp: captureAnalysisStamp(true), reportStamp: analysisStampOf(source === 'clash' ? s.clashRawResult ?? identity : identity), sourceIdentity: identity,
    totalRows, includedRows: projectedRows.length, projectionTruncated };
  return { ...snapshot, payload: JSON.stringify({ source, capturedAt: snapshot.capturedAt, models: promptModels,
    totalModels: models.length, modelMetadataTruncated,
    reportProvenance: snapshot.reportStamp ? { mutationVersion: snapshot.reportStamp.mutationVersion,
      geometryContentVersion: snapshot.reportStamp.geometryContentVersion } : 'unknown',
    totalRows, includedRows: projectedRows.length, sampled: projectedRows.length < totalRows, projectionTruncated,
    evidence: { summary: JSON.parse(summaryProjection.text), rows: projectedRows } }) };
}

export function evidenceIsCurrent(snapshot: EvidenceSnapshot): boolean {
  const s = useViewerStore.getState();
  return sourceIdentity(snapshot.source) === snapshot.sourceIdentity &&
    !isAnalysisStale(snapshot.contextStamp, s) && !isAnalysisStale(snapshot.reportStamp, s) &&
    snapshot.models.length === s.models.size && snapshot.models.every(pin => {
      const model = s.models.get(pin.id);
      return model !== undefined && model.sourceFingerprint === pin.fingerprint;
    });
}
