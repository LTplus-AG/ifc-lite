/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { parseFilterGroups, isCapturedEntityScope, totalRuleCount } from '@ifc-lite/rules';
import { useViewerStore } from '@/store';
import type { SearchFilterStateValue } from '@/store/slices/searchSlice';
import { evaluateViewerFilter } from '@/lib/search/evaluate-viewer-filter';
import { loadSavedFilters, saveFilter, deleteSavedFilter } from '@/lib/search/saved-filters';
import { formatCsv, formatJson } from '@/lib/search/result-export';
import { stampAnalysisReport, analysisStampFrom, analysisStampOf, isAnalysisStale } from '@/hooks/useAnalysisStaleness';
import { viewerOperation, emptySchema } from './contract';
import type { ViewerOperationContext } from './contract';
const nativeOutput = { type: 'object', properties: { native_json: { type: 'string' } }, required: ['native_json'], additionalProperties: false };
const metadata = (id: string, description: string, write = false) => ({ id, owner: 'search', description,
  effects: write ? ['configuration'] as const : ['read'] as const, capability: write ? 'commands-and-edits' as const : 'read' as const,
  implementation: 'native-store' as const, outputSchema: nativeOutput });
const wire = (value: unknown) => ({ native_json: JSON.stringify(value) });
const expected = { type: 'string' as const, minLength: 1, maxLength: 1000000 };
function configuration() { const s = useViewerStore.getState(); return JSON.stringify({ filter: s.searchFilter, query: s.searchQuery }); }
function decode(content: string): { filter: SearchFilterStateValue; query: string } {
  const value: unknown = JSON.parse(content);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('A native filter/query configuration object is required.');
  const outer = value as Record<string, unknown>, raw = outer.filter;
  if (Object.keys(outer).some(key => !['filter', 'query'].includes(key)) || typeof outer.query !== 'string' || outer.query.length > 1000
    || !raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid native filter/query configuration.');
  const filter = raw as Record<string, unknown>, groups = parseFilterGroups(filter.groups);
  if (!groups || Object.keys(filter).some(key => !['groups', 'limit', 'capturedScope'].includes(key))
    || typeof filter.limit !== 'number' || !Number.isSafeInteger(filter.limit) || filter.limit < 0 || filter.limit > 100000
    || (filter.capturedScope !== undefined && !isCapturedEntityScope(filter.capturedScope))) throw new Error('Invalid native Rules groups, limit or captured scope.');
  return { filter: { groups, limit: filter.limit, ...(filter.capturedScope ? { capturedScope: filter.capturedScope } : {}) } as SearchFilterStateValue, query: outer.query };
}
function unchanged(value: string) { if (configuration() !== value) throw new Error('Native filter/query configuration changed; inspect again.'); }
async function evaluate(c: ViewerOperationContext, value: string) {
  unchanged(value);
  const before = useViewerStore.getState(), stamp = analysisStampFrom(before), models = before.models;
  if (!totalRuleCount(before.searchFilter.groups)) throw new Error('Native Filter Run requires at least one rule.');
  const result = await evaluateViewerFilter(before, before.searchFilter, before.searchQuery, {
    signal: c.signal, onProgress: (done, total) => c.progress?.({ phase: 'filter', done, total }),
  });
  c.checkpoint?.(); unchanged(value);
  const now = useViewerStore.getState();
  if (isAnalysisStale(stamp, now) || now.models !== models || now.ifcDataStore !== before.ifcDataStore
    || now.modelTags !== before.modelTags || now.modelTagAssignments !== before.modelTagAssignments) throw new Error('Native filter source/tag revision changed during evaluation.');
  return { ...result, stamp };
}
export const searchOperations = [
  viewerOperation(metadata('filters.state', 'Read the native Search Filter configuration snapshot, current saved preset catalog, run status and result count. configuration_json is the exact expected_json guard for edits/run/export. Rules use the canonical FilterGroup/FilterRule codec, with text/captured-scope intersection.'), emptySchema, () => {
    const s = useViewerStore.getState(); return wire({ configuration_json: configuration(), presets: loadSavedFilters(), running: s.searchFilterRunning,
      error: s.searchFilterError, result_rows: s.searchFilterResult?.rows.length ?? 0 });
  }),
  viewerOperation<{ expected_json: string; configuration_json: string }>(metadata('filters.configure', 'Replace every native Search Filter group/combinator/rule, limit/captured scope and intersecting text query through the native parser and setters. Refuses stale configuration and a currently running native UI filter.', true), {
    type: 'object', properties: { expected_json: expected, configuration_json: expected }, required: ['expected_json', 'configuration_json'], additionalProperties: false,
  }, (i, c) => {
    unchanged(i.expected_json); const next = decode(i.configuration_json);
    if (useViewerStore.getState().searchFilterRunning) throw new Error('The native UI filter is running.');
    c.commit(() => { unchanged(i.expected_json); const s = useViewerStore.getState(); s.setSearchFilter(next.filter); s.setSearchQuery(next.query); });
    return wire({ configuration_json: configuration() });
  }),
  viewerOperation<{ expected_json: string }>(metadata('filters.run', 'Await the exact native Search Filter engine and publish its actual complete result to the native Search UI. Returns a 100-row preview and accurate count/limit-hit status. Native text/captured-scope semantics, progress and cancellation match the UI; source/configuration changes refuse publication.', true), {
    type: 'object', properties: { expected_json: expected }, required: ['expected_json'], additionalProperties: false,
  }, async (i, c) => {
    const before = useViewerStore.getState(); if (before.searchFilterRunning) throw new Error('The native UI filter is running.');
    const result = await evaluate(c, i.expected_json);
    c.commit(() => {
      const s = useViewerStore.getState(); unchanged(i.expected_json);
      if (s.searchFilterRunning || s.searchFilterResult !== before.searchFilterResult) throw new Error('Another native filter run superseded this request.');
      s.setSearchFilterResult(stampAnalysisReport(result.result, result.stamp));
    });
    return wire({ total: result.result.rows.length, limit_hit: result.limitHit, columns: result.result.columns, preview: result.result.rows.slice(0, 100), run_ms: result.result.runMs });
  }),
  viewerOperation<{ offset: number; limit: number }>(metadata('filters.results', 'Read a bounded page of the native Search Filter result. current=false means its recorded source revision changed; null means a legacy/native UI result did not record a revision. Never presents that unverified result as a fresh analysis.'), {
    type: 'object', properties: { offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 500 } }, required: ['offset', 'limit'], additionalProperties: false,
  }, i => {
    const s = useViewerStore.getState(), result = s.searchFilterResult;
    const stamp = analysisStampOf(result);
    return wire({ current: stamp ? !isAnalysisStale(stamp, s) : null, columns: result?.columns ?? [], total: result?.rows.length ?? 0, rows: result?.rows.slice(i.offset, i.offset + i.limit) ?? [] });
  }),
  viewerOperation<{ expected_json: string; name: string; action: 'save' | 'delete'; expected_catalog_json: string }>(metadata('filters.preset', 'Save the exact current native filter or delete a named native preset using the same durable codec/catalog as the builder. expected_catalog_json must match JSON.stringify(presets) from filters.state. Reports native storage refusal without claiming persistence.', true), {
    type: 'object', properties: { expected_json: expected, name: { type: 'string', minLength: 1, maxLength: 80 }, action: { type: 'string', enum: ['save', 'delete'] }, expected_catalog_json: expected }, required: ['expected_json', 'name', 'action', 'expected_catalog_json'], additionalProperties: false,
  }, (i, c) => {
    unchanged(i.expected_json);
    return c.commit(() => {
      if (JSON.stringify(loadSavedFilters()) !== i.expected_catalog_json) throw new Error('Native saved filter catalog changed.');
      const s = useViewerStore.getState();
      const saved = i.action === 'save' ? saveFilter(i.name, s.searchFilter.groups, s.searchFilter.capturedScope) : deleteSavedFilter(i.name);
      if (!saved.persisted) throw new Error('Native filter preset persistence failed.');
      return wire(saved);
    });
  }),
  viewerOperation<{ expected_json: string; format: 'csv' | 'json' }>({ ...metadata('filters.export', 'Await native Filter Run and produce the native CSV/JSON writer output as a connection-owned artifact; no browser download.'),
    effects: ['artifact'], capability: 'commands-and-edits', features: ['export.files'], policy: { artifact: 'native-export' },
    outputSchema: { type: 'object', properties: { artifact_json: { type: 'string' }, rows: { type: 'integer' }, limit_hit: { anyOf: [{ type: 'integer' }, { type: 'null' }] } }, required: ['artifact_json', 'rows', 'limit_hit'], additionalProperties: false },
  }, { type: 'object', properties: { expected_json: expected, format: { type: 'string', enum: ['csv', 'json'] } }, required: ['expected_json', 'format'], additionalProperties: false }, async (i, c) => {
    const result = await evaluate(c, i.expected_json);
    const artifact = await c.artifacts.create({ data: i.format === 'csv' ? formatCsv(result.result) : formatJson(result.result), filename: `filter-result.${i.format}`, mimeType: i.format === 'csv' ? 'text/csv' : 'application/json' });
    return { artifact_json: JSON.stringify(artifact), rows: result.result.rows.length, limit_hit: result.limitHit };
  }),
];
