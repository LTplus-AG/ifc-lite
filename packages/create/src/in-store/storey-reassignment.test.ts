/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { generateIfcGuid } from '@ifc-lite/encoding';
import { IfcParser, extractPropertiesOnDemand } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor, recordCompoundMutation, undoRecordedMutationOperations } from '@ifc-lite/mutations';
import { StepExporter } from '@ifc-lite/export';
import { addOrdinaryElementInStore } from './ordinary-element.js';
import { AnchorEntityReader, resolveSpatialAnchor } from './resolve-anchor.js';
import { placementInAncestor, refId } from './host-geometry-frame.js';
import { reassignElementsToStoreyInStore } from './storey-reassignment.js';
import { planStoreyReassignment } from './storey-reassignment-plan.js';
import { effectiveStoreyId } from './edit/effective-storey.js';
import { meshStairs, stairMeshBounds, stairWasmAvailable } from './__test__/stair-mesh.oracle.js';

async function fixture(persisted = false, millimetres = false) {
  const bytes = await readFile(new URL('../../../../apps/viewer/public/samples/hello-wall.ifc', import.meta.url));
  let store = await new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, { disableWorkerScan: true });
  let view = new MutablePropertyView(null, 'm'), editor = new StoreEditor(store, view);
  view.setOnDemandExtractor(id => extractPropertiesOnDemand(store, id));
  const anchor = resolveSpatialAnchor(store, 42, view);
  const frame = (position: number[], direction: number[], parent: number | null) => {
    const point = editor.addEntity('IfcCartesianPoint', [position]).expressId;
    const x = editor.addEntity('IfcDirection', [direction]).expressId;
    const axis = editor.addEntity('IfcAxis2Placement3D', [`#${point}`, null, `#${x}`]).expressId;
    return editor.addEntity('IfcLocalPlacement', [parent === null ? null : `#${parent}`, `#${axis}`]).expressId;
  };
  const scale = millimetres ? 1000 : 1;
  const sourcePlacement = frame([2 * scale, -3 * scale, 4 * scale], [0, 1, 0], null);
  editor.setPositionalAttribute(42, 5, `#${sourcePlacement}`);
  const destinationPlacement = frame([-7 * scale, 6 * scale, 12 * scale], [1, 1, 0], null);
  const destination = editor.addEntity('IfcBuildingStorey', [generateIfcGuid(), null, 'Destination', null, null, `#${destinationPlacement}`, null, '.ELEMENT.', 12 * scale]).expressId;
  editor.addEntity('IfcRelAggregates', [generateIfcGuid(), null, null, null, '#36', [`#${destination}`]]);
  const id = addOrdinaryElementInStore(editor, { ...anchor, storeyPlacementId: sourcePlacement, lengthUnitScale: millimetres ? .001 : 1 }, { kind: 'wall', params: { Start: [0, 5, 0], End: [8, 5, 0], Thickness: .2, Height: 3 } });
  if (millimetres) {
    const reader = new AnchorEntityReader(store, view);
    for (const unit of reader.ids('IFCSIUNIT')) {
      if (reader.entity(unit)?.attributes[1] === '.LENGTHUNIT.') editor.setPositionalAttribute(unit, 2, '.MILLI.');
    }
  }
  const text = () => new TextDecoder().decode(new StepExporter(store, view).export({ schema: 'IFC4', applyMutations: true, timeStamp: '2026-10-03T00:00:00' }).content);
  if (persisted) {
    store = await new IfcParser().parseColumnar(new TextEncoder().encode(text()).buffer, { disableWorkerScan: true });
    view = new MutablePropertyView(null, 'm'); editor = new StoreEditor(store, view);
    view.setOnDemandExtractor(id => extractPropertiesOnDemand(store, id));
  }
  const snapshot = () => structuredClone({ entities: view.getNewEntities(), mutations: view.getMutations(), changes: view.getEffectiveChanges(), next: view.peekNextExpressId() });
  return { store, view, editor, id, destination, destinationPlacement, text, snapshot };
}

for (const persisted of [false, true]) for (const millimetres of [false, true]) {
  it.skipIf(!stairWasmAvailable)(`#7328 same Root identity/world mesh and complete Undo, persisted=${persisted}, mm=${millimetres}`, async () => {
    const s = await fixture(persisted, millimetres);
    const reader = new AnchorEntityReader(s.store, s.view);
    const original = reader.entity(s.id)!;
    const before = s.snapshot(), beforeText = s.text();
    const beforeBounds = stairMeshBounds((await meshStairs(beforeText)).get(s.id)!);
    const plan = planStoreyReassignment(s.store, s.view, [s.id], 42, s.destination);
    recordCompoundMutation(s.view, draftView => reassignElementsToStoreyInStore(s.store, new StoreEditor(s.store, draftView), [s.id], 42, s.destination, plan));
    expect(reader.entity(s.id)).toEqual(original);
    expect(effectiveStoreyId(s.store, s.view, s.id)).toBe(s.destination);
    const afterBounds = stairMeshBounds((await meshStairs(s.text())).get(s.id)!);
    for (const edge of ['min', 'max'] as const) for (let i = 0; i < 3; i++) expect(afterBounds[edge][i]).toBeCloseTo(beforeBounds[edge][i], 5);
    const reparsed = await new IfcParser().parseColumnar(new TextEncoder().encode(s.text()).buffer, { disableWorkerScan: true });
    expect(reparsed.entities.getExpressIdByGlobalId(String(original.attributes[0]))).toBe(s.id);
    expect(effectiveStoreyId(reparsed, null, s.id)).toBe(s.destination);
    undoRecordedMutationOperations(s.view, 1, () => { throw new Error('one compound reassignment required'); });
    // Native Undo restores the graph and journal; allocated IDs remain monotonic.
    const restored = s.snapshot();
    expect({ ...restored, next: before.next }).toEqual(before);
    expect(restored.next).toBeGreaterThan(before.next);
    expect(s.text()).toBe(beforeText);
  });
}

it('#7328 closes aggregate dependencies while preserving placement identities', async () => {
  const s = await fixture();
  const reader = new AnchorEntityReader(s.store, s.view), rootPlacement = refId(reader.entity(s.id)!.attributes[5])!;
  const point = s.editor.addEntity('IfcCartesianPoint', [[1, 2, 3]]).expressId;
  const axis = s.editor.addEntity('IfcAxis2Placement3D', [`#${point}`, null, null]).expressId;
  const childPlacement = s.editor.addEntity('IfcLocalPlacement', [`#${rootPlacement}`, `#${axis}`]).expressId;
  const child = s.editor.addEntity('IfcBuildingElementProxy', [generateIfcGuid(), null, 'Part', null, null, `#${childPlacement}`, null, null, '.NOTDEFINED.']).expressId;
  s.editor.addEntity('IfcRelAggregates', [generateIfcGuid(), null, null, null, `#${s.id}`, [`#${child}`]]);
  const before = placementInAncestor(reader, childPlacement, null);
  const result = reassignElementsToStoreyInStore(s.store, s.editor, [s.id], 42, s.destination);
  expect(result.products.map(product => product.expressId)).toEqual([s.id, child]);
  expect(result.placements.map(placement => placement.expressId)).toEqual([rootPlacement]);
  expect(reader.entity(childPlacement)?.attributes[0]).toBe(`#${rootPlacement}`);
  const after = placementInAncestor(reader, childPlacement, null)!;
  for (const axis of ['o', 'x', 'y', 'z'] as const) for (let i = 0; i < 3; i++) expect(after[axis][i]).toBeCloseTo(before![axis][i], 9);
  expect(effectiveStoreyId(s.store, s.view, child)).toBe(s.destination);
});

for (const failure of ['duplicate selection', 'missing', 'wrong source', 'stale', 'shared placement', 'duplicate GlobalId', 'grid destination'] as const) {
  it(`#7328 ${failure} preserves graph, history and allocator`, async () => {
    const s = await fixture();
    const reader = new AnchorEntityReader(s.store, s.view);
    const expected = planStoreyReassignment(s.store, s.view, [s.id], 42, s.destination);
    let ids = [s.id], source = 42;
    if (failure === 'duplicate selection') ids = [s.id, s.id];
    if (failure === 'missing') ids = [999999999];
    if (failure === 'wrong source') source = s.destination;
    if (failure === 'stale') s.editor.setAttribute(s.id, 'Name', 'Changed after review');
    if (failure === 'shared placement' || failure === 'duplicate GlobalId') {
      const entity = reader.entity(s.id)!;
      const attributes = [...entity.attributes] as Parameters<StoreEditor['addEntity']>[1];
      if (failure === 'shared placement') attributes[0] = generateIfcGuid();
      s.editor.addEntity(entity.type, attributes);
    }
    if (failure === 'grid destination') s.editor.setEntityType(s.destinationPlacement, 'IfcGridPlacement');
    const before = s.snapshot(), text = s.text();
    expect(() => reassignElementsToStoreyInStore(s.store, s.editor, ids, source, s.destination, expected)).toThrow();
    expect(s.snapshot()).toEqual(before); expect(s.text()).toBe(text);
  });
}
