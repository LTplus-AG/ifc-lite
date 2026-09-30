/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #6232 D5: source openings in the Bonsai sample are mapped swept solids.
 * Bounds must follow the map, including its authored origin and every instance. */
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { placedBodyExtent } from './resolve-host.js';
import { readHostOpeningExtents, addHostedElementInStore } from './hosted-element.js';

async function session() {
  const source = await readFile(new URL('../../../../apps/viewer/public/samples/hello-wall.ifc', import.meta.url));
  const store = await new IfcParser().parseColumnar(source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength) as ArrayBuffer, { disableWorkerScan: true });
  const view = new MutablePropertyView(null, 'm');
  return { store, view, editor: new StoreEditor(store, view) };
}

describe('#6232 D5 mapped opening bounds', () => {
  it('matches independently calculated bounds of the actual Bonsai source opening', async () => {
    const { store, view } = await session();
    // Source geometry: #1305 spans X=[0,0.899999976158142],
    // profile Y=[0,1.20000004768372]. #1311 turns that Y into Z,
    // starts at Y=-0.600000023841858, and #1313 extrudes 1.2 along +Y.
    // Identity mapping #1318/#1324, then #1340 adds [1.76767492294312,0,1].
    // These constants come from the authored IFC, not another geometry reader.
    const bounds = placedBodyExtent(store, 1299, view)!;
    expect(bounds.min).toEqual([1.76767492294312, -0.600000023841858, 1]);
    const expectedMax = [2.667674899101262, 0.599999976158142, 2.20000004768372];
    bounds.max.forEach((value, i) => expect(value).toBeCloseTo(expectedMax[i], 12));
    const cut = readHostOpeningExtents(store, 1222, view).cuts.find(c => c.openingId === 1299)!;
    expect(cut.bounds).toEqual(bounds);
  });

  it('applies MappingTarget · MappingOrigin, rotation, translation and nonuniform scale', async () => {
    const { store, view, editor } = await session();
    editor.setPositionalAttribute(1315, 0, [2, 0, 0]); // MappingOrigin Location
    editor.setPositionalAttribute(1320, 0, [1, 2, 3]); // MappingTarget LocalOrigin
    editor.setPositionalAttribute(1321, 0, [0, 1, 1]); // Axis1 projected off Z by IfcBaseAxis
    editor.setPositionalAttribute(1322, 0, [-1, 0, 1]); // Axis2 projected off Z and X
    const target = editor.addEntity('IfcCartesianTransformationOperator3DnonUniform', ['#1321', '#1322', '#1320', 2, '#1323', 3, 4]);
    editor.setPositionalAttribute(1325, 1, `#${target.expressId}`);
    const after = placedBodyExtent(store, 1299, view)!;
    // Authored source bounds are X=[0,.9], Y=[-.6,.6], Z=[0,1.2].
    // Origin adds (2,0,0), then target yields (1-3y,6+2x,3+4z).
    // Product #1340 finally adds (1.76767492294312,0,1).
    expect(after.min[0]).toBeCloseTo(1.76767492294312 + 1 - 3 * 0.6, 5);
    expect(after.max[0]).toBeCloseTo(1.76767492294312 + 1 + 3 * 0.6, 5);
    expect(after.min[1]).toBeCloseTo(6, 5);
    expect(after.max[1]).toBeCloseTo(7.8, 5);
    expect(after.min[2]).toBeCloseTo(4, 5);
    expect(after.max[2]).toBeCloseTo(8.8, 5);
  });

  it('keeps both instances of a shared mapping under different transforms', async () => {
    const { store, view, editor } = await session();
    const before = placedBodyExtent(store, 1299, view)!;
    const point = editor.addEntity('IfcCartesianPoint', [[4, 0, 0]]);
    const target = editor.addEntity('IfcCartesianTransformationOperator3D', ['#1321', '#1322', `#${point.expressId}`, 1, '#1323']);
    const mapped = editor.addEntity('IfcMappedItem', ['#1319', `#${target.expressId}`]);
    const rep = editor.addEntity('IfcShapeRepresentation', ['#15', 'Body', 'MappedRepresentation', ['#1325', `#${mapped.expressId}`]]);
    editor.setPositionalAttribute(1327, 2, [`#${rep.expressId}`]);
    const after = placedBodyExtent(store, 1299, view)!;
    expect(after.min[0]).toBeCloseTo(before.min[0], 9);
    expect(after.max[0]).toBeCloseTo(before.max[0] + 4, 9);
  });

  it('bounds cycles and acyclic fan-out and reports the opening as unreadable', async () => {
    const { store, view, editor } = await session();
    editor.setPositionalAttribute(1314, 3, ['#1325']); // mapped item -> map -> itself
    expect(placedBodyExtent(store, 1299, view)).toBeNull();
    expect(readHostOpeningExtents(store, 1222, view).unreadable).toContain(1299);
    const before = view.getNewEntities();
    expect(() => addHostedElementInStore(store, editor, 1222, { kind: 'door', params: { Offset: 8, Width: 1, Height: 2 } })).toThrow(/cannot be read/);
    expect(view.getNewEntities()).toEqual(before);
    editor.setPositionalAttribute(1314, 3, ['#1313']);
    let item = 1313;
    for (let level = 0; level < 15; level++) {
      const rep = editor.addEntity('IfcShapeRepresentation', ['#15', 'Body', 'MappedRepresentation', [`#${item}`, `#${item}`]]);
      const map = editor.addEntity('IfcRepresentationMap', ['#1318', `#${rep.expressId}`]);
      item = editor.addEntity('IfcMappedItem', [`#${map.expressId}`, '#1324']).expressId;
    }
    editor.setPositionalAttribute(1326, 3, [`#${item}`]);
    expect(placedBodyExtent(store, 1299, view)).toBeNull();
    expect(readHostOpeningExtents(store, 1222, view).unreadable).toContain(1299);
  });
});
