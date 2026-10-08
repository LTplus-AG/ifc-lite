/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { act } from 'react';
import { render, cleanup, advance, click, type as typeInput } from '@/test/render';
import { seedArtifactModels } from '@/test/artifact-models-fixture';
import { useViewerStore } from '@/store';
import { LensPanel } from '@/components/viewer/LensPanel';
import { ChartsPanel } from '@/components/viewer/charts/ChartsPanel';
import type { ChartRenderer } from '@/components/viewer/charts/useEChart';
import { previewArtifact } from './artifact-preview';
import { parseArtifactProposal, type ArtifactKind } from './proposal-kinds';
import { openSavedArtifact, saveArtifact } from './artifact-save';
import { migrateSavedLens } from '@/lib/lens/migrate-saved-lens';
import { loadDashboards } from '@/lib/charts/persistence';
import { previewLens } from './preview-lens';
import { aggregate } from '@ifc-lite/charts';
import { buildElementsDataset } from '@/lib/charts/datasets/elements';

const pristine = useViewerStore.getState();
beforeEach(async () => {
  localStorage.clear();
  useViewerStore.setState(pristine, true);
  await seedArtifactModels();
  useViewerStore.setState({ dashboards: [], activeDashboardId: null, savedLenses: [], activeLensId: null });
});
afterEach(() => { cleanup(); localStorage.clear(); useViewerStore.setState(pristine, true); });

const review = (value: { kind: ArtifactKind } & Record<string, unknown>) =>
  previewArtifact(parseArtifactProposal(JSON.stringify({ version: 1, title: 'Review', ...value }), value.kind), useViewerStore.getState());
const walls = { combinator: 'AND', rules: [{ kind: 'ifcType', op: 'in', values: ['IfcWall'] }] };
// Only the canvas boundary is replaced. Native editor controls, datasets,
// saved libraries, field discovery and persistence execute unchanged.
const renderer: ChartRenderer = async () => () => ({ setOption: () => {}, select: () => {}, resize: () => {}, dispose: () => {} });
function nameInput(ui: HTMLElement, name: string): HTMLInputElement | undefined {
  return [...ui.querySelectorAll('input')].find(input => input.value === name);
}
function editorButton(ui: HTMLElement, action: 'save' | 'cancel'): HTMLButtonElement {
  const button = [...ui.querySelectorAll('button')].find(item => new RegExp(action, 'i').test(item.textContent?.trim() ?? ''));
  assert.ok(button, `native ${action} control is visible`);
  assert.equal(button.disabled, false, `native ${action} control accepts this saved item`);
  return button;
}
async function savedReview(kind: 'lens.proposal' | 'chart.proposal', name: string) {
  const reviewed = await review(kind === 'lens.proposal'
    ? { kind, lens: { name, rules: [{ name: 'Walls', groups: [walls], action: 'colorize', color: '#E53935' }] } }
    : { kind, title: name, chart: { type: 'bar', dimension: 'IfcType', measure: { agg: 'count' } } });
  const saved = saveArtifact(reviewed.artifact);
  assert.ok(saved.ok);
  assert.ok(saved.saved.kind === 'lens.proposal' || saved.saved.kind === 'chart.proposal');
  return { target: saved.saved, artifact: reviewed.artifact };
}
function nativePanel(kind: 'lens.proposal' | 'chart.proposal') {
  return kind === 'lens.proposal' ? <LensPanel /> : <ChartsPanel renderer={renderer} />;
}

for (const kind of ['lens.proposal', 'chart.proposal'] as const) {
  test(`#7167 ${kind} ordinary native library opening remains available`, async () => {
    const { target, artifact } = await savedReview(kind, 'Library control');
    act(() => openSavedArtifact(target, artifact));
    const ui = render(nativePanel(kind));
    await advance(25);
    assert.ok(ui.textContent?.includes(target.name) || nameInput(ui, target.name), 'the actual native panel exposes its saved entry');
  });
  test(`#7167 ${kind} Cancel preserves storage and consumed requests cannot reopen after remount`, async () => {
    const { target, artifact } = await savedReview(kind, 'Cancel control');
    const before = kind === 'lens.proposal' ? localStorage.getItem('ifc-lite-custom-lenses') : loadDashboards();
    act(() => openSavedArtifact(target, artifact));
    const ui = render(nativePanel(kind));
    await advance(25);
    const input = nameInput(ui, target.name);
    assert.ok(input);
    typeInput(input, 'Discard this edit');
    click(editorButton(ui, 'cancel'));
    assert.deepEqual(kind === 'lens.proposal' ? localStorage.getItem('ifc-lite-custom-lenses') : loadDashboards(), before);
    cleanup();
    const remounted = render(nativePanel(kind));
    await advance(25);
    assert.equal(nameInput(remounted, target.name), undefined, 'the consumed request cannot reopen the editor');
  });
  test(`#7167 ${kind} queued A to B and mounted repeated requests resolve current saved identities`, async () => {
    const a = await savedReview(kind, 'Target A');
    const b = await savedReview(kind, 'Target B');
    act(() => { openSavedArtifact(a.target, a.artifact); openSavedArtifact(b.target, b.artifact); });
    const ui = render(nativePanel(kind));
    await advance(25);
    assert.ok(nameInput(ui, b.target.name));
    assert.equal(nameInput(ui, a.target.name), undefined);
    act(() => openSavedArtifact(a.target, a.artifact));
    await advance(25);
    const aInput = nameInput(ui, a.target.name);
    assert.ok(aInput);
    typeInput(aInput, 'Unsaved A changes');
    act(() => openSavedArtifact(b.target, b.artifact));
    await advance(25);
    assert.ok(nameInput(ui, b.target.name));
    act(() => {
      const state = useViewerStore.getState();
      const target = b.target;
      if (target.kind === 'lens.proposal') state.updateLens(target.id, { name: 'Current saved B' });
      else if (target.kind === 'chart.proposal') {
        const dashboard = state.dashboards.find(item => item.id === target.dashboardId);
        assert.ok(dashboard);
        state.upsertDashboard({ ...dashboard, charts: dashboard.charts.map(chart => chart.id === target.id ? { ...chart, title: 'Current saved B' } : chart) });
      }
      openSavedArtifact(b.target, b.artifact);
    });
    await advance(25);
    assert.ok(nameInput(ui, 'Current saved B'), 'a repeated same-ID request resets the native editor to current persisted fields');
    assert.equal(nameInput(ui, b.target.name), undefined, 'the older review does not overwrite newer saved fields');
  });
  test(`#7167 ${kind} deleted targets are consumed without recreation or editing another item`, async () => {
    const { target, artifact } = await savedReview(kind, 'Deleted target');
    act(() => {
      openSavedArtifact(target, artifact);
      const state = useViewerStore.getState();
      if (target.kind === 'lens.proposal') state.deleteLens(target.id);
      else if (target.kind === 'chart.proposal') state.deleteDashboard(target.dashboardId);
    });
    const ui = render(nativePanel(kind));
    await advance(25);
    assert.equal(nameInput(ui, target.name), undefined);
    assert.equal(useViewerStore.getState().savedLenses.some(lens => target.kind === 'lens.proposal' && lens.id === target.id), false);
    assert.equal(useViewerStore.getState().dashboards.some(dashboard => dashboard.charts.some(chart => target.kind === 'chart.proposal' && chart.id === target.id)), false);
  });
}

test('#7167 a reviewed saved lens opens its native editor on the actual saved item', async () => {
  const reviewed = await review({ kind: 'lens.proposal', lens: { name: 'Reviewed walls', rules: [{ name: 'Walls', groups: [walls], action: 'colorize', color: '#E53935' }] } });
  assert.ok(reviewed.matched > 0, 'real SketchUp walls supply the reviewed population');
  const saved = saveArtifact(reviewed.artifact);
  assert.ok(saved.ok && saved.saved.kind === 'lens.proposal');
  const target = saved.saved;
  const selection = useViewerStore.getState().selectedEntityIds;
  act(() => openSavedArtifact(target, reviewed.artifact));
  const ui = render(<LensPanel />);
  await advance(25);
  const input = nameInput(ui, target.name);
  assert.ok(input, 'Open must expose the native editable saved lens Name');
  assert.equal(useViewerStore.getState().activeLensId, null);
  assert.equal(useViewerStore.getState().selectedEntityIds, selection);
  const originalRules = useViewerStore.getState().savedLenses.find(lens => lens.id === target.id)?.rules;
  typeInput(input, 'Edited reviewed walls');
  click(editorButton(ui, 'save'));
  const stored: unknown[] = JSON.parse(localStorage.getItem('ifc-lite-custom-lenses') ?? '[]');
  const reloaded = stored.map(migrateSavedLens).find(lens => lens?.id === target.id);
  assert.equal(reloaded?.name, 'Edited reviewed walls');
  assert.deepEqual(reloaded?.rules, originalRules, 'native editing preserves the reviewed source rules');
  assert.ok(reloaded);
  const rerun = await previewLens({ version: 1, kind: 'lens.proposal', title: 'Native saved lens', lens: reloaded }, useViewerStore.getState());
  assert.equal(rerun.matched, reviewed.matched, 'the persisted edited lens reruns to its reviewed real-model population');
});

test('#7167 a reviewed saved chart opens its native editor on the actual dashboard item', async () => {
  const reviewed = await review({ kind: 'chart.proposal', chart: { type: 'bar', dimension: 'IfcType', measure: { agg: 'count' } } });
  assert.ok(reviewed.matched > 0, 'real SketchUp elements supply the reviewed population');
  const saved = saveArtifact(reviewed.artifact);
  assert.ok(saved.ok && saved.saved.kind === 'chart.proposal');
  const target = saved.saved;
  const selection = useViewerStore.getState().selectedEntityIds;
  act(() => openSavedArtifact(target, reviewed.artifact));
  const ui = render(<ChartsPanel renderer={renderer} />);
  await advance(25);
  const input = nameInput(ui, target.name);
  assert.ok(input, 'Open must expose the native editable saved chart Title');
  assert.equal(useViewerStore.getState().activeDashboardId, target.dashboardId);
  assert.equal(useViewerStore.getState().selectedEntityIds, selection);
  assert.equal(useViewerStore.getState().chartSlice, null);
  const original = loadDashboards().find(dashboard => dashboard.id === target.dashboardId)?.charts.find(chart => chart.id === target.id);
  typeInput(input, 'Edited reviewed counts');
  click(editorButton(ui, 'save'));
  const reloaded = loadDashboards().find(dashboard => dashboard.id === target.dashboardId)?.charts.find(chart => chart.id === target.id);
  assert.deepEqual(reloaded, { ...original, title: 'Edited reviewed counts' }, 'native editing preserves the reviewed source, filter and measures');
  assert.ok(reloaded);
  const dashboard = loadDashboards().find(item => item.id === target.dashboardId);
  assert.ok(dashboard);
  assert.equal(aggregate(reloaded, buildElementsDataset(dashboard.scope, [], useViewerStore.getState())).total, reviewed.matched, 'the persisted edited chart reruns to its reviewed real-model count');
});

test('#7167 auto-color proposals reuse the native AutoColorEditor and preserve their source on Save', async () => {
  const reviewed = await review({ kind: 'lens.proposal', lens: { name: 'Reviewed auto colors', autoColor: { source: 'ifcType' } } });
  assert.ok(reviewed.matched > 0);
  const saved = saveArtifact(reviewed.artifact);
  assert.ok(saved.ok && saved.saved.kind === 'lens.proposal');
  const target = saved.saved;
  const original = useViewerStore.getState().savedLenses.find(lens => lens.id === target.id)?.autoColor;
  act(() => openSavedArtifact(target, reviewed.artifact));
  const ui = render(<LensPanel />);
  await advance(25);
  const input = nameInput(ui, target.name);
  assert.ok(input);
  assert.ok([...ui.querySelectorAll('select')].some(select => select.value === 'ifcType'), 'the actual native auto-color source editor is open');
  typeInput(input, 'Edited auto colors');
  click(editorButton(ui, 'save'));
  const stored: unknown[] = JSON.parse(localStorage.getItem('ifc-lite-custom-lenses') ?? '[]');
  const reloaded = stored.map(migrateSavedLens).find(lens => lens?.id === target.id);
  assert.ok(reloaded);
  assert.deepEqual(reloaded.autoColor, original);
  const rerun = await previewLens({ version: 1, kind: 'lens.proposal', title: 'Native saved auto color', lens: reloaded }, useViewerStore.getState());
  assert.equal(rerun.matched, reviewed.matched);
});
