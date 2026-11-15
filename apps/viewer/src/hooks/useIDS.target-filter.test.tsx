/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import '@/test/content-fixture.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { parseIDS, type IDSValidationReport } from '@ifc-lite/ids';
import { Rule } from '@ifc-lite/rules';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { render, click, cleanup } from '@/test/render';
import { IDSTargetFilter } from '@/components/viewer/IDSTargetFilter';
import { useIDS } from './useIDS';
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
  cleanup(); api = undefined;
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
