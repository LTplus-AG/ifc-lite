/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import '@/test/content-fixture.js';
import { afterEach, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { parseIDS, type IDSValidationReport } from '@ifc-lite/ids';
import { Rule } from '@ifc-lite/rules';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { render, click, cleanup } from '@/test/render';
import { IDSTargetFilter } from '@/components/viewer/IDSTargetFilter';
import { IDSPanel } from '@/components/viewer/IDSPanel';
import { useIDS } from './useIDS';
import { posthog } from '@/lib/analytics';
import { useActivityJournal } from '@/lib/activity/activity-journal';
import { resolveIdsTargetFilter } from '@/lib/ids/resolve-target-filter';

const IFC = `ISO-10303-21;
HEADER; FILE_SCHEMA(('IFC4')); ENDSEC;
DATA;
#100=IFCWALL('0wall00000000000000000',$,'Existing wall',$,$,$,$,$,.STANDARD.);
#104=IFCWALL('0wall00000000000000001',$,'New wall',$,$,$,$,$,.STANDARD.);
#101=IFCPROPERTYSINGLEVALUE('FireRating',$,IFCLABEL('NONE'),$);
#102=IFCPROPERTYSET('0pset00000000000000000',$,'Pset_WallCommon',$,(#101));
#103=IFCRELDEFINESBYPROPERTIES('0rel000000000000000000',$,$,$,(#100),#102);
#105=IFCPROPERTYSINGLEVALUE('FireRating',$,IFCLABEL('F90'),$);
#106=IFCPROPERTYSET('0pset00000000000000001',$,'Pset_WallCommon',$,(#105));
#107=IFCRELDEFINESBYPROPERTIES('0rel000000000000000001',$,$,$,(#104),#106);
ENDSEC; END-ISO-10303-21;`;
const XML = `<ids xmlns="http://standards.buildingsmart.org/IDS"><info><title>Fire rating</title></info><specifications>
<specification name="Walls are F90" ifcVersion="IFC4"><applicability minOccurs="0" maxOccurs="unbounded"><entity><name><simpleValue>IFCWALL</simpleValue></name></entity></applicability>
<requirements><property dataType="IFCLABEL"><propertySet><simpleValue>Pset_WallCommon</simpleValue></propertySet><baseName><simpleValue>FireRating</simpleValue></baseName><value><simpleValue>F90</simpleValue></value></property></requirements>
</specification></specifications></ids>`;
let api: ReturnType<typeof useIDS> | undefined;
function Probe() { api = useIDS({ autoApplyColors: false }); return null; }
const originalWorker = globalThis.Worker;
afterEach(() => {
  cleanup(); api = undefined; mock.restoreAll();
  if (originalWorker === undefined) delete (globalThis as { Worker?: unknown }).Worker;
  else globalThis.Worker = originalWorker;
  useViewerStore.setState({ idsTargetFilter: null, idsDocument: null, idsLoading: false, models: new Map(), mutationViews: new Map() });
});
async function seed(): Promise<IfcDataStore> {
  delete (globalThis as { Worker?: unknown }).Worker;
  const data = await new IfcParser().parseColumnar(new TextEncoder().encode(IFC).buffer as ArrayBuffer, { disableWorkerScan: true });
  const model = fixtureModel('M'); model.ifcDataStore = data; model.maxExpressId = 107;
  useViewerStore.setState({ ...fixtureModels(model), ifcDataStore: data, idsDocument: parseIDS(XML),
    idsValidationReport: null, idsError: null, idsLoading: false, idsTargetFilter: null, mutationViews: new Map() });
  render(<Probe />);
  return data;
}
it('uses Rules filters for the selected model and changes the actual IDS population (#10371)', async () => {
  await seed();
  const controls = render(<IDSTargetFilter modelId="M" />);
  const input = controls.querySelector<HTMLInputElement>('input[type="checkbox"]');
  assert.ok(input);
  click(input);
  assert.ok(useViewerStore.getState().idsTargetFilter, 'the rendered control opts into filtering');
  await act(async () => { useViewerStore.getState().setIdsTargetFilter(() => ({ activeGroup: 0,
    groups: [{ combinator: 'AND', rules: [Rule.ifcType(['IfcWall']), Rule.name('eq', 'New wall')] }] })); });
  const outcome: { report?: IDSValidationReport | null } = {};
  await act(async () => { outcome.report = await api!.runValidation('M'); });
  assert.equal(outcome.report?.summary.totalEntitiesChecked, 1);
  assert.equal(outcome.report?.summary.totalEntitiesPassed, 1, 'the excluded existing wall no longer fails the check');
  assert.deepEqual(outcome.report?.targetScope, { kind: 'subset', entityCount: 1 });
  click(input);
  await act(async () => { outcome.report = await api!.runValidation('M'); });
  assert.equal(outcome.report?.summary.totalEntitiesChecked, 2);
  assert.equal(outcome.report?.summary.totalEntitiesFailed, 1, 'turning the filter off restores the full population');
  assert.equal(outcome.report?.targetScope, undefined);
});
it('refuses an empty editor definition rather than silently widening scope (#10371)', async () => {
  const data = await seed();
  await assert.rejects(resolveIdsTargetFilter(useViewerStore.getState(), 'M', data, []), /at least one object filter/);
  const ids = await resolveIdsTargetFilter(useViewerStore.getState(), 'M', data,
    [{ combinator: 'AND', rules: [Rule.name('eq', 'Missing wall')] }]);
  assert.deepEqual(ids, [], 'a valid filter with no matches stays an explicit empty subset');
});

it('shows an empty-filter refusal without reporting it to error tracking (#10753)', async () => {
  await seed();
  const controls = render(<IDSTargetFilter modelId="M" />);
  const input = controls.querySelector<HTMLInputElement>('input[type="checkbox"]');
  assert.ok(input);
  click(input);
  const capture = mock.method(posthog, 'captureException', () => undefined);
  const jobsBefore = useActivityJournal.getState().jobs.length;
  const outcome: { report?: IDSValidationReport | null } = {};
  await act(async () => { outcome.report = await api!.runValidation('M'); });
  assert.equal(outcome.report, null);
  assert.equal(useViewerStore.getState().idsError, 'Add at least one object filter before running a filtered IDS check.',
    'the panel still explains the refusal');
  assert.equal(capture.mock.callCount(), 0, 'an expected input refusal is not a runtime exception');
  assert.equal(useActivityJournal.getState().jobs.length, jobsBefore, 'no job, so no failed check in the activity tray');
});

it('keeps filtered IDs model-local in a federation and validates the requested model (#10371)', async () => {
  const data = await seed();
  const b = fixtureModel('B', { idOffset: 1_000_000 }); b.ifcDataStore = data; b.maxExpressId = 107;
  await act(async () => {
    useViewerStore.setState(state => ({ models: new Map([...state.models, ['B', b]]) }));
    useViewerStore.getState().setIdsTargetFilter(() => ({ activeGroup: 0,
      groups: [{ combinator: 'AND', rules: [Rule.name('eq', 'New wall')] }] }));
  });
  const groups = useViewerStore.getState().idsTargetFilter!.groups;
  assert.deepEqual(await resolveIdsTargetFilter(useViewerStore.getState(), 'B', data, groups), [104], 'the worker receives local IDs rather than renderer offsets');
  const outcome: { report?: IDSValidationReport | null } = {};
  await act(async () => { outcome.report = await api!.runValidation('B'); });
  assert.equal(outcome.report?.modelInfo[0].modelId, 'B');
  assert.equal(outcome.report?.summary.totalEntitiesPassed, 1);
  assert.deepEqual(outcome.report?.targetScope, { kind: 'subset', entityCount: 1 });
});
it('does not publish a run after its object filter changes during the paint yield (#10371)', async () => {
  await seed();
  const run: { pending?: Promise<IDSValidationReport | null> } = {};
  act(() => { run.pending = api!.runValidation('M'); });
  assert.ok(useViewerStore.getState().idsLoading);
  const outcome: { report?: IDSValidationReport | null } = {};
  await act(async () => {
    useViewerStore.getState().setIdsTargetFilter(() => ({ activeGroup: 0,
      groups: [{ combinator: 'AND', rules: [Rule.name('eq', 'New wall')] }] }));
    outcome.report = await run.pending;
  });
  assert.equal(outcome.report, null);
  assert.equal(useViewerStore.getState().idsValidationReport, null);
  assert.equal(useViewerStore.getState().idsLoading, false);
  assert.equal(useViewerStore.getState().idsProgress, null);
});

it('does not apply the Search display cap to the validation population (#10371)', async () => {
  const count = 5_003;
  const walls = Array.from({ length: count }, (_, index) =>
    `#${100 + index}=IFCWALL('${index.toString().padStart(22, '0')}',$,'Wall ${index}',$,$,$,$,$,.STANDARD.);`).join('\n');
  const source = `ISO-10303-21; HEADER; FILE_SCHEMA(('IFC4')); ENDSEC; DATA; ${walls} ENDSEC; END-ISO-10303-21;`;
  const data = await new IfcParser().parseColumnar(new TextEncoder().encode(source).buffer as ArrayBuffer, { disableWorkerScan: true });
  const model = fixtureModel('large'); model.ifcDataStore = data; model.maxExpressId = 100 + count - 1;
  useViewerStore.setState({ ...fixtureModels(model), mutationViews: new Map() });
  const ids = await resolveIdsTargetFilter(useViewerStore.getState(), 'large', data,
    [{ combinator: 'AND', rules: [Rule.ifcType(['IfcWall'])] }]);
  assert.equal(ids.length, count);
  assert.ok(ids.includes(100) && ids.includes(100 + count - 1));
});

it('offers filter options from the displayed report model instead of a different active model (#10371 review)', async () => {
  await seed();
  await act(async () => { await api!.runValidation('M'); });
  const other = await new IfcParser().parseColumnar(new TextEncoder().encode(IFC.replaceAll('IFCWALL(', 'IFCDOOR(')).buffer as ArrayBuffer,
    { disableWorkerScan: true });
  const b = fixtureModel('B'); b.ifcDataStore = other; b.maxExpressId = 107;
  await act(async () => {
    useViewerStore.setState(state => ({ models: new Map([...state.models, ['B', b]]), activeModelId: 'B' }));
    useViewerStore.getState().setIdsTargetFilter(() => ({ activeGroup: 0,
      groups: [{ combinator: 'AND', rules: [Rule.ifcType([])] }] }));
  });
  const panel = render(<IDSPanel onClose={() => {}} />);
  const controls = panel.querySelector('section[aria-label="Objects to validate"]')!;
  assert.ok(controls);
  const pick = [...controls.querySelectorAll('button')].find(button => button.textContent?.includes('Pick values'));
  assert.ok(pick);
  act(() => { pick.dispatchEvent(new window.PointerEvent('pointerdown', {
    bubbles: true, cancelable: true, button: 0,
  })); });
  const menu = document.querySelector('[role="menu"]');
  assert.ok(menu);
  assert.match(menu.textContent ?? '', /IfcWall/);
  assert.doesNotMatch(menu.textContent ?? '', /IfcDoor/, 'rerun targets report M, not active B');
});

it('a superseded filter iterator cannot clear the newer run progress (#10371 review)', async () => {
  await seed();
  const walls = Array.from({ length: 20_000 }, (_, index) =>
    `#${100 + index}=IFCWALL('${index.toString().padStart(22, '0')}',$,'Wall ${index}',$,$,$,$,$,.STANDARD.);`).join('\n');
  const data = await new IfcParser().parseColumnar(new TextEncoder().encode(
    `ISO-10303-21; HEADER; FILE_SCHEMA(('IFC4')); ENDSEC; DATA; ${walls} ENDSEC; END-ISO-10303-21;`).buffer as ArrayBuffer,
    { disableWorkerScan: true });
  const model = fixtureModel('M'); model.ifcDataStore = data; model.maxExpressId = 20_099;
  const view = new MutablePropertyView(null, 'M'); view.setAttribute(100, 'Name', 'Edited wall');
  await act(async () => {
    useViewerStore.setState({ ...fixtureModels(model), ifcDataStore: data, mutationViews: new Map([['M', view]]) });
    useViewerStore.getState().setIdsTargetFilter(() => ({ activeGroup: 0,
      groups: [{ combinator: 'AND', rules: [Rule.name('eq', 'No matching wall')] }] }));
  });
  const previousScheduler = Object.getOwnPropertyDescriptor(globalThis, 'scheduler');
  let yielded!: () => void, resume!: () => void;
  const reachedYield = new Promise<void>(resolve => { yielded = resolve; });
  const heldYield = new Promise<void>(resolve => { resume = resolve; });
  Object.defineProperty(globalThis, 'scheduler', { configurable: true, value: {
    yield: () => { yielded(); return heldYield; },
  } });
  let older: Promise<IDSValidationReport | null> | undefined, newer: Promise<IDSValidationReport | null> | undefined;
  try {
    act(() => { older = api!.runValidation('M'); });
    await reachedYield; // Real edited-entity iterator has scanned its final chunk.
    act(() => { newer = api!.runValidation('M'); });
    const progress = useViewerStore.getState().idsProgress;
    assert.equal(progress?.phase, 'filtering');
    await act(async () => { resume(); await older; });
    assert.equal(useViewerStore.getState().idsLoading, true);
    assert.equal(useViewerStore.getState().idsProgress, progress, 'older normal return cannot clear the new owner');
  } finally {
    resume();
    act(() => api!.cancelValidation());
    await Promise.allSettled([older, newer]);
    if (previousScheduler) Object.defineProperty(globalThis, 'scheduler', previousScheduler);
    else Reflect.deleteProperty(globalThis, 'scheduler');
  }
});
