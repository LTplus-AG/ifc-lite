/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { readFile } from 'node:fs/promises';
import { expect, it, vi } from 'vitest';
import { generateIfcGuid } from '@ifc-lite/encoding';
import { IfcParser, extractPropertiesOnDemand } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor, recordCompoundMutation, undoRecordedMutationOperations } from '@ifc-lite/mutations';
import { StepExporter } from '@ifc-lite/export';
import * as nativeCreate from '../index.js';
import { addOrdinaryElementInStore } from './ordinary-element.js';
import { AnchorEntityReader, resolveSpatialAnchor } from './resolve-anchor.js';
import { placementInAncestor, refId } from './host-geometry-frame.js';
import { addGridToStore } from './grid.js';
import { addHostedElementInStore } from './hosted-element.js';
import { effectiveStoreyId } from './edit/effective-storey.js';
import { meshStairs, stairMeshBounds, stairWasmAvailable } from './__test__/stair-mesh.oracle.js';

// #7328 published native API contract plus the real IFC semantic cases below.
// Existing index survives complete production rollback; no deleted private module
// is imported and no missing capability is substituted with a fallback.
function reassignElementsToStoreyInStore(...args: Parameters<typeof nativeCreate.reassignElementsToStoreyInStore>) {
  expect(typeof nativeCreate.reassignElementsToStoreyInStore).toBe('function');
  return nativeCreate.reassignElementsToStoreyInStore(...args);
}
function planStoreyReassignment(...args: Parameters<typeof nativeCreate.planStoreyReassignment>) {
  expect(typeof nativeCreate.planStoreyReassignment).toBe('function');
  return nativeCreate.planStoreyReassignment(...args);
}
function planStoreyReassignmentCandidates(...args: Parameters<typeof nativeCreate.planStoreyReassignmentCandidates>) {
  expect(typeof nativeCreate.planStoreyReassignmentCandidates).toBe('function');
  return nativeCreate.planStoreyReassignmentCandidates(...args);
}

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
      if (String(reader.entity(unit)?.attributes[1]).replaceAll('.', '') === 'LENGTHUNIT') editor.setPositionalAttribute(unit, 2, '.MILLI.');
    }
  }
  const text = () => new TextDecoder().decode(new StepExporter(store, view).export({ schema: 'IFC4', applyMutations: true, timeStamp: '2026-10-03T00:00:00' }).content);
  if (persisted) {
    store = await new IfcParser().parseColumnar(new TextEncoder().encode(text()).buffer, { disableWorkerScan: true });
    view = new MutablePropertyView(null, 'm'); editor = new StoreEditor(store, view);
    view.setOnDemandExtractor(id => extractPropertiesOnDemand(store, id));
  }
  const snapshot = () => structuredClone({ entities: [...view.getNewEntities()].sort((a, b) => a.expressId - b.expressId), mutations: view.getMutations(), changes: view.getEffectiveChanges(), next: view.peekNextExpressId() });
  return { store, view, editor, id, destination, destinationPlacement, text, snapshot };
}

for (const persisted of [false, true]) for (const millimetres of [false, true]) {
  it.skipIf(!stairWasmAvailable)(`#7328 same Root identity/world mesh and complete Undo, persisted=${persisted}, mm=${millimetres}`, async () => {
    const s = await fixture(persisted, millimetres);
    const reader = new AnchorEntityReader(s.store, s.view);
    const original = reader.entity(s.id)!;
    const before = s.snapshot(), beforeText = s.text();
    const beforeBounds = stairMeshBounds((await meshStairs(beforeText)).get(s.id)!);
    expect(beforeBounds.max[2] - beforeBounds.min[2]).toBeCloseTo(3, 5);
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

for (const relationship of ['IfcRelNests', 'IfcRelAggregates']) it(`#7328 refuses ${relationship} as an ordinary product spatial owner (PR #7342)`, async () => {
  const s = await fixture(), reader = new AnchorEntityReader(s.store, s.view);
  for (const id of reader.ids('IFCRELCONTAINEDINSPATIALSTRUCTURE')) {
    const rel = reader.entity(id)!;
    if (Array.isArray(rel.attributes[4]) && rel.attributes[4].some(child => refId(child) === s.id)) s.view.deleteEntity(id);
  }
  s.editor.addEntity(relationship, [generateIfcGuid(), null, null, null, '#42', [`#${s.id}`]]);
  const before = s.snapshot(), text = s.text();
  expect(() => reassignElementsToStoreyInStore(s.store, s.editor, [s.id], 42, s.destination)).toThrow(/spatial owner/);
  expect(s.snapshot()).toEqual(before);
  expect(s.text()).toBe(text);
});

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
      if (failure === 'duplicate GlobalId') {
        const point = s.editor.addEntity('IfcCartesianPoint', [[0, 0, 0]]).expressId;
        const axis = s.editor.addEntity('IfcAxis2Placement3D', [`#${point}`, null, null]).expressId;
        attributes[5] = `#${s.editor.addEntity('IfcLocalPlacement', [null, `#${axis}`]).expressId}`;
      }
      s.editor.addEntity(entity.type, attributes);
    }
    if (failure === 'grid destination') s.editor.setEntityType(s.destinationPlacement, 'IfcGridPlacement');
    const before = s.snapshot(), text = s.text();
    const expectedMessage = failure === 'duplicate GlobalId' ? /duplicate product GlobalId/
      : failure === 'shared placement' ? /shares/ : failure === 'stale' ? /stale/ : undefined;
    expect(() => reassignElementsToStoreyInStore(s.store, s.editor, ids, source, s.destination, expected)).toThrow(expectedMessage);
    expect(s.snapshot()).toEqual(before); expect(s.text()).toBe(text);
  });
}

it('#7328 refuses an explicit unreadable shared ancestor instead of cancelling a fabricated world frame', async () => {
  const s = await fixture(), reader = new AnchorEntityReader(s.store, s.view);
  const sourcePlacement = refId(reader.entity(42)!.attributes[5])!;
  const axis = reader.entity(s.destinationPlacement)!.attributes[1] as string;
  const malformed = s.editor.addEntity('IfcLocalPlacement', ['#0', axis]).expressId;
  s.editor.setPositionalAttribute(sourcePlacement, 0, `#${malformed}`);
  s.editor.setPositionalAttribute(s.destinationPlacement, 0, `#${malformed}`);
  const before = s.snapshot();
  expect(() => reassignElementsToStoreyInStore(s.store, s.editor, [s.id], 42, s.destination)).toThrow(/unreadable world placement/);
  expect(s.snapshot()).toEqual(before);
});


it.skipIf(!stairWasmAvailable)('#7328 carries the complete native door/opening chain without changing identities, bindings or world mesh', async () => {
  const s = await fixture();
  const door = addHostedElementInStore(s.store, s.editor, s.id, { kind: 'door', params: { Offset: 2, Width: 1, Height: 2, Name: 'Native hosted door' } });
  const reader = new AnchorEntityReader(s.store, s.view);
  const ids = [s.id, door.openingId, door.expressId].sort((a, b) => a - b);
  const records = ids.map(id => reader.entity(id));
  const relationships = ['IFCRELVOIDSELEMENT', 'IFCRELFILLSELEMENT'].flatMap(type => [...reader.ids(type)].map(id => ({ id, record: reader.entity(id) })));
  const beforeMeshes = await meshStairs(s.text()), before = s.snapshot();
  const result = recordCompoundMutation(s.view, draft => reassignElementsToStoreyInStore(s.store, new StoreEditor(s.store, draft), [s.id, door.expressId], 42, s.destination));
  expect(result.products.map(p => p.expressId)).toEqual(ids);
  expect(ids.map(id => reader.entity(id))).toEqual(records);
  expect(relationships.map(r => reader.entity(r.id))).toEqual(relationships.map(r => r.record));
  const afterMeshes = await meshStairs(s.text());
  for (const id of [s.id, door.expressId]) {
    const a = stairMeshBounds(beforeMeshes.get(id)!), b = stairMeshBounds(afterMeshes.get(id)!);
    for (const edge of ['min', 'max'] as const) for (let i = 0; i < 3; i++) expect(b[edge][i]).toBeCloseTo(a[edge][i], 5);
  }
  undoRecordedMutationOperations(s.view, 1, () => { throw new Error('one compound required'); });
  expect({ ...s.snapshot(), next: before.next }).toEqual(before);
});

it('#7328 refuses detached hosted fillings and duplicate containment ownership atomically', async () => {
  const s = await fixture();
  const door = addHostedElementInStore(s.store, s.editor, s.id, { kind: 'door', params: { Offset: 2, Width: 1, Height: 2 } });
  const before = s.snapshot();
  expect(() => reassignElementsToStoreyInStore(s.store, s.editor, [door.expressId], 42, s.destination)).toThrow(/external host/);
  expect(s.snapshot()).toEqual(before);
  s.editor.addEntity('IfcRelContainedInSpatialStructure', [generateIfcGuid(), null, null, null, [`#${s.id}`], '#42']);
  const duplicated = s.snapshot();
  expect(() => reassignElementsToStoreyInStore(s.store, s.editor, [s.id], 42, s.destination)).toThrow(/duplicate spatial ownership/);
  expect(s.snapshot()).toEqual(duplicated);
});

it('#7328 preserves spatial aggregation for native spaces and unrelated source membership', async () => {
  const s = await fixture();
  const space = addOrdinaryElementInStore(s.editor, resolveSpatialAnchor(s.store, 42, s.view), { kind: 'space', params: { Position: [20, 20, 0], Width: 4, Depth: 3, Height: 3 } });
  const reader = new AnchorEntityReader(s.store, s.view);
  const original = reader.entity(space);
  reassignElementsToStoreyInStore(s.store, s.editor, [space], 42, s.destination);
  expect(reader.entity(space)).toEqual(original);
  expect(effectiveStoreyId(s.store, s.view, space)).toBe(s.destination);
  expect(effectiveStoreyId(s.store, s.view, s.id)).toBe(42);
  const destinationRelations = [...reader.ids('IFCRELAGGREGATES')].map(id => reader.entity(id)).filter(r => refId(r?.attributes[4]) === s.destination);
  expect(destinationRelations.some(r => Array.isArray(r?.attributes[5]) && r.attributes[5].some(v => refId(v) === space))).toBe(true);
});


it('#7328 a genuine late GUID allocation failure rolls back placement writes, partial memberships, journal and allocator', async () => {
  const s = await fixture(), reader = new AnchorEntityReader(s.store, s.view);
  const membership = [...reader.ids('IFCRELCONTAINEDINSPATIALSTRUCTURE')].find(id => (reader.entity(id)?.attributes[4] as unknown[])?.some(value => refId(value) === s.id))!;
  const unrelated = s.editor.addEntity('IfcAnnotation', [generateIfcGuid(), null, 'Unmoved native annotation', null, null, null, null]).expressId;
  s.editor.setPositionalAttribute(membership, 4, [`#${s.id}`, `#${unrelated}`]);
  const before = s.snapshot(), text = s.text();
  const random = vi.spyOn(crypto, 'randomUUID').mockImplementation(() => { throw new Error('injected relationship GUID failure'); });
  try {
    expect(() => reassignElementsToStoreyInStore(s.store, s.editor, [s.id], 42, s.destination)).toThrow('injected relationship GUID failure');
    expect(random).toHaveBeenCalledTimes(1);
    expect(s.snapshot()).toEqual(before);
    expect(s.text()).toBe(text);
  } finally { random.mockRestore(); }
});

it.skipIf(!stairWasmAvailable)('#7328 canonical full 3D frames preserve native world geometry across tilted storeys', async () => {
  const s = await fixture(), reader = new AnchorEntityReader(s.store, s.view);
  for (const [placement, direction] of [[refId(reader.entity(42)!.attributes[5])!, [0, 1, 1]], [s.destinationPlacement, [1, 0, 1]]] as const) {
    const axis = refId(reader.entity(placement)!.attributes[1])!;
    const z = s.editor.addEntity('IfcDirection', [[...direction]]).expressId;
    s.editor.setPositionalAttribute(axis, 1, `#${z}`);
  }
  const before = stairMeshBounds((await meshStairs(s.text())).get(s.id)!);
  reassignElementsToStoreyInStore(s.store, s.editor, [s.id], 42, s.destination);
  const after = stairMeshBounds((await meshStairs(s.text())).get(s.id)!);
  for (const edge of ['min', 'max'] as const) for (let i = 0; i < 3; i++) expect(after[edge][i]).toBeCloseTo(before[edge][i], 5);
});

it('#7328 refuses finite input coordinates whose composed world frame overflows', async () => {
  const s = await fixture(), reader = new AnchorEntityReader(s.store, s.view);
  const sourcePlacement = refId(reader.entity(42)!.attributes[5])!;
  const sourceAxis = refId(reader.entity(sourcePlacement)!.attributes[1])!;
  const sourcePoint = refId(reader.entity(sourceAxis)!.attributes[0])!;
  const productPlacement = refId(reader.entity(s.id)!.attributes[5])!;
  const productAxis = refId(reader.entity(productPlacement)!.attributes[1])!;
  const productPoint = refId(reader.entity(productAxis)!.attributes[0])!;
  s.editor.setPositionalAttribute(sourcePoint, 0, [0, 1e308, 0]);
  s.editor.setPositionalAttribute(productPoint, 0, [1e308, 0, 0]);
  const before = s.snapshot();
  expect(() => reassignElementsToStoreyInStore(s.store, s.editor, [s.id], 42, s.destination)).toThrow(/unreadable world placement/);
  expect(s.snapshot()).toEqual(before);
});


it('#7328 refuses native grids whose implicit axis-bound product dependencies are outside this operation', async () => {
  const s = await fixture();
  const grid = addGridToStore(s.editor, resolveSpatialAnchor(s.store, 42, s.view), {
    UAxes: [{ Tag: '1', Start: [0, 0], End: [0, 10] }], VAxes: [{ Tag: 'A', Start: [0, 0], End: [10, 0] }],
  });
  const before = s.snapshot();
  expect(() => reassignElementsToStoreyInStore(s.store, s.editor, [grid.gridId], 42, s.destination)).toThrow(/not a supported movable product/);
  expect(s.snapshot()).toEqual(before);
});

for (const relation of ['IfcRelVoidsElement', 'IfcRelFillsElement']) it(`#7328 malformed ${relation} cannot make a storey a hosted dependency owner`, async () => {
  const s = await fixture();
  s.editor.addEntity(relation, [generateIfcGuid(), null, null, null, '#42', `#${s.id}`]);
  const before = s.snapshot(), text = s.text();
  expect(() => reassignElementsToStoreyInStore(s.store, s.editor, [s.id], 42, s.destination)).toThrow(/storey cannot own hosted dependencies/);
  expect(s.snapshot()).toEqual(before); expect(s.text()).toBe(text);
});

it('#7328 destination candidates reuse one effective Root inventory and match independent native plans', async () => {
  const s = await fixture(), reader = new AnchorEntityReader(s.store, s.view);
  const destinationRecord = reader.entity(s.destination)!;
  const destinations = [s.destination];
  for (let i = 0; i < 4; i++) {
    const attributes = [...destinationRecord.attributes] as Parameters<StoreEditor['addEntity']>[1];
    attributes[0] = generateIfcGuid(); attributes[2] = `Destination ${i}`;
    destinations.push(s.editor.addEntity('IfcBuildingStorey', attributes).expressId);
  }
  const before = s.snapshot(), text = s.text();
  const extraction = vi.spyOn(s.view, 'getNewEntities');
  const candidates = planStoreyReassignmentCandidates(s.store, s.view, [s.id], 42, destinations);
  const batchScans = extraction.mock.calls.length; extraction.mockClear();
  const independent = destinations.map(id => planStoreyReassignment(s.store, s.view, [s.id], 42, id));
  const separateScans = extraction.mock.calls.length; extraction.mockRestore();
  expect(candidates.map(candidate => candidate.plan)).toEqual(independent);
  expect(candidates.every(candidate => candidate.refusal === null)).toBe(true);
  expect(batchScans).toBeLessThan(separateScans);
  expect(s.snapshot()).toEqual(before); expect(s.text()).toBe(text);
  const mixed = planStoreyReassignmentCandidates(s.store, s.view, [s.id], 42, [s.destination, 99999999]);
  expect(mixed[0].plan).toEqual(independent[0]); expect(mixed[1].plan).toBeNull();
  expect(mixed[1].refusal).toMatch(/not a live IfcBuildingStorey/);
});

it('#7328 preserves distinct containment identities and metadata when moving whole and partial memberships', async () => {
  const s = await fixture(), reader = new AnchorEntityReader(s.store, s.view);
  const second = addOrdinaryElementInStore(s.editor, resolveSpatialAnchor(s.store, 42, s.view), { kind: 'wall', params: { Start: [0, 9, 0], End: [4, 9, 0], Thickness: .2, Height: 3 } });
  const relationOf = (product: number) => [...reader.ids('IFCRELCONTAINEDINSPATIALSTRUCTURE')].find(id => (reader.entity(id)?.attributes[4] as unknown[])?.some(value => refId(value) === product))!;
  const firstRelation = relationOf(s.id), secondRelation = relationOf(second);
  expect(firstRelation).not.toBe(secondRelation);
  for (const [id, name, description] of [[firstRelation, 'Zone A', 'Whole source membership'], [secondRelation, 'Zone B', 'Partial source membership']] as const) {
    s.editor.setPositionalAttribute(id, 2, name); s.editor.setPositionalAttribute(id, 3, description);
  }
  const unrelated = s.editor.addEntity('IfcAnnotation', [generateIfcGuid(), null, 'Unmoved annotation', null, null, null, null]).expressId;
  s.editor.setPositionalAttribute(secondRelation, 4, [`#${second}`, `#${unrelated}`]);
  const first = reader.entity(firstRelation)!, originalSecond = reader.entity(secondRelation)!, before = s.snapshot();
  recordCompoundMutation(s.view, draft => reassignElementsToStoreyInStore(s.store, new StoreEditor(s.store, draft), [s.id, second], 42, s.destination));
  const destination = [...reader.ids('IFCRELCONTAINEDINSPATIALSTRUCTURE')].filter(id => refId(reader.entity(id)?.attributes[5]) === s.destination);
  expect(destination).toHaveLength(2);
  expect(reader.entity(firstRelation)?.attributes).toEqual([...first.attributes.slice(0, 5), `#${s.destination}`]);
  const split = destination.find(id => id !== firstRelation)!;
  expect(reader.entity(split)?.attributes.slice(1, 4)).toEqual(originalSecond.attributes.slice(1, 4));
  expect(reader.entity(split)?.attributes[0]).not.toBe(originalSecond.attributes[0]);
  expect(reader.entity(split)?.attributes[4]).toEqual([`#${second}`]);
  expect(reader.entity(secondRelation)?.attributes).toEqual([...originalSecond.attributes.slice(0, 4), [`#${unrelated}`], '#42']);
  const saved = await new IfcParser().parseColumnar(new TextEncoder().encode(s.text()).buffer, {disableWorkerScan: true});
  const savedReader = new AnchorEntityReader(saved, null);
  for (const id of [firstRelation, split]) {
    const savedAttributes = savedReader.entity(id)!.attributes, liveAttributes = reader.entity(id)!.attributes;
    expect(savedAttributes.slice(0, 4)).toEqual(liveAttributes.slice(0, 4));
    expect((savedAttributes[4] as unknown[]).map(refId)).toEqual((liveAttributes[4] as unknown[]).map(refId));
    expect(refId(savedAttributes[5])).toBe(refId(liveAttributes[5]));
  }
  undoRecordedMutationOperations(s.view, 1, () => { throw new Error('one compound required'); });
  expect({...s.snapshot(), next: before.next}).toEqual(before);
});

it('#7328 complete relationship metadata pins refuse changed membership names before native writes', async () => {
  const s = await fixture(), reader = new AnchorEntityReader(s.store, s.view);
  const relation = [...reader.ids('IFCRELCONTAINEDINSPATIALSTRUCTURE')].find(id => (reader.entity(id)?.attributes[4] as unknown[])?.some(value => refId(value) === s.id))!;
  const expected = planStoreyReassignment(s.store, s.view, [s.id], 42, s.destination);
  s.editor.setPositionalAttribute(relation, 2, 'Membership changed after capture');
  const before = s.snapshot(), text = s.text();
  expect(() => reassignElementsToStoreyInStore(s.store, s.editor, [s.id], 42, s.destination, expected)).toThrow(/stale/);
  expect(s.snapshot()).toEqual(before); expect(s.text()).toBe(text);
});
