/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Saving reviewed artifacts into the native libraries and reopening them
 * (viewer AI P13, #6914): each lands through the library's own write path,
 * survives a reload from storage, reruns to the reviewed numbers, and opening
 * it never touches selection, isolation or visibility.
 */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, before, beforeEach, test } from 'node:test';
import { useViewerStore } from '@/store';
import { loadListDefinitions } from '@/lib/lists/persistence';
import { loadSavedFilters, saveFilter, clearSavedFilters } from '@/lib/search/saved-filters';
import { loadDashboards } from '@/lib/charts/persistence';
import { migrateSavedLens } from '@/lib/lens/migrate-saved-lens';
import { seedArtifactModels } from '@/test/artifact-models-fixture';
import { previewArtifact } from './artifact-preview';
import { parseArtifactProposal, type ArtifactKind } from './proposal-kinds';
import { openSavedArtifact, saveArtifact, uniqueName } from './artifact-save';

const initial = useViewerStore.getState();
before(async () => { await seedArtifactModels(); });
beforeEach(() => {
  localStorage.clear();
  clearSavedFilters();
  useViewerStore.setState({ listDefinitions: [], dashboards: [], activeDashboardId: null, savedLenses: initial.savedLenses, pendingListDraft: null,
    searchModalOpen: false, listPanelVisible: false, chartPanelVisible: false, lensPanelVisible: false });
});
afterEach(() => localStorage.clear());
const review = (value: { kind: ArtifactKind } & Record<string, unknown>) =>
  previewArtifact(parseArtifactProposal(JSON.stringify({ version: 1, title: 'T', ...value }), value.kind), useViewerStore.getState());
const walls = { combinator: 'AND', rules: [{ kind: 'ifcType', op: 'in', values: ['IfcWall'] }] };

test('a list saves into the Lists library, survives reload, reruns to the reviewed rows and opens in the builder', async () => {
  const reviewed = await review({ kind: 'list.proposal', list: { name: 'Wall areas', entityTypes: ['IfcWall'], columns: [
    { id: 'name', source: 'attribute', propertyName: 'Name' }, { id: 'area', source: 'quantity', psetName: 'Qto_WallBaseQuantities', propertyName: 'NetSideArea' }] } });
  const outcome = saveArtifact(reviewed.artifact);
  assert.ok(outcome.ok && outcome.saved.kind === 'list.proposal');
  const [reloaded] = loadListDefinitions();
  assert.equal(reloaded.name, 'Wall areas');
  assert.deepEqual(reloaded.columns, reviewed.artifact.kind === 'list.proposal' ? reviewed.artifact.definition.columns : null);
  const rerun = await previewArtifact(parseArtifactProposal(JSON.stringify({ version: 1, kind: 'list.proposal', title: 'T', list: {
    name: reloaded.name, entityTypes: ['IfcWall'], columns: reloaded.columns } }), 'list.proposal'), useViewerStore.getState());
  assert.equal(rerun.matched, reviewed.matched);
  const selection = useViewerStore.getState().selectedEntityIds;
  openSavedArtifact(outcome.saved, reviewed.artifact);
  assert.equal(useViewerStore.getState().pendingListDraft?.id, outcome.saved.id, 'the list builder opens on the saved list');
  assert.equal(useViewerStore.getState().listPanelVisible, true);
  assert.equal(useViewerStore.getState().selectedEntityIds, selection);
  assert.deepEqual(saveArtifact(reviewed.artifact), { ok: false, reason: 'already-saved' }, 'saving the same review twice does not duplicate it');
});

test('a filter saves as a new saved filter, never over one the user already has, and opens in the Filter tab', async () => {
  saveFilter('Walls', [{ combinator: 'AND', rules: [] }]);
  const reviewed = await review({ kind: 'filter.proposal', name: 'Walls', groups: [walls] });
  const outcome = saveArtifact(reviewed.artifact);
  assert.ok(outcome.ok);
  assert.equal(outcome.saved.name, 'Walls (2)');
  const presets = loadSavedFilters();
  assert.deepEqual(presets.map((preset) => preset.name), ['Walls', 'Walls (2)']);
  assert.deepEqual(presets[1].groups, reviewed.artifact.kind === 'filter.proposal' ? reviewed.artifact.groups : null);
  const isolated = useViewerStore.getState().isolatedEntities;
  openSavedArtifact(outcome.saved, reviewed.artifact);
  const state = useViewerStore.getState();
  assert.equal(state.searchModalOpen, true);
  assert.equal(state.searchModalTab, 'filter');
  assert.equal(state.searchFilterAutoRunPending, true, 'the Filter tab runs it natively when it mounts');
  assert.deepEqual(state.searchFilter.groups, presets[1].groups);
  assert.equal(state.isolatedEntities, isolated, 'opening applies nothing to the scene');
  // A double click on Save: the second save of the same review is refused, not written as "Walls (3)" (#6914 review).
  assert.deepEqual(saveArtifact(reviewed.artifact), { ok: false, reason: 'already-saved' });
  assert.deepEqual(loadSavedFilters().map((preset) => preset.name), ['Walls', 'Walls (2)']);
  const again = await review({ kind: 'filter.proposal', name: 'Walls', groups: [walls] });
  assert.ok(saveArtifact(again.artifact).ok, 'a new review of the same proposal is a new save');
});

test('a lens saves into the lens library through createLens and reloads through the saved-lens migration', async () => {
  const reviewed = await review({ kind: 'lens.proposal', lens: { name: 'Walls', rules: [{ name: 'Walls', groups: [walls], action: 'colorize', color: '#E53935' }] } });
  const outcome = saveArtifact(reviewed.artifact);
  assert.ok(outcome.ok && outcome.saved.kind === 'lens.proposal');
  const savedId = outcome.saved.id;
  const stored: unknown[] = JSON.parse(localStorage.getItem('ifc-lite-custom-lenses') ?? '[]');
  const reloaded = stored.map(migrateSavedLens).find((lens) => lens?.id === savedId);
  assert.equal(reloaded?.rules[0].groups[0].rules[0].kind, 'ifcType');
  assert.equal(useViewerStore.getState().activeLensId, initial.activeLensId, 'saving does not apply the lens');
  openSavedArtifact(outcome.saved, reviewed.artifact);
  assert.equal(useViewerStore.getState().lensPanelVisible, true);
});

test('a chart joins the active dashboard of the same scope, or gets its own dashboard in the reviewed scope', async () => {
  useViewerStore.getState().upsertDashboard({ version: 2, id: 'd-all', name: 'Overview', scope: { kind: 'all' },
    charts: [{ id: 'x', title: 'Count', source: 'elements', type: 'elementCount', measure: { agg: 'count' } }], layout: [{ chartId: 'x', x: 0, y: 0, w: 6, h: 4 }] });
  useViewerStore.setState({ activeDashboardId: 'd-all' });
  const all = await review({ kind: 'chart.proposal', chart: { type: 'bar', dimension: 'IfcType', measure: { agg: 'count' } } });
  const joined = saveArtifact(all.artifact);
  assert.ok(joined.ok && joined.saved.kind === 'chart.proposal' && joined.saved.dashboardId === 'd-all');
  const overview = loadDashboards().find((d) => d.id === 'd-all');
  assert.deepEqual(overview?.charts.map((chart) => chart.id), ['x', joined.saved.id]);
  assert.deepEqual(overview?.layout.at(-1), { chartId: joined.saved.id, x: 0, y: 4, w: 6, h: 4 });
  const visible = await review({ kind: 'chart.proposal', scope: 'visible', chart: { type: 'pie', dimension: 'Storey', measure: { agg: 'count' } } });
  const own = saveArtifact(visible.artifact);
  assert.ok(own.ok && own.saved.kind === 'chart.proposal' && own.saved.dashboardId !== 'd-all');
  const ownDashboard = own.saved.dashboardId;
  assert.deepEqual(loadDashboards().find((d) => d.id === ownDashboard)?.scope, { kind: 'visible' });
  openSavedArtifact(own.saved, visible.artifact);
  assert.equal(useViewerStore.getState().activeDashboardId, own.saved.dashboardId);
  assert.equal(useViewerStore.getState().chartPanelVisible, true);
});

test('unique names keep the user\'s entries', () => {
  assert.equal(uniqueName('Walls', ['walls', 'Walls (2)']), 'Walls (3)');
  assert.equal(uniqueName('Doors', ['Walls']), 'Doors');
});
