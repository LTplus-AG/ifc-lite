/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PropertyValueType } from '@ifc-lite/data';
import type { IfcDataStore } from '@ifc-lite/parser';
import { advance, render, click, cleanup } from '@/test/render';
import { addPropertyThroughDialog, parseStep, seedModel } from '@/test/properties-panel-harness';
import { renderPanelBody } from '@/lib/panels/renderPanelBody';
import { getOrCreateMutationView } from '@/sdk/adapters/mutation-view';
import { entityRefToString } from '@/store/entity-ref';
import { useViewerStore } from '@/store';
import { captureEvidence, evidenceIsCurrent, type EvidenceSnapshot } from '../evidence';
import { useAssistant, cancelAssistant } from '../conversation';

const initial = useViewerStore.getState();
const initialAssistant = useAssistant.getState();
afterEach(() => { cleanup(); cancelAssistant(); useAssistant.setState(initialAssistant, true); useViewerStore.setState(initial, true); });

/** #262 in the committed sample (ground truth read from the STEP text). */
const WALL = 262;
const WALL_GUID = '1AQAupaRP1txwK1AGiN61V';
const WALL_NAME = 'house - outer wall - house right front';
const OFFSET = 1_000_000;

const sample = async (name: string): Promise<IfcDataStore> =>
  parseStep(new Uint8Array(await readFile(new URL(`../../../../public/samples/${name}`, import.meta.url))));

interface ElementRow {
  modelId: string; globalId: string | null; expressId: number; type: string; name: string | null; status: string;
  attributes: Record<string, unknown>;
  psets: Array<{ name: string; properties: Record<string, string> }>;
  quantities: Array<{ name: string; quantities: Record<string, { value: number | null; unit: string | null }> }>;
}
const rowsOf = (snapshot: EvidenceSnapshot): ElementRow[] => JSON.parse(snapshot.payload).evidence.rows.map((row: { data: ElementRow }) => row.data);
const pset = (row: ElementRow, name: string) => row.psets.find(p => p.name === name)?.properties;

// #6833: a real wall, read through the Properties panel's effective readers.
test('selection evidence carries a real wall\'s identity, property sets and quantities with units', async () => {
  seedModel('arch', OFFSET, await sample('building-architecture.ifc'), WALL);
  const snapshot = captureEvidence('selection');
  const payload = JSON.parse(snapshot.payload);
  assert.equal(payload.sourceAvailability, 'available');
  assert.equal(snapshot.totalRows, 1);
  assert.equal(payload.evidence.summary.selectionSize, 1);
  assert.equal(payload.evidence.summary.modelCount, 1);
  const [wall] = rowsOf(snapshot);
  assert.equal(wall.modelId, 'arch');
  assert.equal(wall.expressId, WALL);
  assert.equal(wall.globalId, WALL_GUID);
  assert.equal(wall.name, WALL_NAME);
  assert.equal(wall.type, 'IfcWall');
  assert.equal(wall.status, 'as-loaded');
  assert.equal(wall.attributes.ObjectType, 'solidwall');
  assert.match(String(pset(wall, 'Pset_WallCommon')?.IsExternal), /true/i);
  assert.match(String(pset(wall, 'Pset_WallCommon')?.LoadBearing), /false/i);
  const qto = wall.quantities.find(q => q.name === 'Qto_WallBaseQuantities')?.quantities;
  assert.ok(qto);
  assert.ok(Math.abs(Number(qto.Width.value) - 200) < 1e-6);
  assert.equal(qto.Width.unit, 'mm', 'the file declares millimetres');
  assert.ok(Math.abs(Number(qto.NetVolume.value) - 1.26926493526358) < 1e-9);
  assert.ok(qto.NetVolume.unit, 'volume carries its unit');
  assert.equal(evidenceIsCurrent(snapshot), true);
});

test('an edit through the store\'s mutation path makes selection evidence stale and shows in a fresh capture', async () => {
  seedModel('arch', OFFSET, await sample('building-architecture.ifc'), WALL);
  const before = captureEvidence('selection');
  assert.ok(getOrCreateMutationView(useViewerStore, 'arch'));
  assert.ok(useViewerStore.getState().setProperty('arch', WALL, 'Pset_WallCommon', 'FireRating', 'REI90', PropertyValueType.Label));
  assert.ok(useViewerStore.getState().setAttribute('arch', WALL, 'Name', 'Edited wall', WALL_NAME));
  assert.equal(evidenceIsCurrent(before), false);
  assert.equal(pset(rowsOf(before)[0], 'Pset_WallCommon')?.FireRating, undefined, 'the frozen snapshot keeps what it saw');
  const [wall] = rowsOf(captureEvidence('selection'));
  assert.equal(pset(wall, 'Pset_WallCommon')?.FireRating, 'REI90');
  assert.equal(wall.name, 'Edited wall');
  assert.equal(wall.status, 'edited');
  assert.equal(wall.globalId, WALL_GUID);
});

test('a federated multi-selection reports exact native totals per model and samples at most 100 elements', async () => {
  const [a, b] = await Promise.all([sample('building-architecture.ifc'), sample('building-architecture-rev-b.ifc')]);
  seedModel('a', 0, a, WALL);
  const models = new Map(useViewerStore.getState().models);
  models.set('b', { ...models.get('a'), id: 'b', name: 'b', ifcDataStore: b, idOffset: 200_000 } as never);
  const refs = [...[...a.entityIndex.byId.keys()].slice(0, 90).map(expressId => ({ modelId: 'a', expressId })),
    ...[...b.entityIndex.byId.keys()].slice(0, 40).map(expressId => ({ modelId: 'b', expressId }))];
  useViewerStore.setState({ models, selectedEntitiesSet: new Set(refs.map(entityRefToString)) });
  const snapshot = captureEvidence('selection');
  const payload = JSON.parse(snapshot.payload);
  assert.equal(snapshot.totalRows, 130);
  assert.ok(snapshot.includedRows <= 100);
  assert.equal(payload.sampled, true);
  assert.equal(payload.evidence.summary.channel, 'multi');
  assert.equal(payload.evidence.summary.modelCount, 2);
  assert.deepEqual(payload.evidence.summary.byModel.map((m: { modelId: string; count: number }) => [m.modelId, m.count]), [['a', 90], ['b', 40]]);
  const classTotal = payload.evidence.summary.byClass.reduce((n: number, c: { count: number }) => n + c.count, 0);
  assert.equal(classTotal, 130, 'class counts cover the whole selection, not the sample');
  assert.ok(snapshot.payload.length <= 48_000);
  useViewerStore.setState({ selectedEntitiesSet: new Set(refs.slice(1).map(entityRefToString)) });
  assert.equal(evidenceIsCurrent(snapshot), false, 'a changed selection is a different subject');
});

test('selection is unavailable when nothing is selected', async () => {
  seedModel('arch', OFFSET, await sample('building-architecture.ifc'), WALL);
  useViewerStore.setState({ selectedEntityId: null, selectedEntity: null });
  const snapshot = captureEvidence('selection');
  assert.equal(JSON.parse(snapshot.payload).sourceAvailability, 'unavailable');
  assert.equal(snapshot.totalRows, 0);
});

test('the Properties panel header discusses the selection, and an edit in the panel refreshes it', async () => {
  seedModel('arch', OFFSET, await sample('building-architecture.ifc'), WALL);
  const ui = render(renderPanelBody('properties', () => undefined));
  await advance(0);
  const discuss = () => {
    const button = ui.querySelector('button[aria-label="Discuss with AI"]');
    assert.ok(button, 'the entity header offers Discuss with AI');
    click(button);
    const snapshot = useAssistant.getState().snapshot;
    assert.equal(snapshot?.source, 'selection');
    assert.ok(snapshot);
    return snapshot;
  };
  const first = discuss();
  assert.equal(rowsOf(first)[0].globalId, WALL_GUID);
  await addPropertyThroughDialog(ui, 'Pset_Review', 'Checked', 'yes');
  assert.equal(evidenceIsCurrent(first), false);
  assert.equal(pset(rowsOf(discuss())[0], 'Pset_Review')?.Checked, 'yes');
});
