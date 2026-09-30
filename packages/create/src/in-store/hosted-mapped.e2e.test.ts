/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/** #6232 / #6539: the same authored mapped graph must have the reader bounds
 * and real canonical WASM vertices at independently calculated coordinates. */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { StepExporter } from '@ifc-lite/export';
import { IfcAPI, initSync } from '@ifc-lite/wasm';
import { placedBodyExtent, resolveHostAnchor } from './resolve-host.js';
import { addHostedElementInStore, readHostOpeningExtents } from './hosted-element.js';
import type { HostBounds } from './anchor.js';

const WASM = fileURLToPath(new URL('../../../wasm/pkg/ifc-lite_bg.wasm', import.meta.url));
const OPENING = 1299;
const WALL = 1222;
// Authored #1305/#1308/#1313 bounds before mapping: [0,w] × [-r,d-r] × [0,h].
const x = 1.76767492294312, w = 0.899999976158142;
const r = 0.600000023841858, d = 1.2, h = 1.20000004768372;
const parse = (bytes: Uint8Array) => new IfcParser().parseColumnar(
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  { disableWorkerScan: true },
);
async function session() {
  const source = readFileSync(new URL('../../../../apps/viewer/public/samples/hello-wall.ifc', import.meta.url));
  const store = await parse(source);
  const view = new MutablePropertyView(null, 'm');
  return { store, view, editor: new StoreEditor(store, view) };
}
type Session = Awaited<ReturnType<typeof session>>;

/** Export and reparse so TS and WASM consume exactly the same effective bytes. */
async function committed(s: Session) {
  const bytes = new StepExporter(s.store, s.view).export({ schema: 'IFC4', applyMutations: true }).content;
  return { bytes, store: await parse(bytes) };
}

/** Explicit source job includes the opening itself, normally hidden by prepass.
 * Source host/storey placements are identity in this Bonsai file, so world IFC
 * bounds and the host-parent bounds coincide. No second mapped-matrix reader. */
function meshBounds(bytes: Uint8Array, store: IfcDataStore, id: number): HostBounds {
  const api = new IfcAPI();
  try {
    const ref = store.entityIndex.byId.get(id);
    if (!ref) throw new Error(`Expected exported entity #${id}`);
    const pre = api.buildPrePassOnce(bytes);
    const collection = api.processGeometryBatch(bytes,
      new Uint32Array([id, ref.byteOffset, ref.byteOffset + ref.byteLength]), pre.unitScale, 0, 0, 0, false,
      pre.voidKeys, pre.voidCounts, pre.voidValues, pre.styleIds, pre.styleColors);
    const bounds: HostBounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
    let vertices = 0;
    try {
      for (let i = 0; i < collection.length; i++) {
        const mesh = collection.takeMesh(i);
        if (!mesh) continue;
        try {
          expect(mesh.expressId).toBe(id);
          const p = mesh.positions, origin = mesh.origin;
          for (let j = 0; j < p.length; j += 3) {
            // Canonical mesh is Y-up: IFC(x,y,z) = (meshX,-meshZ,meshY).
            const v = [origin[0] + p[j], -(origin[2] + p[j + 2]), origin[1] + p[j + 1]];
            for (let k = 0; k < 3; k++) {
              bounds.min[k] = Math.min(bounds.min[k], v[k]);
              bounds.max[k] = Math.max(bounds.max[k], v[k]);
            }
            vertices++;
          }
        } finally { mesh.free(); }
      }
    } finally { collection.free(); }
    expect(vertices).toBeGreaterThan(0);
    return bounds;
  } finally {
    try { api.clearPrePassCache(); } finally { api.free(); }
  }
}
function expectBounds(actual: HostBounds | null, expected: HostBounds, digits: number) {
  expect(actual).not.toBeNull();
  for (const side of ['min', 'max'] as const) for (let k = 0; k < 3; k++) {
    expect(actual![side][k]).toBeCloseTo(expected[side][k], digits);
  }
}
function translated(s: Session) { s.editor.setPositionalAttribute(1315, 0, [2, 0, 0]); }
function rotatedScaled(s: Session) {
  s.editor.setPositionalAttribute(1315, 0, [2, 0.3, 0.5]);
  s.editor.setPositionalAttribute(1316, 0, [0, 1, 0]);
  s.editor.setPositionalAttribute(1320, 0, [1, 2, 3]);
  s.editor.setPositionalAttribute(1321, 0, [0, 1, 0]);
  s.editor.setPositionalAttribute(1322, 0, [-1, 0, 0]);
  const target = s.editor.addEntity('IfcCartesianTransformationOperator3DnonUniform', ['#1321', '#1322', '#1320', 2, '#1323', 3, 4]);
  s.editor.setPositionalAttribute(1325, 1, `#${target.expressId}`);
}
function nested(s: Session) {
  translated(s);
  const e = s.editor;
  const point = e.addEntity('IfcCartesianPoint', [[1, -0.5, 0.25]]).expressId;
  const direction = e.addEntity('IfcDirection', [[0, 1, 0]]).expressId;
  const origin = e.addEntity('IfcAxis2Placement3D', [`#${point}`, '#1323', `#${direction}`]).expressId;
  const map = e.addEntity('IfcRepresentationMap', [`#${origin}`, '#1326']).expressId;
  const location = e.addEntity('IfcCartesianPoint', [[4, 5, 6]]).expressId;
  const axis = e.addEntity('IfcDirection', [[0, -1, 0]]).expressId;
  const target = e.addEntity('IfcCartesianTransformationOperator3DnonUniform', [`#${axis}`, '#1321', `#${location}`, 1.5, '#1323', 0.5, 2]).expressId;
  const mapped = e.addEntity('IfcMappedItem', [`#${map}`, `#${target}`]).expressId;
  const rep = e.addEntity('IfcShapeRepresentation', ['#15', 'Body', 'MappedRepresentation', [`#${mapped}`]]).expressId;
  e.setPositionalAttribute(1327, 2, [`#${rep}`]);
}

const cases: Array<{ name: string; author: (s: Session) => void; expected: HostBounds }> = [
  { name: 'unchanged Bonsai source', author: () => {}, expected: { min: [x, -r, 1], max: [x + w, d-r, 1+h] } },
  { name: 'translated MappingOrigin', author: translated, expected: { min: [x+2, -r, 1], max: [x+2+w, d-r, 1+h] } },
  // O(p)=(2-y,.3+x,.5+z); T(O)=(.1-3x,6-2y,5+4z).
  { name: 'rotated origin and target with nonuniform scales', author: rotatedScaled,
    expected: { min: [x+0.1-3*w, 6-2*(d-r), 6], max: [x+0.1, 6+2*r, 6+4*h] } },
  // Inner(p)=(x+2,y,z); outer O=(1-y,x+1.5,z+.25);
  // outer T=(4.75+.5x,3.5+1.5y,6.5+2z), then product adds (x,0,1).
  { name: 'nested nonzero rotated origin and nonuniform target', author: nested,
    expected: { min: [x+4.75, 3.5-1.5*r, 7.5], max: [x+4.75+0.5*w, 3.5+1.5*(d-r), 7.5+2*h] } },
];

describe.skipIf(!existsSync(WASM))('#6539 real WASM mapped-origin coordinates (run pnpm build:wasm:fetch if absent)', () => {
  beforeAll(() => initSync({ module: readFileSync(WASM) }));
  for (const c of cases) it(c.name, async () => {
    const s = await session(); c.author(s);
    const exported = await committed(s);
    // Independent authored coordinates pin WASM FIRST; a TS/WASM mismatch is
    // then a reader defect, rather than two readers agreeing on an assumption.
    expectBounds(meshBounds(exported.bytes, exported.store, OPENING), c.expected, 5);
    expectBounds(placedBodyExtent(exported.store, OPENING), c.expected, 10);
    expectBounds(placedBodyExtent(s.store, OPENING, s.view), c.expected, 10);
    expectBounds(readHostOpeningExtents(s.store, WALL, s.view).cuts.find(cut => cut.openingId === OPENING)?.bounds ?? null, c.expected, 10);
  });

  it('uses corrected cut occupancy for overlap, allows a separated fit and refuses outside fit atomically', async () => {
    const s = await session(); translated(s);
    const before = s.view.getMutations(), created = s.view.getNewEntities();
    expect(() => addHostedElementInStore(s.store, s.editor, WALL, { kind: 'opening', params: { Offset: 4.2, Width: 0.2, Sill: 1.2, Height: 0.2 } })).toThrow(/overlaps opening #1299/);
    expect(s.view.getMutations()).toEqual(before); expect(s.view.getNewEntities()).toEqual(created);
    const placed = addHostedElementInStore(s.store, s.editor, WALL, { kind: 'opening', params: { Offset: 1, Width: 0.5, Height: 2 } });
    expect(placed.openingId).toBeGreaterThan(OPENING);
    const prior = s.view.getMutations(), entities = s.view.getNewEntities();
    expect(() => addHostedElementInStore(s.store, s.editor, WALL, { kind: 'opening', params: { Offset: 9.9, Width: 1, Height: 2 } })).toThrow(/doesn't fit/);
    expect(s.view.getMutations()).toEqual(prior); expect(s.view.getNewEntities()).toEqual(entities);
  });

  it('uses a nonzero mapped host origin for independently meshed fit limits', async () => {
    const s = await session(), e = s.editor;
    const p = e.addEntity('IfcCartesianPoint', [[2, 0, 0]]).expressId;
    const origin = e.addEntity('IfcAxis2Placement3D', [`#${p}`, '#1323', '#1321']).expressId;
    const map = e.addEntity('IfcRepresentationMap', [`#${origin}`, '#1261']).expressId;
    const mapped = e.addEntity('IfcMappedItem', [`#${map}`, '#1324']).expressId;
    const rep = e.addEntity('IfcShapeRepresentation', ['#15', 'Body', 'MappedRepresentation', [`#${mapped}`]]).expressId;
    e.setPositionalAttribute(1230, 2, [`#${rep}`]);
    const expected: HostBounds = { min: [2, 0, 0], max: [12, 0.1, 3] };
    const exported = await committed(s);
    expectBounds(meshBounds(exported.bytes, exported.store, WALL), expected, 5);
    expectBounds(resolveHostAnchor(s.store, WALL, s.view).hostBounds, expected, 8);
    const prior = s.view.getMutations(), entities = s.view.getNewEntities();
    expect(() => addHostedElementInStore(s.store, e, WALL, { kind: 'opening', params: { Offset: 1, Width: 0.2, Height: 0.5 } })).toThrow(/doesn't fit/);
    expect(s.view.getMutations()).toEqual(prior); expect(s.view.getNewEntities()).toEqual(entities);
    expect(addHostedElementInStore(s.store, e, WALL, { kind: 'opening', params: { Offset: 10.5, Width: 0.5, Height: 2 } }).openingId).toBeGreaterThan(OPENING);
  });
});
