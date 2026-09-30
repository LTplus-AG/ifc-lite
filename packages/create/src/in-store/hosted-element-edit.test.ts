/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #6232: real Bonsai mapped windows share their type and include a separate
 * Plan Body. Size edits must change the occurrence and cut, not the type. */
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { IfcCreator } from '../ifc-creator.js';
import { AnchorEntityReader, resolveSpatialAnchor } from './resolve-anchor.js';
import { addWallToStore } from './wall.js';
import { addHostedElementInStore, readHostOpeningExtents } from './hosted-element.js';
import { editHostedElementInStore, readHostedElementSize } from './hosted-element-edit.js';
import { placedBodyExtent } from './resolve-host.js';
import { readHostedFill } from './hosted-fill-read.js';
import { refId } from './host-geometry-frame.js';
import { reanchorHostedOpeningsInStore } from './hosted-placement-edit.js';

async function session() {
  const bytes = await readFile(new URL('../../../../apps/viewer/public/samples/hello-wall.ifc', import.meta.url));
  const store = await new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, { disableWorkerScan: true });
  const view = new MutablePropertyView(null, 'm'), editor = new StoreEditor(store, view);
  return { store, view, editor, reader: new AnchorEntityReader(store, view) };
}

describe('hosted occurrence edit (#6232)', () => {
  it('refuses nested opening placements before using parent-frame bounds (#6571 review)', async () => {
    const { store, view, editor, reader } = await session();
    const point = editor.addEntity('IfcCartesianPoint', [[0.2, 0.3, 0.4]]).expressId;
    const axis = editor.addEntity('IfcAxis2Placement3D', [`#${point}`, null, null]).expressId;
    const intermediate = editor.addEntity('IfcLocalPlacement', ['#1235', `#${axis}`]).expressId;
    const openingPlacement = refId(reader.entity(1299)!.attributes[5])!;
    editor.setPositionalAttribute(openingPlacement, 0, `#${intermediate}`);
    const records = view.getMutations(), entities = view.getNewEntities();
    expect(readHostedFill(store, 1262, view)).toBeNull();
    const cuts = readHostOpeningExtents(store, 1222, view);
    expect(cuts.unreadable).toContain(1299);
    expect(cuts.cuts.some(cut => cut.openingId === 1299)).toBe(false);
    for (const patch of [{ OverallWidth: 1.2 }, { Offset: 2 }]) {
      expect(() => editHostedElementInStore(store, editor, 1262, patch)).toThrow(/cannot be read/);
      expect(view.getMutations()).toEqual(records);
      expect(view.getNewEntities()).toEqual(entities);
    }
  });

  it('rolls back every fresh placement when a later filling cannot follow its opening (#6232)', async () => {
    const { store, view, editor, reader } = await session();
    const first = readHostedFill(store, 1262, view)!;
    const secondPlacement = refId(reader.entity(1407)!.attributes[5])!;
    editor.setPositionalAttribute(secondPlacement, 0, '#1235');
    const records = view.getMutations(), entities = view.getNewEntities();
    const original = reader.entity(first.openingId);
    expect(() => reanchorHostedOpeningsInStore(store, editor, first.hostId, [0.2, 0, 0])).toThrow(/not placed directly/);
    expect(view.getMutations()).toEqual(records);
    expect(view.getNewEntities()).toEqual(entities);
    expect(reader.entity(first.openingId)).toEqual(original);
  });

  it('refuses an unreadable cut before publishing the reanchor batch (#6232)', async () => {
    const { store, view, editor } = await session();
    editor.setPositionalAttribute(1443, 6, null);
    const records = view.getMutations(), entities = view.getNewEntities();
    expect(() => reanchorHostedOpeningsInStore(store, editor, 1222, [0.2, 0, 0])).toThrow(/Unreadable hosted cuts/);
    expect(view.getMutations()).toEqual(records);
    expect(view.getNewEntities()).toEqual(entities);
  });

  it('reads real tessellated/mapped dimensions despite the optional omitted attributes and separate Plan Body', async () => {
    const { store, view } = await session();
    const size = readHostedElementSize(store, 1262, view);
    expect(size?.OverallWidth).toBeCloseTo(0.9, 5);
    expect(size?.OverallHeight).toBeCloseTo(1.2, 5);
  });

  it('resizes the actual imported window and cut, preserving other type instances, metadata and both representations', async () => {
    const { store, view, editor, reader } = await session();
    const other = placedBodyExtent(store, 1407, view);
    const shared = [436, 458, 459, 435, 427, 434, 410].map(id => reader.entity(id));
    const before = reader.entity(1262)!;
    const cut = placedBodyExtent(store, 1299, view)!;
    editHostedElementInStore(store, editor, 1262, { OverallWidth: 1.2, OverallHeight: 1.4 });
    expect(readHostedElementSize(store, 1262, view)).toEqual({ OverallWidth: 1.2, OverallHeight: 1.4 });
    const actual = placedBodyExtent(store, 1299, view)!;
    expect(actual.max[0] - actual.min[0]).toBeCloseTo(1.2, 5);
    expect(actual.max[2] - actual.min[2]).toBeCloseTo(1.4, 5);
    expect((actual.max[0] + actual.min[0]) / 2).toBeCloseTo((cut.max[0] + cut.min[0]) / 2, 9);
    expect(actual.min[2]).toBeCloseTo(cut.min[2], 9);
    expect(actual.min[1]).toBeCloseTo(cut.min[1], 9);
    expect(actual.max[1]).toBeCloseTo(cut.max[1], 9);
    expect(placedBodyExtent(store, 1407, view)).toEqual(other);
    expect([436, 458, 459, 435, 427, 434, 410].map(id => reader.entity(id))).toEqual(shared);
    const after = reader.entity(1262)!;
    for (const name of ['GlobalId', 'Name', 'Description', 'ObjectType', 'Tag']) {
      expect(after.attributes[after.names.indexOf(name)]).toEqual(before.attributes[before.names.indexOf(name)]);
    }
    const nextShape = reader.entity(refId(after.attributes[6])!)!;
    expect(nextShape.attributes[2]).toHaveLength(2);
    const reps = (nextShape.attributes[2] as string[]).map(value => reader.entity(refId(value)!)!);
    expect(reps.map(rep => rep.attributes[0])).toEqual(['#15', '#28']);
    expect(reps.every(rep => rep.attributes[2] === 'MappedRepresentation')).toBe(true);
    // Type, void and fill relationships remain the same effective IFC graph.
    expect(reader.entity(1283)?.attributes[5]).toBe(459);
    expect(reader.entity(1334)?.attributes.slice(4)).toEqual([1299, 1262]);
  });

  it('moves the source opening and its window with fresh placements, leaving shared source points untouched', async () => {
    const { store, view, editor, reader } = await session();
    const original = readHostedFill(store, 1262, view)!;
    const point = reader.entity(original.locationPointId);
    const other = readHostedFill(store, 1407, view);
    const cut = placedBodyExtent(store, 1299, view)!;
    editHostedElementInStore(store, editor, 1262, { Offset: original.offset + 0.2, Sill: original.sill + 0.1 });
    const after = readHostedFill(store, 1262, view)!;
    expect(after.locationPointId).not.toBe(original.locationPointId);
    expect(reader.entity(original.locationPointId)).toEqual(point);
    expect(readHostedFill(store, 1407, view)).toEqual(other);
    const openingPlacement = refId(reader.entity(1299)!.attributes[5]);
    const fillingPlacement = reader.entity(refId(reader.entity(1262)!.attributes[5])!)!;
    expect(refId(fillingPlacement.attributes[0])).toBe(openingPlacement);
    const actual = placedBodyExtent(store, 1299, view)!;
    expect(actual.min[0]).toBeCloseTo(cut.min[0] + 0.2, 9);
    expect(actual.max[2]).toBeCloseTo(cut.max[2] + 0.1, 9);
  });

  it('moves a filling with an omitted optional Representation while refusing size edits (#6232 / #6571)', async () => {
    const { store, view, editor, reader } = await session();
    editor.setPositionalAttribute(1262, 6, null);
    const before = readHostedFill(store, 1262, view)!;
    const cut = placedBodyExtent(store, before.openingId, view)!;
    editHostedElementInStore(store, editor, 1262, { Offset: before.offset + 0.2, Sill: before.sill + 0.1 });
    const moved = placedBodyExtent(store, before.openingId, view)!;
    expect(moved.min[0]).toBeCloseTo(cut.min[0] + 0.2, 9);
    expect(moved.min[2]).toBeCloseTo(cut.min[2] + 0.1, 9);
    expect(reader.entity(1262)!.attributes[6]).toBeNull();
    expect(readHostedElementSize(store, 1262, view)).toBeNull();
    const records = view.getMutations(), entities = view.getNewEntities();
    expect(() => editHostedElementInStore(store, editor, 1262, { OverallWidth: 1.2 })).toThrow(/cannot be read/);
    expect(view.getMutations()).toEqual(records);
    expect(view.getNewEntities()).toEqual(entities);
    const fillingPlacement = refId(reader.entity(1262)!.attributes[5])!;
    editor.setPositionalAttribute(fillingPlacement, 0, '#1235');
    const invalid = view.getMutations();
    expect(() => editHostedElementInStore(store, editor, 1262, { Offset: before.offset + 0.3 })).toThrow(/not placed directly/);
    expect(view.getMutations()).toEqual(invalid);
    expect(view.getNewEntities()).toEqual(entities);
  });

  it('retains styled items and presentation layers on an existing scale wrapper during later size commits (#6232)', async () => {
    const { store, view, editor, reader } = await session();
    editHostedElementInStore(store, editor, 1262, { OverallWidth: 1.2 });
    const shape = reader.entity(refId(reader.entity(1262)!.attributes[6])!)!;
    const repId = refId((shape.attributes[2] as unknown[])[0])!;
    const itemId = refId((reader.entity(repId)!.attributes[3] as unknown[])[0])!;
    const styled = reader.entity(reader.firstId('IFCSTYLEDITEM')!)!;
    const styleRefs = styled.attributes[1];
    expect(Array.isArray(styleRefs)).toBe(true);
    if (!Array.isArray(styleRefs) || styleRefs.some(value => refId(value) === null)) throw new Error('The source style list is unreadable');
    const styleId = editor.addEntity('IfcStyledItem', [`#${itemId}`, styleRefs.map(value => `#${refId(value)!}`), 'Occurrence style']).expressId;
    const layerId = editor.addEntity('IfcPresentationLayerAssignment', ['Occurrence layer', null, [`#${repId}`], null]).expressId;
    const styleBefore = reader.entity(styleId), layerBefore = reader.entity(layerId);
    for (const OverallWidth of [1.1, 1.3, 0.9]) editHostedElementInStore(store, editor, 1262, { OverallWidth });
    const finalShape = reader.entity(refId(reader.entity(1262)!.attributes[6])!)!;
    const stack = (finalShape.attributes[2] as unknown[]).map(value => refId(value)!);
    const reachable = new Set<number>();
    while (stack.length) {
      const id = stack.pop()!;
      if (reachable.has(id)) continue;
      reachable.add(id);
      expect(reachable.size).toBeLessThan(100);
      const entity = reader.entity(id)!;
      if (entity.type.toUpperCase() === 'IFCSHAPEREPRESENTATION') stack.push(...(entity.attributes[3] as unknown[]).map(value => refId(value)!));
      else if (entity.type.toUpperCase() === 'IFCMAPPEDITEM') stack.push(refId(entity.attributes[0])!);
      else if (entity.type.toUpperCase() === 'IFCREPRESENTATIONMAP') stack.push(refId(entity.attributes[1])!);
    }
    expect(reachable.has(repId)).toBe(true);
    expect(reachable.has(itemId)).toBe(true);
    expect(reader.entity(styleId)).toEqual(styleBefore);
    expect(reader.entity(layerId)).toEqual(layerBefore);
    expect(readHostedElementSize(store, 1262, view)?.OverallWidth).toBe(0.9);
  });

  it('refuses moving or growing into another real source opening and leaves no writes', async () => {
    const { store, view, editor } = await session();
    const first = placedBodyExtent(store, 1299, view)!, second = placedBodyExtent(store, 1443, view)!;
    const location = readHostedFill(store, 1262, view)!;
    const delta = (second.min[0] + second.max[0] - first.min[0] - first.max[0]) / 2;
    expect(() => editHostedElementInStore(store, editor, 1262, { Offset: location.offset + delta })).toThrow(/overlaps opening/);
    expect(() => editHostedElementInStore(store, editor, 1262, { OverallWidth: 20 })).toThrow(/doesn't fit/);
    expect(view.getMutations()).toEqual([]);
    expect(view.getNewEntities()).toEqual([]);
  });

  it('rolls back mapping and dimension writes if a filling cannot follow a moved opening', async () => {
    const { store, view, editor, reader } = await session();
    editor.setPositionalAttribute(1349, 0, '#1235'); // Filling has an independent host placement.
    const before = view.getMutations(), records = view.getNewEntities();
    const shape = reader.entity(1262)!.attributes[6];
    expect(() => editHostedElementInStore(store, editor, 1262, { OverallWidth: 1, Offset: 2 })).toThrow(/not placed directly/);
    expect(view.getMutations()).toEqual(before);
    expect(view.getNewEntities()).toEqual(records);
    expect(reader.entity(1262)!.attributes[6]).toEqual(shape);
  });

  it('does not discard an unreadable additional Model Body part while ignoring Plan annotations', async () => {
    const { store, view, editor } = await session();
    editor.setPositionalAttribute(435, 3, ['#427', '#999999']);
    expect(readHostedElementSize(store, 1262, view)).toBeNull();
    const before = view.getMutations();
    expect(() => editHostedElementInStore(store, editor, 1262, { OverallWidth: 1 })).toThrow(/cannot be read/);
    expect(view.getMutations()).toEqual(before);
    expect(view.getNewEntities()).toEqual([]);
  });

  it('reports unreadable other cuts and cyclic filling placements before changing the selected occurrence', async () => {
    const { store, view, editor } = await session();
    editor.setPositionalAttribute(1457, 5, '#999999');
    const before = view.getMutations();
    expect(() => editHostedElementInStore(store, editor, 1262, { OverallWidth: 1 })).toThrow(/cannot be read/);
    expect(view.getMutations()).toEqual(before);
    editor.setPositionalAttribute(1349, 0, '#1349');
    expect(readHostedElementSize(store, 1262, view)).toBeNull();
    expect(view.getNewEntities()).toEqual([]);
  });

  for (const Schema of ['IFC2X3', 'IFC4', 'IFC4X3'] as const) {
    it(`resizes and moves authored ${Schema} geometry in native millimetres and enforces overlap on edits`, async () => {
      const creator = new IfcCreator({ Schema, LengthUnit: 'MILLIMETRE' });
      const storey = creator.addIfcBuildingStorey({ Name: 'GF', Elevation: 0 });
      const store = await new IfcParser().parseColumnar(new TextEncoder().encode(creator.toIfc().content).buffer, { disableWorkerScan: true });
      const view = new MutablePropertyView(null, 'm'), editor = new StoreEditor(store, view);
      const wall = addWallToStore(editor, resolveSpatialAnchor(store, storey, view), { Start: [0, 0, 0], End: [10, 0, 0], Height: 3, Thickness: 0.2 }).wallId;
      const first = addHostedElementInStore(store, editor, wall, { kind: 'door', params: { Offset: 2, Width: 0.9, Height: 2 } });
      addHostedElementInStore(store, editor, wall, { kind: 'door', params: { Offset: 6, Width: 0.8, Height: 2 } });
      editHostedElementInStore(store, editor, first.expressId, { OverallWidth: 1.2, OverallHeight: 2.5, Offset: 0.6 });
      const cut = placedBodyExtent(store, first.openingId, view)!;
      expect(cut.min[0]).toBeCloseTo(0, 7);
      expect(cut.max[0]).toBeCloseTo(1200, 7);
      expect(cut.max[2]).toBeCloseTo(2500, 7);
      expect(readHostedElementSize(store, first.expressId, view)).toEqual({ OverallWidth: 1.2, OverallHeight: 2.5 });
      const before = view.getMutations(), records = view.getNewEntities();
      expect(() => editHostedElementInStore(store, editor, first.expressId, { Offset: 5.9 })).toThrow(/overlaps opening/);
      expect(view.getMutations()).toEqual(before);
      expect(view.getNewEntities()).toEqual(records);
    });
  }

  it('rejects non-finite, nonpositive and overflowing dimensions without any write', async () => {
    const { store, view, editor } = await session();
    for (const OverallWidth of [NaN, Infinity, 0, -1, Number.MAX_VALUE]) {
      expect(() => editHostedElementInStore(store, editor, 1262, { OverallWidth })).toThrow();
      expect(view.getMutations()).toEqual([]);
      expect(view.getNewEntities()).toEqual([]);
    }
    store.schemaVersion = 'IFC5';
    expect(() => editHostedElementInStore(store, editor, 1262, { OverallWidth: 1 })).toThrow(/IFC2X3/);
  });
});
