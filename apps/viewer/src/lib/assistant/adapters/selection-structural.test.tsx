/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { getAttributeNames, extractStructuralOnDemand, EMPTY_SOURCE_BYTES, type StructuralExtraction } from '@ifc-lite/parser';
import type { IfcAttributeValue } from '@ifc-lite/data';
import { parseStep, seedModel, exportAndReparse } from '@/test/properties-panel-harness';
import { getOrCreateMutationView } from '@/sdk/adapters/mutation-view';
import { createStructuralAdapter } from '@/sdk/adapters/structural-adapter';
import { effectiveStructuralView } from '@/components/viewer/properties/effectiveStructuralView';
import { renderPanelBody } from '@/lib/panels/renderPanelBody';
import { render, advance, cleanup } from '@/test/render';
import { useViewerStore } from '@/store';
import { captureEvidence } from '../evidence';

const initial = useViewerStore.getState();
afterEach(() => { cleanup(); useViewerStore.setState(initial, true); });
interface StructuralEvidence { member: { Thickness: number | null }; activities: Array<{ AppliedLoad: { components: Record<string, number> } | null }> }
interface Row { structuralStatus: string; structural: StructuralEvidence | null }
const row = (): Row => JSON.parse(captureEvidence('selection').payload).evidence.rows[0].data;
async function fixture(save = true) {
  const file = await parseStep(await readFile(new URL('../../../../public/samples/building-architecture.ifc', import.meta.url), 'utf8'));
  seedModel('native', 0, file, 52);
  const view = getOrCreateMutationView(useViewerStore, 'native'); assert.ok(view); view.setExpressIdWatermark(100_000);
  const author = (type: string, fields: Record<string, IfcAttributeValue>) => view.createEntity(type,
    getAttributeNames(type).map(name => fields[name] ?? null));
  // Explicit authored structural additions to the real SketchUp sample, not original model facts.
  const member = author('IfcStructuralSurfaceMember', { GlobalId: '0000000000000000000006', Name: 'Authored analysis surface', PredefinedType: '.SHELL.', Thickness: 0.25 });
  const load = author('IfcStructuralLoadSingleForce', { Name: 'Authored force', ForceX: 1234, ForceY: 0, ForceZ: 0, MomentX: 0, MomentY: 0, MomentZ: 0 });
  const action = author('IfcStructuralSurfaceAction', { GlobalId: '0000000000000000000007', Name: 'Authored structural action', AppliedLoad: `#${load.expressId}`, GlobalOrLocal: '.GLOBAL_COORDS.', DestabilizingLoad: '.F.', PredefinedType: '.CONST.' });
  const relation = author('IfcRelConnectsStructuralActivity', { GlobalId: '0000000000000000000008', RelatingElement: `#${member.expressId}`, RelatedStructuralActivity: `#${action.expressId}` });
  const saved = await exportAndReparse('native', file);
  const native = extractStructuralOnDemand(saved);
  assert.equal(native.members[0].thickness, 0.25); assert.equal(native.activities[0].appliedLoad?.components.ForceX, 1234);
  assert.equal(saved.getEntity(relation.expressId)?.attributes[5], action.expressId);
  if (save) useViewerStore.setState({ mutationViews: new Map() });
  seedModel('native', 0, save ? saved : file, member.expressId);
  return { file: save ? saved : file, original: file, saved, view, memberId: member.expressId, loadId: load.expressId, actionId: action.expressId, relationId: relation.expressId };
}
const force = (data: StructuralExtraction) => data.activities[0]?.appliedLoad?.components.ForceX;

test('#7195 selected structural load matches native exported Properties metadata', async () => {
  const { file } = await fixture(); assert.equal(force(extractStructuralOnDemand(file)), 1234);
  const ui = render(renderPanelBody('properties', () => undefined)); await advance(0);
  assert.match(ui.textContent ?? '', /Structural Analysis/); assert.match(ui.textContent ?? '', /1[,.’'\u202f\s]?234/);
  const selected = row(); assert.equal(selected.structuralStatus, 'available');
  assert.equal(selected.structural?.member.Thickness, 0.25);
  assert.equal(selected.structural?.activities[0].AppliedLoad?.components.ForceX, 1234);
});

test('#7195 native structural named and positional edits agree with exported precedence', async () => {
  const { file, memberId } = await fixture();
  const view = getOrCreateMutationView(useViewerStore, 'native'); assert.ok(view);
  view.setAttribute(memberId, 'Thickness', '0.5');
  view.setPositionalAttribute(memberId, getAttributeNames('IfcStructuralSurfaceMember').indexOf('Thickness'), 0.75);
  const saved = await exportAndReparse('native', file); assert.equal(extractStructuralOnDemand(saved).members[0].thickness, 0.75);
  assert.equal(extractStructuralOnDemand(file, effectiveStructuralView(view, file)).members[0].thickness, 0.75);
  assert.equal(row().structural?.member.Thickness, 0.75);
});

test('#7195 native structural applied-load source edits agree with exported load components', async () => {
  const { file, loadId } = await fixture();
  const view = getOrCreateMutationView(useViewerStore, 'native'); assert.ok(view);
  view.setAttribute(loadId, 'ForceX', '2345');
  const saved = await exportAndReparse('native', file); assert.equal(force(extractStructuralOnDemand(saved)), 2345);
  assert.equal(force(extractStructuralOnDemand(file, effectiveStructuralView(view, file))), 2345);
  assert.equal(createStructuralAdapter(useViewerStore).data('native').activities[0].appliedLoad?.components.ForceX, 2345);
});

test('#7195 native structural session-created loads and activities are readable before export', async () => {
  const { file, saved, view } = await fixture(false); assert.equal(force(extractStructuralOnDemand(saved)), 1234);
  assert.equal(force(extractStructuralOnDemand(file, effectiveStructuralView(view, file))), 1234);
  assert.equal(row().structural?.activities[0].AppliedLoad?.components.ForceX, 1234);
});

test('#7195 native structural SDK invalidates same-store edit sessions and unavailable source cache', async () => {
  const { file, memberId } = await fixture();
  const adapter = createStructuralAdapter(useViewerStore);
  assert.equal(adapter.data('native').members[0].name, 'Authored analysis surface');
  const view = getOrCreateMutationView(useViewerStore, 'native'); assert.ok(view); view.setAttribute(memberId, 'Name', 'Current member');
  const saved = await exportAndReparse('native', file); assert.equal(extractStructuralOnDemand(saved).members[0].name, 'Current member');
  const current = adapter.data('native').members[0].name;
  file.source = EMPTY_SOURCE_BYTES;
  assert.equal(current, 'Current member');
  assert.equal(adapter.data('native').activities[0]?.appliedLoad?.components.ForceX, undefined);
  assert.equal(row().structuralStatus, 'unavailable-source');
});
