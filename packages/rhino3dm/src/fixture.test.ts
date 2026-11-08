/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { expect, test, vi } from 'vitest';
import { writeRhino3dm, parseRhinoScene, RhinoSceneError } from './index.js';
import type { RhinoSceneManifest, EncodedRhinoScene } from './index.js';
import { dispose, loadRhino } from './runtime.js';

// Small encoder independent of the Rust producer. Counts are scalar elements.
function fixture(): { manifest: RhinoSceneManifest; scene: EncodedRhinoScene } {
  const blob = new Uint8Array(128), d = new DataView(blob.buffer);
  [2600000.123, 0, 0, 2600001.123, 0, 0, 2600000.123, 1, 0].forEach((x, i) => d.setFloat64(i * 8, x, true));
  [0, 0, 1, 0, 0, 1, 0, 0, 1].forEach((x, i) => d.setFloat32(72 + i * 4, x, true));
  [0, 1, 2].forEach((x, i) => d.setUint32(112 + i * 4, x, true));
  const manifest: RhinoSceneManifest = {
    format: 'ifc-lite.rhino-scene', version: 1,
    settings: { unitSystem: 'Meters', metersPerUnit: 1, absoluteTolerance: 0.001, angleToleranceDegrees: 1,
      earthAnchor: { latitude: 47.3769, longitude: 8.5417, elevation: 408, modelBasePoint: [1, 2, 3], modelNorth: [0, 1, 0], modelEast: [1, 0, 0], name: 'Site' } },
    warnings: [], documentStrings: [['IFC::Schema', 'IFC4']],
    layers: ['Project', 'Site', 'Building', 'Level 1', 'IfcWall'].map((name, i) => ({ name, parent: i === 0 ? null : i - 1, color: [128, 128, 128, 255], visible: true, locked: false })),
    materials: [{ name: 'Concrete', diffuse: [12, 34, 56], transparency: 0.25 }], groups: [{ name: 'element' }],
    meshes: [{ positions: { offset: 0, count: 9 }, normals: { offset: 72, count: 9 }, indices: { offset: 112, count: 3 } }],
    blocks: [{ name: 'Block', description: 'Repeated geometry', meshes: [0], layer: 0 }],
    objects: [{ kind: 'mesh', mesh: 0, layer: 4, name: 'Wall', objectId: 'ignored', color: [12, 34, 56, 191], material: 0, groups: [0], userStrings: [['IFC::GlobalId', 'wall-id']] },
      { kind: 'instance', block: 0, xform: [2, 0.5, 0, 10, 0, 3, 0.25, 20, 0, 0, 4, 30, 0, 0, 0, 1], layer: 4, name: 'Occurrence', objectId: 'ignored-too', color: [56, 34, 12, 255], material: 0, groups: [0], userStrings: [['IFC::GlobalId', 'instance-id']] }],
  };
  return { manifest, scene: { manifest: JSON.stringify(manifest), blob } };
}
function encoded(m: RhinoSceneManifest, blob = fixture().scene.blob) { return { manifest: JSON.stringify(m), blob }; }

test.each([7, 8] as const)('round-trips archive %i and the v1 manifest semantics', async version => {
  const { manifest: m, scene } = fixture();
  // A separate root layer exercises visibility and locking without hiding the wall.
  m.layers.push({ name: 'Hidden', parent: null, color: [1, 2, 3, 255], visible: false, locked: true });
  const progress: number[][] = [];
  const { bytes, warnings, objectCount } = await writeRhino3dm(encoded(m, scene.blob), { version, onProgress: (d, t) => progress.push([d, t]) });
  expect(warnings).toEqual(m.warnings);
  expect(objectCount).toBe(m.objects.length);
  const r = await loadRhino(), file = r.File3dm.fromByteArray(bytes);
  expect(file).toBeTruthy();
  try {
    expect(file.archiveVersion).toBe(version * 10);
    expect(file.layers().get(4).fullPath).toBe('Project::Site::Building::Level 1::IfcWall');
    expect(file.layers().get(5).visible).toBe(false); expect(file.layers().get(5).locked).toBe(true);
    expect(file.strings().get(0)).toEqual(['IFC::Schema', 'IFC4']);
    const material = file.materials().get(0);
    expect(material.name).toBe('Concrete'); expect(material.diffuseColor).toMatchObject({ r: 12, g: 34, b: 56 });
    expect(material.transparency).toBeCloseTo(0.25);
    expect(file.groups().count).toBe(1); expect(file.groups().get(0).name).toBe('element');
    // A definition adds one hidden definition object, alongside the mesh and instance.
    expect(file.objects().count).toBe(3); expect(file.instanceDefinitions().count).toBe(1);
    let instances = 0, walls = 0;
    for (let i = 0; i < file.objects().count; i++) {
      const obj = file.objects().get(i), a = obj.attributes(), g = obj.geometry();
      if (a.name === 'Wall') {
        walls++;
        expect(a.getUserString('IFC::GlobalId')).toBe('wall-id'); expect(a.getGroupList()).toEqual([0]);
        expect(a.layerIndex).toBe(4); expect(a.materialIndex).toBe(0);
        expect(a.colorSource).toBe(r.ObjectColorSource.ColorFromObject);
        expect(a.materialSource).toBe(r.ObjectMaterialSource.MaterialFromObject);
        expect(a.objectColor).toMatchObject({ r: 12, g: 34, b: 56, a: 191 });
        const mesh = g as InstanceType<typeof r.Mesh>;
        expect(mesh.vertices().point3dAt(0)[0]).toBeCloseTo(2600000.123, 6);
        expect(mesh.normals().count).toBe(3); expect(mesh.faces().count).toBe(1);
        const bounds = mesh.getBoundingBox(true);
        try {
          expect(bounds.min[0]).toBeCloseTo(2600000.123, 6);
          expect(bounds.max[0]).toBeCloseTo(2600001.123, 6);
          expect(bounds.min.slice(1)).toEqual([0, 0]); expect(bounds.max.slice(1)).toEqual([1, 0]);
        } finally { dispose(bounds); }
      } else if (a.name === 'Occurrence') {
        instances++;
        const xform = (g as InstanceType<typeof r.InstanceReference>).xform;
        try { expect(xform.toFloatArray(true)).toEqual(m.objects[1].kind === 'instance' ? m.objects[1].xform : []); }
        finally { dispose(xform); }
      } else {
        expect(a.colorSource).toBe(r.ObjectColorSource.ColorFromParent);
        expect(a.materialSource).toBe(r.ObjectMaterialSource.MaterialFromParent); expect(a.layerIndex).toBe(0);
      }
    }
    expect([walls, instances]).toEqual([1, 1]);
    const s = file.settings(); expect(s.modelUnitSystem).toBe(r.UnitSystem.Meters);
    expect(s.modelAbsoluteTolerance).toBeCloseTo(0.001); expect(s.modelAngleToleranceDegrees).toBeCloseTo(1);
    const e = s.earthAnchorPoint;
    try {
      expect(e.earthBasepointLatitude).toBeCloseTo(47.3769); expect(e.earthBasepointLongitude).toBeCloseTo(8.5417);
      expect(e.earthBasepointElevation).toBe(408); expect(e.modelBasePoint).toEqual([1, 2, 3]);
      expect(e.modelNorth).toEqual([0, 1, 0]); expect(e.modelEast).toEqual([1, 0, 0]); expect(e.name).toBe('Site');
    } finally { dispose(e); }
    expect(progress).toEqual([[0, 2], [1, 2], [2, 2]]);
  } finally { dispose(file); }
});

const invalidCases: [string, (m: RhinoSceneManifest) => void, RegExp][] = [
  // Review finding 2: malformed unit values must produce a typed scene error.
  ['unit without toString', m => Object.assign(m.settings, { unitSystem: { toString: null } }), /unitSystem/],
  ['bad format', (m: RhinoSceneManifest) => Object.assign(m, { format: 'other' }), /format/],
  ['v2', (m: RhinoSceneManifest) => Object.assign(m, { version: 2 }), /version/],
  ['f64 alignment', (m: RhinoSceneManifest) => m.meshes[0].positions.offset = 4, /misaligned/],
  ['f32 alignment', (m: RhinoSceneManifest) => m.meshes[0].normals!.offset = 73, /misaligned/],
  ['u32 alignment', (m: RhinoSceneManifest) => m.meshes[0].indices.offset = 113, /misaligned/],
  ['buffer bounds', (m: RhinoSceneManifest) => m.meshes[0].positions.count = 999, /out of range/],
  ['mesh index', (m: RhinoSceneManifest) => m.blocks[0].meshes[0] = 7, /out of range/],
  ['parent ordering', (m: RhinoSceneManifest) => m.layers[0].parent = 1, /precede child/],
  ['nonfinite transform', (m: RhinoSceneManifest) => { if (m.objects[1].kind === 'instance') m.objects[1].xform[0] = Infinity; }, /xform/],
];
test.each(invalidCases)('rejects %s with a typed error', (_name, mutate, message) => {
  const { manifest } = fixture(); mutate(manifest);
  expect(() => parseRhinoScene(encoded(manifest))).toThrow(RhinoSceneError);
  expect(() => parseRhinoScene(encoded(manifest))).toThrow(message);
});

test('rejects bad triangle indices, JSON, and archive 9', async () => {
  const { scene } = fixture(); new DataView(scene.blob.buffer).setUint32(112, 3, true);
  expect(() => parseRhinoScene(scene)).toThrow(/triangle vertex/);
  expect(() => parseRhinoScene({ ...scene, manifest: '{' })).toThrow(RhinoSceneError);
  // @ts-expect-error Deliberately test runtime validation of an untyped caller.
  await expect(writeRhino3dm(fixture().scene, { version: 9 })).rejects.toThrow(/7 or 8/);
});

test('supports a blob view with an unaligned backing-store offset', async () => {
  const { scene } = fixture(), storage = new Uint8Array(scene.blob.length + 1);
  storage.set(scene.blob, 1);
  const r = await loadRhino(), f = r.File3dm.fromByteArray((await writeRhino3dm({ ...scene, blob: storage.subarray(1) })).bytes);
  try { expect(f.objects().count).toBe(3); } finally { dispose(f); }
});

test('cleans up after progress throws and permits subsequent writes', async () => {
  await expect(writeRhino3dm(fixture().scene, { onProgress: () => { throw new Error('cancel'); } })).rejects.toThrow('cancel');
  const r = await loadRhino();
  for (let i = 0; i < 3; i++) {
    const f = r.File3dm.fromByteArray((await writeRhino3dm(fixture().scene)).bytes);
    try { expect(f.objects().count).toBe(3); } finally { dispose(f); }
  }
});

test('WASM heap growth check', async context => {
  const rhino = await loadRhino();
  // 8.35.0 keeps HEAP views and wasmMemory in closure scope; no heap-size API is exported.
  const heap = (rhino as unknown as { HEAPU8?: Uint8Array }).HEAPU8;
  if (!heap) { context.skip(); return; }
  const before = heap.byteLength;
  for (let i = 0; i < 3; i++) await writeRhino3dm(fixture().scene);
  expect((rhino as unknown as { HEAPU8: Uint8Array }).HEAPU8.byteLength - before).toBeLessThanOrEqual(65536);
});

test('writes absent normals and earth anchor with the default archive version', async () => {
  const { manifest } = fixture(); manifest.meshes[0].normals = null; manifest.settings.earthAnchor = null;
  const r = await loadRhino(), f = r.File3dm.fromByteArray((await writeRhino3dm(encoded(manifest))).bytes);
  try {
    expect(f.archiveVersion).toBe(80);
    const obj = Array.from({ length: f.objects().count }, (_, i) => f.objects().get(i)).find(o => o.attributes().name === 'Wall')!;
    expect((obj.geometry() as InstanceType<typeof r.Mesh>).normals().count).toBe(0);
    const anchor = f.settings().earthAnchorPoint;
    try { expect(anchor.earthLocationIsSet()).toBe(false); } finally { dispose(anchor); }
  } finally { dispose(f); }
});

// table insertion failures must fail closed with item context.
test.each([
  ['File3dmLayerTable', 'Project', -1],
  ['File3dmMaterialTable', 'Concrete', undefined],
  ['File3dmGroupTable', 'element', undefined],
  ['File3dmInstanceDefinitionTable', 'Block', -1],
] as const)('reports failed %s insertion without masking the error', async (table, name, result) => {
  const r = await loadRhino();
  const prototype = (r as unknown as Record<string, { prototype: { add: (...args: unknown[]) => unknown } }>)[table].prototype;
  const add = vi.spyOn(prototype, 'add').mockReturnValue(result);
  try {
    await expect(writeRhino3dm(fixture().scene)).rejects.toThrow(new RhinoSceneError(`Failed to add ${table === 'File3dmLayerTable' ? 'layer' : table === 'File3dmMaterialTable' ? 'material' : table === 'File3dmGroupTable' ? 'group' : 'block'} "${name}"`));
  } finally { add.mockRestore(); }
});
test('disposing a missing borrowed handle is harmless', () => {
  expect(() => { dispose(null); dispose(undefined); }).not.toThrow();
});

// rhino3dm 8.35.0 / openNURBS writes Unset into the newer coordinate-system
// field, overriding the correct legacy MeanSeaLevel value on read:
// https://github.com/mcneel/opennurbs/blob/8.x/opennurbs_3dm_settings.cpp#L4088-L4091
// Keep this expected failure until the pinned upstream preserves the value.
test.fails.each([7, 8] as const)('preserves mean sea level elevation zero in archive %i', async version => {
  const r = await loadRhino();
  const f = r.File3dm.fromByteArray((await writeRhino3dm(fixture().scene, { version })).bytes);
  const settings = f.settings(), anchor = settings.earthAnchorPoint;
  try { expect(anchor.earthBasepointElevationZero).toBe(r.BasepointZero.MeanSeaLevel); }
  finally { dispose(anchor); dispose(settings); dispose(f); }
});

test.each(['addMesh', 'addInstanceObject'] as const)('reports failed object insertion via %s', async method => {
  const r = await loadRhino();
  const add = vi.spyOn(r.File3dmObjectTable.prototype, method).mockReturnValue('00000000-0000-0000-0000-000000000000');
  try { await expect(writeRhino3dm(fixture().scene)).rejects.toThrow(/Failed to add object/); }
  finally { add.mockRestore(); }
});

// validate untrusted blobs before constructing aligned views.
test.each([null, undefined, {}, [1, 2]])('rejects invalid blob %j with a scene error', async blob => {
  await expect(writeRhino3dm({ ...fixture().scene, blob: blob as unknown as Uint8Array })).rejects.toBeInstanceOf(RhinoSceneError);
});
