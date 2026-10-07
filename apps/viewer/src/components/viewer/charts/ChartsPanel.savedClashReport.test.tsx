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
import { validateChartSpec } from '@ifc-lite/charts';
import { captureEvidence, evidenceIsCurrent } from '@/lib/assistant/evidence';
import { loadDashboards } from '@/lib/charts/persistence';
import { elementPairExclusion } from '@/lib/clash/exclusions';
import { readContentRows } from '@/lib/storage/content-database';
import type { ContentKind } from '@/lib/storage/content-kinds';
import { useViewerStore } from '@/store';
import { cleanup, click, render, type } from '@/test/render';
import { seedCoincidentWalls } from '@/test/clash-run-fixture';
import { deleteSavedReport, detectCoincidentWalls, mountClashPanel, openSavedReports, publishCappedRun, saveCurrentResultAs, savedClashReports } from '@/test/clash-report-fixture';
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

/** The assistant's charts evidence for one chart: what a conversation would cite. */
function cited(title: string): { status: string; total: number | null; savedClashReport: { name: string; truncated: boolean; excluded: number; loadedModelRevision: string } | null } {
  const charts = JSON.parse(captureEvidence('charts').payload).evidence.summary?.charts as Array<{ chartTitle: string } & ReturnType<typeof cited>>;
  const chart = charts.find((entry) => entry.chartTitle === title);
  assert.ok(chart, `the charts evidence covers "${title}"`);
  return chart;
}

/** What a browser reload leaves: nothing in memory, the saved content library and the stored dashboards. */
async function reload(): Promise<void> {
  cleanup();
  await act(async () => {
    useViewerStore.setState({ ...original, dashboards: loadDashboards(), activeDashboardId: DASHBOARD.id });
    await useViewerStore.getState().restoreSavedClashReports();
  });
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
    assert.match(subtitle(ui, 'Chart of A'), /Saved clash report: Run A, saved [^·]+ · 1 bucket · 1 clash$/, 'a saved source is named on its card');
    assert.doesNotMatch(subtitle(ui, 'Current chart'), /Saved clash report/);
    // The assistant cites the same populations and is told which of them is a saved past run.
    assert.deepEqual([cited('Chart of A').total, cited('Chart of B').total, cited('Current chart').total], [1, 3, 6]);
    assert.equal(cited('Chart of A').savedClashReport?.name, 'Run A');
    assert.equal(cited('Current chart').savedClashReport, null);

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
    const attached = captureEvidence('charts');
    assert.equal(evidenceIsCurrent(attached), true, 'control: evidence attached to a conversation is current while nothing changes');

    await deleteSavedReport(a); await settle();
    assert.equal(evidenceIsCurrent(attached), false, 'evidence attached before the deletion is stale: it still cites the deleted report as one clash');
    assert.equal(boundReport('Chart of A'), a.id, 'the binding is kept: deleting a report does not rewrite charts');
    assert.equal(population(ui, 'Chart of A'), 0, 'the chart does not fall back to the current result (3 clashes)');
    assert.equal(useViewerStore.getState().clashResult?.clashes.length, 3);
    assert.equal(subtitle(ui, 'Chart of A'), 'Saved clash report unavailable');
    assert.deepEqual([cited('Chart of A').status, cited('Chart of A').total], ['clash-report-missing', null], 'the assistant is given no numbers for it either');
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

  it('a total chart of a deleted report shows the unavailable state and the way out, not a count of zero', async () => {
    mountClashPanel();
    await detectCoincidentWalls(3);
    const report = await saveCurrentResultAs('Run A');
    // An Element Count chart draws one number. Over the empty rows of a missing report that number would be 0,
    // which reads as "this run found no clashes".
    act(() => useViewerStore.getState().upsertDashboard({ ...DASHBOARD, layout: [{ chartId: 'total', x: 0, y: 0, w: 6, h: 4 }],
      charts: [{ id: 'total', title: 'Total clashes', source: 'clash', type: 'elementCount', measure: { agg: 'count' }, clashReportId: report.id }] }));
    const drawn: Array<Record<string, unknown>> = [];
    const recording: ChartRenderer = async () => () => ({ setOption: (option) => { drawn.push(option as Record<string, unknown>); }, select: () => {}, resize: () => {}, dispose: () => {} });
    const ui = render(<ChartsPanel renderer={recording} />); await settle();
    const legend = () => [...card(ui, 'Total clashes').querySelectorAll('[data-chart-legend] li')].map((item) => item.textContent?.trim());
    assert.deepEqual(legend(), ['Total: 3'], 'control: the saved run counts its three clashes');
    assert.equal(card(ui, 'Total clashes').querySelector('[data-chart-empty]'), null);
    assert.match(JSON.stringify(drawn.at(-1)), /"text":"3"/, 'control: the card draws the saved total');

    await deleteSavedReport(report); await settle();
    assert.deepEqual(legend(), [], 'a missing report has no total, so none is listed');
    assert.doesNotMatch(JSON.stringify(drawn.at(-1)), /"text":"\d+"/, 'and none is drawn: neither a zero nor the total that was on screen');
    const empty = card(ui, 'Total clashes').querySelector('[data-chart-empty]');
    assert.match(empty?.textContent ?? '', /Saved clash report unavailable in this browser\./, 'the card says why it is empty');
    assert.ok(empty && buttonNamed(empty, 'Choose a source'), 'and offers the way out, as every other chart type does');
    assert.equal(subtitle(ui, 'Total clashes'), 'Saved clash report unavailable');
  });

  it('binding a chart to a saved report drops its element filter and keeps its rule filter', async () => {
    mountClashPanel();
    await detectCoincidentWalls(3);
    const report = await saveCurrentResultAs('Run A');
    const [rule] = report.run.rules;
    // A chart of the current result, narrowed to the walls by an element filter.
    act(() => useViewerStore.getState().upsertDashboard({ ...DASHBOARD, layout: [{ chartId: 'filtered', x: 0, y: 0, w: 6, h: 4 }],
      charts: [{ id: 'filtered', title: 'Filtered chart', source: 'clash', type: 'bar', dimension: 'Rule', measure: { agg: 'count' }, filter: { selector: 'IfcWall' } }] }));
    const ui = render(<ChartsPanel renderer={renderer} />); await settle();
    const saved = () => useViewerStore.getState().dashboards.find((dashboard) => dashboard.id === DASHBOARD.id)?.charts[0];
    const edit = () => { const button = card(ui, 'Filtered chart').querySelector('button[aria-label="Edit Filtered chart"]'); assert.ok(button); click(button); };

    edit();
    assert.ok(editor(ui).querySelector('input[aria-label="Source filter"]'), 'control: the current result takes an element filter');
    choose(reportPicker(ui), report.id);
    assert.equal(editor(ui).querySelector('input[aria-label="Source filter"]'), null, 'saved rows carry no element ids for a selector to match');
    assert.match(editor(ui).textContent ?? '', /Source filter is not applicable to a saved clash report\./);
    const save = buttonNamed(editor(ui), 'Save chart'); assert.ok(save && !save.disabled); click(save); await settle();
    assert.deepEqual([saved()?.clashReportId, saved()?.filter], [report.id, undefined], 'the selector is not carried onto the saved report');
    assert.deepEqual(validateChartSpec(saved()), [], 'and the saved chart is one the dashboard file format accepts');
    assert.equal(population(ui, 'Filtered chart'), 3, 'the chart shows the whole saved run, not an empty filter result');

    edit();
    const rules = editor(ui).querySelector<HTMLSelectElement>('select[aria-label="Clash rule"]'); assert.ok(rules);
    assert.deepEqual([...rules.options].map((option) => option.value), ['', rule.id], "the rule filter lists the saved report's own rules");
    choose(rules, rule.id);
    const saveRule = buttonNamed(editor(ui), 'Save chart'); assert.ok(saveRule); click(saveRule); await settle();
    assert.deepEqual(saved()?.filter, { selector: '', groups: undefined, clashRule: rule.id });
    assert.deepEqual(validateChartSpec(saved()), []);
    assert.equal(population(ui, 'Filtered chart'), 3);

    // The card names the rule from the report's own rules: the current result may be another run, or gone.
    assert.notEqual(rule.name, rule.id, 'control: a rule has a name of its own');
    act(() => useViewerStore.getState().clearClash());
    await settle();
    assert.equal(useViewerStore.getState().clashResult, null);
    assert.ok(subtitle(ui, 'Filtered chart').endsWith(`rule: ${rule.name}`), `the subtitle names the saved rule: ${subtitle(ui, 'Filtered chart')}`);
  });

  it('marks a report recorded on another model revision as historical and never resolves it against the loaded model', async () => {
    mountClashPanel();
    await detectCoincidentWalls(2, 1, () => ({ sourceFingerprint: 'revision-1' }));
    const report = await saveCurrentResultAs('First issue');
    assert.deepEqual(report.models.map((model) => [model.name, model.sourceFingerprint]), [['A.ifc', 'revision-1']], 'the report records the model identity it ran on');
    const ui = render(<ChartsPanel renderer={renderer} />); await settle();
    await addClashChart(ui, 'Revision chart', report.id);
    // Control: on the very revision it was recorded on, the chart carries no historical marker.
    assert.match(subtitle(ui, 'Revision chart'), /^Saved clash report: First issue, saved /, 'no limit precedes the name on the recorded revision');
    assert.equal(population(ui, 'Revision chart'), 1);

    // Revision 2 of the same file name: three walls now, and the same GlobalIds for the first two.
    await act(async () => {
      await seedCoincidentWalls(1, 3);
      useViewerStore.setState({ models: new Map([...useViewerStore.getState().models].map(([id, model]) => [id, { ...model, sourceFingerprint: 'revision-2' }])) });
    });
    await settle();
    assert.match(subtitle(ui, 'Revision chart'), /^Different model revision · Saved clash report: First issue, saved /, 'the warning leads, so a narrow card cannot cut it off');
    assert.match(card(ui, 'Revision chart').querySelector('[data-chart-subtitle]')?.getAttribute('title') ?? '', /^Different model revision · Saved clash report: First issue, saved /, 'the tooltip holds the whole line');
    assert.equal(population(ui, 'Revision chart'), 1, 'the recorded population is shown as recorded');
    const buckets = [...card(ui, 'Revision chart').querySelectorAll<HTMLButtonElement>('[data-chart-legend] button')];
    assert.ok(buckets.length > 0 && buckets.every((bucket) => bucket.disabled), 'a recorded bucket cannot select elements of the loaded revision');
    for (const bucket of buckets) click(bucket);
    assert.equal(useViewerStore.getState().chartSlice, null, 'no element of the loaded revision is selected from saved rows');
    assert.equal(card(ui, 'Revision chart').querySelector<HTMLButtonElement>('button[aria-label="Frame Revision chart"]')?.disabled, true, 'nor frame them');

    act(() => useViewerStore.setState({ models: new Map(), activeModelId: null }));
    await settle();
    assert.match(subtitle(ui, 'Revision chart'), /^Models not loaded · Saved clash report: First issue, saved /);
    assert.equal(population(ui, 'Revision chart'), 1);
  });

  it('marks a run that stopped at its pair limit, and a result whose models changed before saving', async () => {
    mountClashPanel();
    await detectCoincidentWalls(2);
    const dropped = (await publishCappedRun()).truncated.droppedPairs;
    await openSavedReports();
    assert.match(document.body.querySelector('[data-clash-report-current]')?.textContent ?? '', /It will be saved as: Partial run\./, 'the dialog says so before saving');
    const saved = await saveCurrentResultAs('Capped run');
    assert.deepEqual(saved.completeness.truncated, { reason: 'maxCandidatePairs', droppedPairs: dropped });
    assert.match(document.body.querySelector(`[data-clash-report="${saved.id}"] [data-clash-report-limits]`)?.textContent ?? '', /Partial run/);

    const ui = render(<ChartsPanel renderer={renderer} />); await settle();
    await addClashChart(ui, 'Capped chart', saved.id);
    assert.match(subtitle(ui, 'Capped chart'), /^Partial run · /);
    assert.match(editorNote(ui, 'Capped chart'), /^Partial run · .*Saved clash report: Capped run, saved /, 'the chart editor states the same limits');

    // A complete run, then an edit to the model before it is saved.
    await detectCoincidentWalls(2);
    const complete = await saveCurrentResultAs('Complete run');
    assert.deepEqual([complete.completeness.truncated, complete.completeness.stale], [undefined, false]);
    act(() => useViewerStore.setState({ mutationVersion: useViewerStore.getState().mutationVersion + 1 }));
    assert.match(document.body.querySelector('[data-clash-report-current]')?.textContent ?? '', /It will be saved as: Models changed before saving\./);
    const stale = await saveCurrentResultAs('Edited before saving');
    assert.equal(stale.completeness.stale, true);
    await addClashChart(ui, 'Complete chart', complete.id);
    await addClashChart(ui, 'Stale chart', stale.id);
    assert.match(subtitle(ui, 'Stale chart'), /^Models changed before saving · /);
    assert.doesNotMatch(subtitle(ui, 'Complete chart'), /Partial run|Models changed before saving/, 'a complete run carries neither marker');
  });

  it('says how many clashes the exclusion rules were hiding when the report was saved', async () => {
    mountClashPanel();
    await detectCoincidentWalls(3, 1, () => ({ sourceFingerprint: 'revision-1' }));
    const complete = await saveCurrentResultAs('All three');
    // Exclude one pair the way the panel does: the result drops to two clashes and the panel counts one hidden.
    const [hidden] = useViewerStore.getState().clashResult?.clashes ?? [];
    assert.ok(hidden);
    act(() => { assert.equal(useViewerStore.getState().addClashExclusion(elementPairExclusion(hidden.a, hidden.b)).ok, true); });
    assert.deepEqual([useViewerStore.getState().clashResult?.clashes.length, useViewerStore.getState().clashSuppressedCount], [2, 1]);
    await openSavedReports();
    assert.match(document.body.querySelector('[data-clash-report-current]')?.textContent ?? '', /It will be saved as: 1 hidden by exclusions\./, 'the dialog says so before saving');
    const narrowed = await saveCurrentResultAs('One pair excluded');
    assert.deepEqual([narrowed.clashes.length, narrowed.completeness.excluded], [2, 1]);
    assert.match(document.body.querySelector(`[data-clash-report="${narrowed.id}"] [data-clash-report-limits]`)?.textContent ?? '', /1 hidden by exclusions/);
    assert.doesNotMatch(document.body.querySelector(`[data-clash-report="${complete.id}"]`)?.textContent ?? '', /hidden by exclusions/, 'control: a run saved with nothing excluded says no such thing');

    // The exclusion is removed afterwards: nothing on screen says the saved population was a subset, except the report.
    act(() => { useViewerStore.getState().clearClashExclusions(); });
    const ui = render(<ChartsPanel renderer={renderer} />); await settle();
    await addClashChart(ui, 'Narrowed chart', narrowed.id);
    await addClashChart(ui, 'Whole chart', complete.id);
    assert.equal(population(ui, 'Narrowed chart'), 2);
    assert.match(subtitle(ui, 'Narrowed chart'), /^1 hidden by exclusions · Saved clash report: One pair excluded, saved /, 'the card leads with it, like the other limits');
    assert.match(editorNote(ui, 'Narrowed chart'), /^1 hidden by exclusions · /, 'the chart editor states it');
    assert.equal(cited('Narrowed chart').savedClashReport?.excluded, 1, 'and the assistant is told the population is a subset');
    assert.doesNotMatch(subtitle(ui, 'Whole chart'), /hidden by exclusions/, 'control: a report saved with nothing excluded carries no such label');
    assert.equal(cited('Whole chart').savedClashReport?.excluded, 0);
  });
});

/** Open a card's editor, read the source note under the report picker, and close it again. */
function editorNote(ui: HTMLElement, title: string): string {
  const edit = card(ui, title).querySelector(`button[aria-label="Edit ${title}"]`); assert.ok(edit); click(edit);
  const note = editor(ui).querySelector('[data-chart-source-note]')?.textContent ?? '';
  const cancel = buttonNamed(editor(ui), 'Cancel'); assert.ok(cancel); click(cancel);
  return note;
}
