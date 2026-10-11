/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { IfcParser } from '@ifc-lite/parser';
import { diffModels } from '@ifc-lite/diff';
import { aggregate, type ChartSpec } from '@ifc-lite/charts';
import { CLASH_COLUMNS } from '@/lib/charts/datasets/clash';
import { COMPARE_COLUMNS } from '@/lib/charts/datasets/compare';
import { chartSourceContext, resolveChartSource } from '@/lib/charts/chart-source';
import { buildEntityFingerprints } from '@/lib/compare/buildFingerprints';
import { snapshotComparison } from '@/lib/compare/savedComparisons';
import { blankDocument } from '@/lib/document/presets';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from './store-fixture';
import { clearContentDatabase } from './content-fixture';
import { cleanup } from './render';

const original = useViewerStore.getState();
export const button = (root: ParentNode, name: string) => [...root.querySelectorAll('button')].find(node => node.textContent?.trim() === name);
export function setupReportDeletionFixtures() {
  beforeEach(async () => { localStorage.clear(); await clearContentDatabase(); useViewerStore.setState({ dashboards: [], documents: [] }); });
  afterEach(() => { cleanup(); useViewerStore.setState(original); localStorage.clear(); });
}
export async function dependents(source: 'compare' | 'clash', id: string) {
  const spec: ChartSpec = { id: 'dependent-chart', title: 'External report chart', source, type: 'bar', dimension: source === 'compare' ? COMPARE_COLUMNS.state : CLASH_COLUMNS.rule, measure: { agg: 'count' },
    ...(source === 'compare' ? { comparisonId: id } : { clashReportId: id }) };
  const bound = resolveChartSource(spec, { source, columns: [], rows: [], fingerprint: 'empty-live-control' }, chartSourceContext(useViewerStore.getState()));
  assert.ok(aggregate(spec, bound.dataset).total > 0, 'the native saved-report chart must actually aggregate before it becomes a deletion dependency');
  useViewerStore.getState().upsertDashboard({ version: 2, id: 'dependent-dashboard', name: 'Affected dashboard', scope: { kind: 'all' }, charts: [spec], layout: [] });
  await useViewerStore.getState().initializeDocuments();
  const document = { ...blankDocument(), name: 'Affected document', blocks: [{ kind: 'chart' as const, id: 'dependent-block', snapshot: true, chart: { ...spec, title: 'Document report chart' } }] };
  assert.equal(await useViewerStore.getState().upsertDocument(document), true);
  assert.equal(useViewerStore.getState().dashboards[0].charts[0].source, source);
  assert.equal(useViewerStore.getState().documents.find(row => row.id === document.id)?.blocks[0].kind, 'chart');
}
export async function realComparison() {
  const models = await Promise.all(['A', 'B'].map(async id => {
    const bytes = await readFile(new URL(`../../public/samples/building-architecture${id === 'B' ? '-rev-b' : ''}.ifc`, import.meta.url));
    const store = await new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    return { ...fixtureModel(id), ifcDataStore: store };
  }));
  const fingerprints = await Promise.all(models.map(model => buildEntityFingerprints({ modelId: model.id, store: model.ifcDataStore, meshes: [], idOffset: model.idOffset })));
  const diff = diffModels(fingerprints[0], fingerprints[1], { scope: 'data' });
  const federation = fixtureModels(...models); useViewerStore.setState(federation);
  const report = snapshotComparison({ baseModelId: 'A', headModelId: 'B', baseName: 'A', headName: 'B', scope: 'data', geometryUnavailable: true,
    excludedHiddenIds: new Set(), mutationVersion: 0, diff }, federation.models, 'Actual SketchUp revision pair');
  assert.ok(report.report.rows.some(row => row.state === 'added'));
  assert.ok(report.report.rows.some(row => row.state === 'deleted'));
  await useViewerStore.getState().initializeSavedComparisons();
  assert.equal(await useViewerStore.getState().saveComparison(report), true);
  return report;
}
