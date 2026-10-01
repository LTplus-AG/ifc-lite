/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { beforeEach, afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { act } from 'react';
import { IfcParser } from '@ifc-lite/parser';
import { diffModels } from '@ifc-lite/diff';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import type { ChartDataset, ChartSource, ChartSpec } from '@ifc-lite/charts';
import { buildEntityFingerprints } from '@/lib/compare/buildFingerprints';
import { effectiveComparePair } from '@/lib/compare/effectiveCompareStore';
import { snapshotComparison, type SavedComparison } from '@/lib/compare/savedComparisons';
import { buildCompareDataset } from '@/lib/charts/datasets/compare';
import { loadDashboards, parseDashboardFile } from '@/lib/charts/persistence';
import type { CompareResult } from '@/store/slices/compareSlice';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { render, cleanup, click } from '@/test/render';
import { ChartEditor } from './ChartEditor';

const original = useViewerStore.getState();
const catalog = { attributes: [], properties: new Map(), quantities: new Map(), relations: [] };
let saved: SavedComparison[];
let live: CompareResult;

// Real SketchUp source and the repository's derived revision B, plus an
// explicitly authored StoreEditor rename on B. No handcrafted diff/report.
beforeEach(async () => {
  localStorage.clear();
  const models = await Promise.all(['A', 'B', 'C'].map(async (id) => {
    const name = id === 'A' ? 'building-architecture.ifc' : 'building-architecture-rev-b.ifc';
    const bytes = await readFile(new URL(`../../../../public/samples/${name}`, import.meta.url));
    const store = await new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    return { ...fixtureModel(id), name: id === 'C' ? 'Declared renamed revision C' : name, schemaVersion: 'IFC4' as const, ifcDataStore: store };
  }));
  const c = models[2], view = new MutablePropertyView(c.ifcDataStore.properties, c.id);
  const wall = c.ifcDataStore.entities.getExpressIdByGlobalId('1AQAupaRP1txwK1AGiN61V');
  assert.ok(wall, 'real source wall exists before the declared rename');
  new StoreEditor(c.ifcDataStore, view).setAttribute(wall, 'Name', 'Explicit chart test revision C wall');
  const run = async (baseIndex: number, headIndex: number): Promise<CompareResult> => {
    const base = models[baseIndex], head = models[headIndex];
    const { baseEffective, headEffective, comparedStores } = await effectiveComparePair(
      [base, base.ifcDataStore], [head, head.ifcDataStore], (id) => id === 'C' ? view : null);
    const baseFingerprints = await buildEntityFingerprints({ modelId: base.id, store: baseEffective, meshes: [], idOffset: base.idOffset });
    const headFingerprints = await buildEntityFingerprints({ modelId: head.id, store: headEffective, meshes: [], idOffset: head.idOffset });
    return { baseModelId: base.id, headModelId: head.id, baseName: base.name, headName: head.name,
      scope: 'data', geometryUnavailable: true, excludedHiddenIds: new Set(), mutationVersion: 0, comparedStores,
      diff: diffModels(baseFingerprints, headFingerprints, { scope: 'data' }) };
  };
  const ab = await run(0, 1); live = await run(1, 2);
  const federation = fixtureModels(...models);
  saved = [snapshotComparison(ab, federation.models, 'Public derived A to B'), snapshotComparison(live, federation.models, 'Declared B to C rename')];
  assert.ok(saved[0].report.rows.some((row) => row.state === 'added'));
  assert.ok(saved[0].report.rows.some((row) => row.state === 'deleted'));
  assert.ok(saved[1].report.rows.some((row) => row.name === 'Explicit chart test revision C wall'));
  assert.notDeepEqual(saved[0].report.rows, saved[1].report.rows);
  useViewerStore.setState({ ...federation, savedComparisons: [], savedComparisonsLoadIssue: null,
    dashboards: [], activeDashboardId: null, compareResult: live, compareRunSeq: 2,
    mutationViews: new Map(), mutationVersion: 0, chartSlice: null, chartSliceSource: null, chartSliceBuckets: null });
  for (const snapshot of saved) assert.equal(useViewerStore.getState().saveComparison(snapshot), true);
});
afterEach(() => { cleanup(); useViewerStore.setState(original); localStorage.clear(); });

const chart = (): ChartSpec => ({ id: 'chosen-comparison', title: 'Selected comparison', source: 'compare', type: 'bar', dimension: 'State', measure: { agg: 'count' } });
function datasets(): Record<ChartSource, ChartDataset> {
  const empty = (source: ChartSource): ChartDataset => ({ source, columns: [], rows: [], fingerprint: source });
  return { elements: empty('elements'), clash: empty('clash'), bcf: empty('bcf'), schedule: empty('schedule'), ids: empty('ids'), compare: buildCompareDataset(useViewerStore.getState()) };
}
function choose(select: HTMLSelectElement, value: string): void {
  act(() => { select.value = value; select.dispatchEvent(new window.Event('change', { bubbles: true })); });
}

describe('Saved comparison chart source (#6549)', () => {
  it('offers completed canonical comparisons and persists the chosen source through dashboard reload/import', () => {
    let accepted: ChartSpec | undefined;
    const ui = render(<ChartEditor spec={chart()} datasets={datasets()} onSave={(spec) => { accepted = spec; }} onCancel={() => {}}
      elementFieldCatalog={catalog} elementFieldCatalogLoading={false} />);
    const picker = ui.querySelector<HTMLSelectElement>('select[aria-label="Saved comparison"]');
    assert.ok(picker, 'chart authors can choose an actual saved comparison instead of the latest live result');
    assert.deepEqual([...picker.options].filter((option) => option.value).map((option) => option.value), saved.map((snapshot) => snapshot.id));
    choose(picker, saved[0].id);
    const save = [...ui.querySelectorAll('button')].find((button) => button.textContent === 'Save chart'); assert.ok(save); click(save);
    assert.ok(accepted); assert.equal(accepted.comparisonId, saved[0].id);
    const dashboard = { version: 2 as const, id: 'saved-source', name: 'Chosen source', scope: { kind: 'all' as const }, charts: [accepted], layout: [{ chartId: accepted.id, x: 0, y: 0, w: 6, h: 4 }] };
    useViewerStore.getState().upsertDashboard(dashboard);
    assert.equal(loadDashboards()[0].charts[0].comparisonId, saved[0].id);
    assert.equal(parseDashboardFile(JSON.stringify(dashboard)).charts[0].comparisonId, saved[0].id);
  });
});
