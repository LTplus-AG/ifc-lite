/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Saved clash reports as a chart source (#6947), driven through the real
 * panels: the Clash panel runs the real detection and saves reports through
 * its dialog, and the Charts panel binds charts through the real chart editor.
 *
 * Every pair of N coincident walls clashes, so a run over N walls has
 * N(N-1)/2 clashes. Runs A, B and C use 2, 3 and 4 walls: populations 1, 3
 * and 6, which no chart can show by reading the wrong run.
 */

import '@/test/setup-dom.js';
import '@/test/content-fixture.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createClashEngine, type ClashElement } from '@ifc-lite/clash';
import { loadDashboards } from '@/lib/charts/persistence';
import { readContentRows } from '@/lib/storage/content-database';
import type { ContentKind } from '@/lib/storage/content-kinds';
import { useViewerStore } from '@/store';
import { cleanup, click, render, type } from '@/test/render';
import { seedCoincidentWalls } from '@/test/clash-run-fixture';
import { deleteSavedReport, detectCoincidentWalls, mountClashPanel, saveCurrentResultAs, savedClashReports } from '@/test/clash-report-fixture';
import { ChartsPanel } from './ChartsPanel';
import type { ChartRenderer } from './useEChart';

const original = useViewerStore.getState();
const renderer: ChartRenderer = async () => () => ({ setOption: () => {}, select: () => {}, resize: () => {}, dispose: () => {} });
const DASHBOARD = { version: 2 as const, id: 'clash-runs', name: 'Clash runs', scope: { kind: 'all' as const }, charts: [], layout: [] };

beforeEach(() => {
  localStorage.clear();
  act(() => {
    useViewerStore.setState({ dashboards: [], activeDashboardId: null, mutationVersion: 0, mutationViews: new Map(),
      clashReviews: new Map(), clashExclusions: [], chartSlice: null, chartSliceSource: null, chartSliceBuckets: null });
    useViewerStore.getState().upsertDashboard(DASHBOARD);
    useViewerStore.setState({ activeDashboardId: DASHBOARD.id });
  });
});
afterEach(() => { cleanup(); useViewerStore.setState(original); localStorage.clear(); });

const settle = async () => { for (let index = 0; index < 6; index++) await act(async () => { await Promise.resolve(); }); };
function choose(select: HTMLSelectElement, value: string): void {
  act(() => { select.value = value; select.dispatchEvent(new window.Event('change', { bubbles: true })); });
}
const buttonNamed = (root: ParentNode, name: string): HTMLButtonElement | undefined =>
  [...root.querySelectorAll('button')].find((button) => button.textContent?.trim() === name);

function editor(ui: HTMLElement): HTMLElement {
  const form = ui.querySelector<HTMLElement>('[data-chart-editor]');
  assert.ok(form, 'the chart editor is open');
  return form;
}
function reportPicker(ui: HTMLElement): HTMLSelectElement {
  const picker = editor(ui).querySelector<HTMLSelectElement>('select[aria-label="Clash report"]');
  assert.ok(picker, 'a clash chart chooses between the current result and a saved report (#6947)');
  return picker;
}

/** Add a clash chart through the editor, bound to a saved report by id, or to the current result with `null`. */
async function addClashChart(ui: HTMLElement, title: string, reportId: string | null): Promise<void> {
  const add = buttonNamed(ui, 'Add chart'); assert.ok(add); click(add);
  const source = editor(ui).querySelector<HTMLSelectElement>('select[aria-label="Source"]'); assert.ok(source);
  choose(source, 'clash');
  const picker = reportPicker(ui);
  assert.equal(picker.value, '', 'a new clash chart reads the current result until its author chooses a report');
  if (reportId !== null) choose(picker, reportId);
  const name = editor(ui).querySelector<HTMLInputElement>('input[aria-label="Chart title"]'); assert.ok(name);
  type(name, title);
  const save = buttonNamed(editor(ui), 'Save chart'); assert.ok(save && !save.disabled); click(save);
  await settle();
}

function card(ui: HTMLElement, title: string): HTMLElement {
  const found = [...ui.querySelectorAll<HTMLElement>('[data-chart-id]')].find((element) => element.querySelector('.font-medium')?.textContent === title);
  assert.ok(found, `the dashboard shows the chart "${title}"`);
  return found;
}
/** How many clashes a card counts: the sum of its bucket values, read from the card's own legend. */
function population(ui: HTMLElement, title: string): number {
  return [...card(ui, title).querySelectorAll('[data-chart-legend] li')]
    .reduce((sum, item) => sum + Number(/: (\d+)$/.exec(item.textContent ?? '')?.[1] ?? Number.NaN), 0);
}
const subtitle = (ui: HTMLElement, title: string): string => card(ui, title).querySelector('[data-chart-subtitle]')?.textContent ?? '';
const boundReport = (title: string): string | undefined =>
  useViewerStore.getState().dashboards.find((dashboard) => dashboard.id === DASHBOARD.id)?.charts.find((chart) => chart.title === title)?.clashReportId;

/** What a browser reload leaves: nothing in memory, the saved content library and the stored dashboards. */
async function reload(): Promise<void> {
  cleanup();
  await act(async () => {
    useViewerStore.setState({ ...original, dashboards: loadDashboards(), activeDashboardId: DASHBOARD.id });
    await useViewerStore.getState().restoreSavedClashReports();
  });
}

function box(key: string, ref: number, dx: number): ClashElement {
  const positions = new Float32Array([dx, 0, 0, dx + 1, 0, 0, dx + 1, 1, 0, dx, 1, 0, dx, 0, 1, dx + 1, 0, 1, dx + 1, 1, 1, dx, 1, 1]);
  const indices = new Uint32Array([0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 4, 5, 0, 5, 1, 1, 5, 6, 1, 6, 2, 2, 6, 7, 2, 7, 3, 3, 7, 4, 3, 4, 0]);
  return { key, ref, model: 'A', tag: 'IfcWall', bounds: { min: [dx, 0, 0], max: [dx + 1, 1, 1] }, positions, indices };
}

describe('Saved clash reports as a chart source (#6947)', () => {
  it('save A, save B, bind separate charts, run C, reload: each chart keeps its own population', async () => {
    mountClashPanel();
    await detectCoincidentWalls(2);
    const a = await saveCurrentResultAs('Run A');
    await detectCoincidentWalls(3);
    const b = await saveCurrentResultAs('Run B');
    assert.deepEqual([a.clashes.length, b.clashes.length], [1, 3], 'each report holds the result that was current when it was saved');

    const ui = render(<ChartsPanel renderer={renderer} />); await settle();
    await addClashChart(ui, 'Chart of A', a.id);
    await addClashChart(ui, 'Chart of B', b.id);
    await addClashChart(ui, 'Current chart', null);
    assert.deepEqual([boundReport('Chart of A'), boundReport('Chart of B'), boundReport('Current chart')], [a.id, b.id, undefined]);
    assert.deepEqual([population(ui, 'Chart of A'), population(ui, 'Chart of B'), population(ui, 'Current chart')], [1, 3, 3],
      'before run C the current chart shows run B, the result on screen');

    await detectCoincidentWalls(4); await settle();
    assert.equal(useViewerStore.getState().clashResult?.clashes.length, 6);
    assert.deepEqual([population(ui, 'Chart of A'), population(ui, 'Chart of B'), population(ui, 'Current chart')], [1, 3, 6],
      'run C moves only the chart that reads the current result');
    assert.match(subtitle(ui, 'Chart of A'), /^Saved: Run A · /, 'a saved source is named on its card');
    assert.doesNotMatch(subtitle(ui, 'Current chart'), /Saved:/);

    const durable = await readContentRows('clashReports' as ContentKind);
    assert.deepEqual(durable.filter((row) => !row.deleted).map((row) => row.id).sort(), [a.id, b.id].sort(), 'both reports are rows of the saved content library');

    await reload();
    assert.deepEqual(savedClashReports().map((report) => [report.id, report.name, report.clashes.length]).sort(), [[a.id, 'Run A', 1], [b.id, 'Run B', 3]].sort());
    assert.equal(useViewerStore.getState().clashResult, null, 'a reload keeps no current result');
    const reloaded = render(<ChartsPanel renderer={renderer} />); await settle();
    assert.deepEqual([boundReport('Chart of A'), boundReport('Chart of B'), boundReport('Current chart')], [a.id, b.id, undefined], 'the bindings were stored with the dashboard');
    assert.deepEqual([population(reloaded, 'Chart of A'), population(reloaded, 'Chart of B')], [1, 3], 'both saved populations survive the reload');
    assert.equal(population(reloaded, 'Current chart'), 0, 'with no current result the current chart is empty; it does not borrow a saved report');
    assert.match(card(reloaded, 'Current chart').querySelector('[data-chart-empty]')?.textContent ?? '', /No clash results yet/);
  });

  it('a deleted report leaves its chart unavailable, never on the current result, until a source is chosen again', async () => {
    mountClashPanel();
    await detectCoincidentWalls(2);
    const a = await saveCurrentResultAs('Run A');
    await detectCoincidentWalls(3);
    const b = await saveCurrentResultAs('Run B');
    const ui = render(<ChartsPanel renderer={renderer} />); await settle();
    await addClashChart(ui, 'Chart of A', a.id);
    assert.equal(population(ui, 'Chart of A'), 1);

    await deleteSavedReport(a); await settle();
    assert.equal(boundReport('Chart of A'), a.id, 'the binding is kept: deleting a report does not rewrite charts');
    assert.equal(population(ui, 'Chart of A'), 0, 'the chart does not fall back to the current result (3 clashes)');
    assert.equal(useViewerStore.getState().clashResult?.clashes.length, 3);
    assert.equal(subtitle(ui, 'Chart of A'), 'Saved clash report unavailable');
    const empty = card(ui, 'Chart of A').querySelector('[data-chart-empty]');
    assert.match(empty?.textContent ?? '', /the current result is not shown in its place/);

    const repick = empty ? buttonNamed(empty, 'Choose a source') : undefined;
    assert.ok(repick, 'the unavailable state offers the way out');
    click(repick);
    const picker = reportPicker(ui);
    assert.equal(picker.value, a.id, 'the missing report stays selected until the author replaces it');
    assert.equal(picker.selectedOptions[0]?.textContent, 'Saved clash report unavailable');
    assert.equal(editor(ui).querySelector('[data-chart-source-note]')?.getAttribute('role'), 'alert');
    const save = buttonNamed(editor(ui), 'Save chart');
    assert.ok(save?.disabled, 'a chart cannot be saved while it points at a missing report');

    choose(picker, b.id);
    assert.equal(save.disabled, false);
    click(save); await settle();
    assert.equal(boundReport('Chart of A'), b.id);
    assert.equal(population(ui, 'Chart of A'), 3, 'choosing another report restores the chart');

    // The other explicit way out: the current result.
    const edit = card(ui, 'Chart of A').querySelector('button[aria-label="Edit Chart of A"]'); assert.ok(edit); click(edit);
    choose(reportPicker(ui), '');
    const saveCurrent = buttonNamed(editor(ui), 'Save chart'); assert.ok(saveCurrent && !saveCurrent.disabled); click(saveCurrent); await settle();
    assert.equal(boundReport('Chart of A'), undefined);
    assert.doesNotMatch(subtitle(ui, 'Chart of A'), /Saved/);
  });

  it('marks a report recorded on another model revision as historical and never resolves it against the loaded model', async () => {
    mountClashPanel();
    await detectCoincidentWalls(2, 1, () => ({ sourceFingerprint: 'revision-1' }));
    const report = await saveCurrentResultAs('Revision 1 run');
    assert.deepEqual(report.models.map((model) => [model.name, model.sourceFingerprint]), [['A.ifc', 'revision-1']], 'the report records the model identity it ran on');
    const ui = render(<ChartsPanel renderer={renderer} />); await settle();
    await addClashChart(ui, 'Revision chart', report.id);
    // Control: on the very revision it was recorded on, the chart carries no historical marker.
    assert.equal(subtitle(ui, 'Revision chart').includes('revision'), false, subtitle(ui, 'Revision chart'));
    assert.equal(population(ui, 'Revision chart'), 1);

    // Revision 2 of the same file name: three walls now, and the same GlobalIds for the first two.
    await act(async () => {
      await seedCoincidentWalls(1, 3);
      useViewerStore.setState({ models: new Map([...useViewerStore.getState().models].map(([id, model]) => [id, { ...model, sourceFingerprint: 'revision-2' }])) });
    });
    await settle();
    assert.match(subtitle(ui, 'Revision chart'), /^Saved: Revision 1 run · Different model revision · /);
    assert.match(card(ui, 'Revision chart').querySelector('[data-chart-subtitle]')?.getAttribute('title') ?? '', /Historical: recorded on a different revision of the loaded model\./);
    assert.equal(population(ui, 'Revision chart'), 1, 'the recorded population is shown as recorded');
    const buckets = [...card(ui, 'Revision chart').querySelectorAll<HTMLButtonElement>('[data-chart-legend] button')];
    assert.ok(buckets.length > 0 && buckets.every((bucket) => bucket.disabled), 'a recorded bucket cannot select elements of the loaded revision');
    for (const bucket of buckets) click(bucket);
    assert.equal(useViewerStore.getState().chartSlice, null, 'no element of the loaded revision is selected from saved rows');
    assert.equal(card(ui, 'Revision chart').querySelector<HTMLButtonElement>('button[aria-label="Frame Revision chart"]')?.disabled, true, 'nor frame them');

    act(() => useViewerStore.setState({ models: new Map(), activeModelId: null }));
    await settle();
    assert.match(subtitle(ui, 'Revision chart'), /Models not loaded/);
    assert.equal(population(ui, 'Revision chart'), 1);
  });

  it('marks a run that stopped at its pair limit, and a result whose models changed before saving', async () => {
    mountClashPanel();
    await detectCoincidentWalls(2);
    // The panel's own runs set no pair limit, so the partial run comes straight from the engine with one.
    const partial = await createClashEngine({ backend: 'ts' }).run([box('w1', 1, 0), box('w2', 2, 0), box('w3', 3, 0)],
      [{ id: 'walls', name: 'Walls', a: 'IfcWall', mode: 'hard' }], { maxCandidatePairs: 1 });
    assert.ok(partial.truncated && partial.truncated.droppedPairs > 0, 'the engine reports the pairs it did not check');
    act(() => { useViewerStore.getState().setClashResult(partial); useViewerStore.getState().bumpClashRunSeq(); });
    const dropped = partial.truncated.droppedPairs;
    const saved = await saveCurrentResultAs('Capped run');
    assert.deepEqual(saved.completeness.truncated, { reason: 'maxCandidatePairs', droppedPairs: dropped });
    assert.match(document.body.querySelector(`[data-clash-report="${saved.id}"] [data-clash-report-limits]`)?.textContent ?? '', /Partial run/);

    const ui = render(<ChartsPanel renderer={renderer} />); await settle();
    await addClashChart(ui, 'Capped chart', saved.id);
    assert.match(subtitle(ui, 'Capped chart'), /^Saved: Capped run · Partial run · /);
    assert.match(editorNote(ui, 'Capped chart'), new RegExp(`Partial run: ${dropped} candidate pairs? (was|were) not checked\\.`));

    // A complete run, then an edit to the model before it is saved.
    await detectCoincidentWalls(2);
    const complete = await saveCurrentResultAs('Complete run');
    assert.deepEqual([complete.completeness.truncated, complete.completeness.stale], [undefined, false]);
    act(() => useViewerStore.setState({ mutationVersion: useViewerStore.getState().mutationVersion + 1 }));
    assert.match(document.body.querySelector('[data-clash-report-current]')?.textContent ?? '', /The models changed after this run/);
    const stale = await saveCurrentResultAs('Edited before saving');
    assert.equal(stale.completeness.stale, true);
    await addClashChart(ui, 'Complete chart', complete.id);
    await addClashChart(ui, 'Stale chart', stale.id);
    assert.match(subtitle(ui, 'Stale chart'), /Models changed before saving/);
    assert.doesNotMatch(subtitle(ui, 'Complete chart'), /Partial run|Models changed before saving/, 'a complete run carries neither marker');
  });
});

/** Open a card's editor, read the source note under the report picker, and close it again. */
function editorNote(ui: HTMLElement, title: string): string {
  const edit = card(ui, title).querySelector(`button[aria-label="Edit ${title}"]`); assert.ok(edit); click(edit);
  const note = editor(ui).querySelector('[data-chart-source-note]')?.textContent ?? '';
  const cancel = buttonNamed(editor(ui), 'Cancel'); assert.ok(cancel); click(cancel);
  return note;
}
