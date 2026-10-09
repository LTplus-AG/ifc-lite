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
import { refId } from './host-geometry-frame.js';
import { planStoreyReassignment } from './storey-reassignment-plan.js';
import { reassignElementsToStoreyInStore } from './storey-reassignment.js';

async function fixture(persisted: boolean) {
  const bytes = await readFile(new URL('../../../../apps/viewer/public/samples/hello-wall.ifc', import.meta.url));
  const parse = (source: ArrayBuffer) => new IfcParser().parseColumnar(source, { disableWorkerScan: true });
  let store = await parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  let view = new MutablePropertyView(null, 'm'), editor = new StoreEditor(store, view);
  const ids = [0, 4].map(y => addOrdinaryElementInStore(editor, resolveSpatialAnchor(store, 42, view), {
    kind: 'wall', params: { Start: [0, y, 0], End: [4, y, 0], Thickness: .2, Height: 3 },
  }));
  const point = editor.addEntity('IfcCartesianPoint', [[20, 0, 0]]).expressId;
  const axis = editor.addEntity('IfcAxis2Placement3D', [`#${point}`, null, null]).expressId;
  const placement = editor.addEntity('IfcLocalPlacement', [null, `#${axis}`]).expressId;
  const destination = editor.addEntity('IfcBuildingStorey', [generateIfcGuid(), null, 'Destination', null, null, `#${placement}`, null, '.ELEMENT.', 0]).expressId;
  editor.addEntity('IfcRelAggregates', [generateIfcGuid(), null, null, null, '#36', [`#${destination}`]]);
  const text = () => new TextDecoder().decode(new StepExporter(store, view).export({ schema: 'IFC4', applyMutations: true, timeStamp: '2026-10-03T00:00:00' }).content);
  if (persisted) {
    store = await parse(new TextEncoder().encode(text()).buffer);
    view = new MutablePropertyView(null, 'm'); editor = new StoreEditor(store, view);
  }
  view.setOnDemandExtractor(id => extractPropertiesOnDemand(store, id));
  const reader = new AnchorEntityReader(store, view);
  const relations = ids.map(product => [...reader.ids('IFCRELCONTAINEDINSPATIALSTRUCTURE')].find(id =>
    (reader.entity(id)?.attributes[4] as unknown[])?.some(value => refId(value) === product))!);
  expect(relations[0]).not.toBe(relations[1]);
  const snapshot = () => structuredClone({ entities: [...view.getNewEntities()].sort((a, b) => a.expressId - b.expressId), mutations: view.getMutations(), changes: view.getEffectiveChanges(), next: view.peekNextExpressId() });
  return { store, view, editor, reader, ids, relations, destination, parse, text, snapshot };
}

for (const persisted of [false, true]) for (const failure of ['duplicate', 'missing', 'malformed', 'deleted', 'retyped'] as const) {
  it(`#7328 retained containment ${failure} identity refuses without writes or stealing Undo, persisted=${persisted} (PR #7342)`, async () => {
    const s = await fixture(persisted), [first, second] = s.relations;
    expect(planStoreyReassignment(s.store, s.view, [s.ids[0]], 42, s.destination).products.map(p => p.expressId)).toEqual([s.ids[0]]);
    if (failure === 'duplicate') s.editor.setPositionalAttribute(second, 0, s.reader.entity(first)!.attributes[0] as string);
    else if (failure === 'missing') s.editor.setPositionalAttribute(first, 0, null);
    else if (failure === 'malformed') s.editor.setPositionalAttribute(first, 0, 'not-an-ifc-guid');
    else if (failure === 'deleted') s.editor.removeEntity(first);
    else s.editor.setEntityType(first, 'IfcAnnotation');
    const prior = s.snapshot(), priorText = s.text();
    // A real preceding native compound is the next Undo operation; a refused
    // reassignment must neither consume it nor add a checkpoint above it.
    recordCompoundMutation(s.view, draft => new StoreEditor(s.store, draft).setPositionalAttribute(s.ids[1], 2, 'Independent native edit'));
    const before = s.snapshot(), text = s.text(), revision = s.view.getMutationRevision();
    expect(() => recordCompoundMutation(s.view, draft => reassignElementsToStoreyInStore(s.store, new StoreEditor(s.store, draft), [s.ids[0]], 42, s.destination)))
      .toThrow(failure === 'deleted' || failure === 'retyped' ? /spatial owner/ : /relationship GlobalId/);
    expect(s.view.getMutationRevision()).toBe(revision);
    expect(s.snapshot()).toEqual(before); expect(s.text()).toBe(text);
    const saved = await s.parse(new TextEncoder().encode(text).buffer);
    expect(saved.getEntity(s.ids[0])?.attributes[0]).toBe(s.reader.entity(s.ids[0])!.attributes[0]);
    if (failure === 'duplicate') expect(saved.getEntity(first)?.attributes[0]).toBe(saved.getEntity(second)?.attributes[0]);
    if (failure === 'missing') expect(saved.getEntity(first)?.attributes[0]).toBeNull();
    if (failure === 'malformed') expect(saved.getEntity(first)?.attributes[0]).toBe('not-an-ifc-guid');
    if (failure === 'deleted') expect(saved.entityIndex.byId.has(first)).toBe(false);
    if (failure === 'retyped') expect(saved.entities.getTypeName(first)).toBe('IfcAnnotation');
    undoRecordedMutationOperations(s.view, 1, () => { throw new Error('The preceding native compound must remain next'); });
    expect(s.snapshot()).toEqual(prior); expect(s.text()).toBe(priorText);
  });
}

for (const persisted of [false, true]) it(`#7328 a material Name equal to a retained relationship GUID is not a Root collision, persisted=${persisted}`, async () => {
  const s = await fixture(persisted), first = s.relations[0], GlobalId = s.reader.entity(first)!.attributes[0];
  s.editor.addEntity('IfcMaterial', [GlobalId as string, null, null]);
  const before = s.snapshot(), text = s.text();
  recordCompoundMutation(s.view, draft => reassignElementsToStoreyInStore(s.store, new StoreEditor(s.store, draft), [s.ids[0]], 42, s.destination));
  const saved = await s.parse(new TextEncoder().encode(s.text()).buffer);
  expect(saved.getEntity(first)?.attributes[0]).toBe(GlobalId);
  expect(refId(saved.getEntity(first)?.attributes[5])).toBe(s.destination);
  undoRecordedMutationOperations(s.view, 1, () => { throw new Error('One native reassignment compound required'); });
  expect({ ...s.snapshot(), next: before.next }).toEqual(before); expect(s.text()).toBe(text);
});
