/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, test, vi } from 'vitest';
import { readRhino3dm, RhinoReadError, writeRhino3dm } from '../index.js';
import { loadRhino } from '../runtime.js';
import { craft, entityBounds } from '../../test-support/craft.js';
import { MAX_3DM_BYTES } from './read.js';

const quad = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]];
const code = (promise: Promise<unknown>) => promise.then(() => 'resolved', error => error instanceof RhinoReadError ? error.code : error);

describe('geometry', () => {
  test('a double vertex at survey scale comes back as origin + position to a micrometre', async () => {
    const far = [2_600_000.123, 1_200_000.456, 400.789];
    const result = await readRhino3dm(await craft(c => {
      c.addMesh(c.mesh([far, [far[0] + 1.5, far[1], far[2]], [far[0], far[1] + 2.25, far[2]]], [[0, 1, 2]]));
    }));
    const [mesh] = result.meshes;
    for (let k = 0; k < 3; k++) expect(mesh.origin[k] + mesh.positions[k]).toBeCloseTo(far[k], 6);
    expect(mesh.origin[0] + mesh.positions[3]).toBeCloseTo(far[0] + 1.5, 6);
    expect(mesh.origin[1] + mesh.positions[7]).toBeCloseTo(far[1] + 2.25, 6);
    // The f32 offsets stay small, which is what keeps them exact.
    expect(Math.max(...mesh.positions)).toBeLessThan(3);
  });

  test('a quad splits into two triangles with filled normals and indices in range', async () => {
    const { meshes: [mesh] } = await readRhino3dm(await craft(c => { c.addMesh(c.mesh(quad, [[0, 1, 2, 3]])); }));
    expect(Array.from(mesh.indices)).toEqual([0, 1, 2, 2, 3, 0]);
    expect(Array.from(mesh.normals)).toEqual([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
    expect(mesh.positions).toHaveLength(12);
  });

  test('positions are scaled to metres from the file unit', async () => {
    const result = await readRhino3dm(await craft(c => { c.units('Millimeters'); c.addMesh(c.box([1000, 2000, 3000], [4000, 6000, 8000])); }));
    expect(result.document).toMatchObject({ unitSystem: 'Millimeters', metersPerUnit: 0.001 });
    const { min, max } = entityBounds(result, 0);
    min.forEach((v, k) => expect(v).toBeCloseTo([1, 2, 3][k], 6));
    max.forEach((v, k) => expect(v).toBeCloseTo([4, 6, 8][k], 6));
  });

  test.each(['None', 'CustomUnits', 'Unset'] as const)('unit system %s reads as metres with a warning', async unit => {
    const result = await readRhino3dm(await craft(c => { c.units(unit); c.addMesh(c.box([0, 0, 0], [2, 2, 2])); }));
    expect(result.document).toMatchObject({ unitSystem: unit, metersPerUnit: 1 });
    expect(entityBounds(result, 0).max).toEqual([2, 2, 2]);
    expect(result.warnings).toEqual([expect.stringContaining(`unit system is ${unit}`)]);
  });

  test('a Brep draws through its cached face meshes and warns when some faces have none', async () => {
    const result = await readRhino3dm(await craft(c => { c.addBrep(2); c.addBrep(6); }));
    expect(result.entities.map(e => e.geometryType)).toEqual(['Brep', 'Brep']);
    // One quad per meshed face, merged into one mesh per Brep.
    expect(result.meshes.map(m => m.indices.length / 3)).toEqual([4, 12]);
    // The second face's indices start after the first face's four vertices.
    expect(Array.from(result.meshes[0].indices)).toEqual([0, 1, 2, 2, 3, 0, 4, 5, 6, 6, 7, 4]);
    expect(entityBounds(result, 0)).toEqual({ min: [0, 0, 0], max: [1, 2, 1] });
    expect(result.warnings).toEqual(['1 Brep show only the faces that have a render mesh.']);
    expect(result.skipped).toEqual({});
  });

  test('an Extrusion draws through its cached mesh; without one it is counted', async () => {
    const result = await readRhino3dm(await craft(c => { c.addExtrusion(true); c.addExtrusion(false); c.addBrep(0); }));
    expect(result.entities.map(e => e.geometryType)).toEqual(['Extrusion']);
    expect(result.meshes[0].indices).toHaveLength(36);
    expect(result.skipped).toEqual({ 'Extrusion:no-render-mesh': 1, 'Brep:no-render-mesh': 1 });
  });

  test('a file with nothing drawable is refused with the counts and the remedy', async () => {
    const error = await readRhino3dm(await craft(c => { c.addBrep(0); c.addBrep(0); c.addPoint([1, 2, 3]); })).catch(e => e);
    expect(error).toBeInstanceOf(RhinoReadError);
    expect(error.code).toBe('no-renderable-geometry');
    expect(error.message).toContain('2 Brep:no-render-mesh');
    expect(error.message).toContain('1 Point');
    expect(error.message).toContain('Save Small');
  });

  test('curves, point clouds and text dots come back as data; a point is skipped and counted', async () => {
    const far = 2_600_000.25;
    const result = await readRhino3dm(await craft(c => {
      c.units('Centimeters');
      c.addPolyline([[far, 0, 0], [far + 100, 0, 0], [far + 100, 200, 0]], { name: 'line' });
      c.addCurve(c.rhino.NurbsCurve.create(false, 3, [[0, 0, 0], [100, 200, 0], [200, 0, 0], [300, 200, 0]]), { name: 'nurbs' });
      c.addPointCloud([[far, 100, 200], [far + 150, 100, 200]], [[255, 0, 0, 255], [0, 128, 0, 64]], { name: 'cloud' });
      c.addPointCloud([[0, 0, 0], [100, 0, 0]], undefined, { name: 'plain cloud' });
      c.addTextDot('Hello', [400, 500, 600], { name: 'dot', color: [10, 20, 30, 255] });
      c.addPoint([1, 2, 3]);
    }));
    expect(result.entities.map(e => [e.name, e.geometryType])).toEqual([
      ['line', 'PolylineCurve'], ['nurbs', 'NurbsCurve'], ['cloud', 'PointCloud'], ['plain cloud', 'PointCloud'], ['dot', 'TextDot'],
    ]);
    const [line, nurbs] = result.curves;
    expect(line).toMatchObject({ entity: 0, closed: false });
    expect(line.origin[0]).toBeCloseTo(far / 100, 9);
    expect(Array.from(line.positions)).toEqual([0, 0, 0, 1, 0, 0, 1, 2, 0]);
    // A NURBS curve is sampled: 32 segments per span, ending on its end points.
    expect(nurbs.positions).toHaveLength(33 * 3);
    expect(nurbs.origin).toEqual([0, 0, 0]);
    expect(Array.from(nurbs.positions.subarray(96))).toEqual([3, 2, 0]);
    const [cloud, plain] = result.pointClouds;
    expect(cloud.origin[0]).toBeCloseTo(far / 100, 9);
    expect(Array.from(cloud.positions)).toEqual([0, 0, 0, 1.5, 0, 0]);
    expect(Array.from(cloud.colors!)).toEqual([255, 0, 0, 255, 0, 128, 0, 64]);
    expect(plain.colors).toBeNull();
    expect(result.textDots).toEqual([{ entity: 4, position: [4, 5, 6], text: 'Hello', color: [10 / 255, 20 / 255, 30 / 255, 1] }]);
    expect(result.skipped).toEqual({ Point: 1 });
    expect(result.meshes).toEqual([]);
  });

  test('a coordinate that overflows once scaled to metres is counted, never returned as Infinity', async () => {
    const result = await readRhino3dm(await craft(c => {
      c.units('Kilometers');
      c.addTextDot('far', [1e306, 0, 0]); c.addPolyline([[1e306, 0, 0], [1e306, 1, 0]]); c.addMesh(c.box([0, 0, 0], [1, 1, 1]));
    }));
    expect(result.skipped).toEqual({ 'TextDot:invalid': 1, 'PolylineCurve:invalid': 1 });
    expect([result.textDots, result.curves]).toEqual([[], []]);
    expect(result.entities).toHaveLength(1);
  });

  test('an offset f32 cannot hold is counted, never stored as Infinity', async () => {
    // 1e40 is a finite double and an infinite f32.
    const result = await readRhino3dm(await craft(c => {
      c.addPolyline([[0, 0, 0], [1e40, 0, 0]]); c.addPointCloud([[0, 0, 0], [1e40, 0, 0]]); c.addMesh(c.box([0, 0, 0], [1, 1, 1]));
    }));
    expect(result.skipped).toEqual({ 'PolylineCurve:invalid': 1, 'PointCloud:invalid': 1 });
    expect([result.curves, result.pointClouds]).toEqual([[], []]);
  });

  test('the same bytes and options give the same result', async () => {
    const bytes = await craft(c => { c.addMesh(c.box([0, 0, 0], [1, 1, 1])); c.addBrep(3); c.addPolyline(quad); });
    expect(await readRhino3dm(bytes)).toEqual(await readRhino3dm(bytes));
  });

  test('progress starts at zero and ends at the object count', async () => {
    const onProgress = vi.fn();
    await readRhino3dm(await craft(c => { for (let i = 0; i < 5; i++) c.addMesh(c.box([i, 0, 0], [i + 1, 1, 1])); }), { onProgress });
    expect(onProgress.mock.calls).toEqual([[0, 5], [1, 5], [2, 5], [3, 5], [4, 5], [5, 5]]);
  });
});

describe('appearance', () => {
  test('each colour source resolves, and a material\'s transparency shows through an opaque colour', async () => {
    const result = await readRhino3dm(await craft(c => {
      const glass = c.material('Glass', [10, 20, 30, 255], 0.75), steel = c.material('Steel', [200, 100, 50, 255]);
      const red = c.layer('Red', { color: [255, 0, 0, 255] }), glazed = c.layer('Glazed', { color: [0, 0, 255, 255], material: glass });
      const box = () => c.box([0, 0, 0], [1, 1, 1]);
      c.addMesh(box(), { name: 'object', layer: red, color: [0, 255, 0, 128] });
      c.addMesh(box(), { name: 'layer', layer: red, colorSource: 'ColorFromLayer' });
      c.addMesh(box(), { name: 'material', layer: red, colorSource: 'ColorFromMaterial', material: steel, materialSource: 'MaterialFromObject' });
      c.addMesh(box(), { name: 'transparent material', layer: red, colorSource: 'ColorFromMaterial', material: glass, materialSource: 'MaterialFromObject' });
      c.addMesh(box(), { name: 'opaque colour, glass material', layer: red, color: [1, 2, 3, 255], material: glass, materialSource: 'MaterialFromObject' });
      c.addMesh(box(), { name: 'layer material', layer: glazed, colorSource: 'ColorFromLayer' });
      c.addMesh(box(), { name: 'parent at top level', layer: red, colorSource: 'ColorFromParent' });
    }));
    const colors = Object.fromEntries(result.meshes.map(m => [result.entities[m.entity].name, m.color.map(v => Math.round(v * 255))]));
    expect(colors).toEqual({
      'object': [0, 255, 0, 128],
      'layer': [255, 0, 0, 255],
      'material': [200, 100, 50, 255],
      'transparent material': [10, 20, 30, 64],
      'opaque colour, glass material': [1, 2, 3, 64],
      'layer material': [0, 0, 255, 64],
      'parent at top level': [255, 0, 0, 255],
    });
    const material = (name: string) => result.entities.find(e => e.name === name)!.propertySets.find(s => s.name === 'Rhino')!.properties.find(p => p[0] === 'Material')?.[1];
    expect([material('material'), material('layer material'), material('layer')]).toEqual(['Steel', 'Glass', undefined]);
  });
});

describe('layers', () => {
  test('layers come parent first with their paths, colours, user text and spatial stamps', async () => {
    const result = await readRhino3dm(await craft(c => {
      const project = c.layer('Project', { userStrings: [['IFC::GlobalId', '0YvctVUKr0kugbFTf53O9L'], ['IFC::Class', 'IfcProject']] });
      const storey = c.layer('Level 1', { parent: project, color: [1, 2, 3, 255], userStrings: [['IFC::GlobalId', '2O2Fr$t4X7Zf8NOew3FLOH'], ['IFC::Class', 'IfcBuildingStorey'], ['IFC::Elevation', '3.5']] });
      const walls = c.layer('IfcWall', { parent: storey, userStrings: [['note', 'plain']] });
      c.layer('Not spatial', { userStrings: [['IFC::GlobalId', '1hqIFTRjfV6AWq_bMtnZwI'], ['IFC::Class', 'IfcWall']] });
      c.layer('Bad id', { userStrings: [['IFC::GlobalId', 'nope'], ['IFC::Class', 'IfcSite']] });
      c.layer('No elevation', { userStrings: [['ifc::globalid', '3cUkl32yn9qRSPvBJVyWYp'], ['IFC::Class', 'ifcsite'], ['IFC::Elevation', 'high']] });
      c.addMesh(c.box([0, 0, 0], [1, 1, 1]), { layer: walls });
    }));
    expect(result.layers.map(l => [l.fullPath, l.parent])).toEqual([
      ['Project', null], ['Project::Level 1', 0], ['Project::Level 1::IfcWall', 1], ['Not spatial', null], ['Bad id', null], ['No elevation', null],
    ]);
    expect(result.layers[1]).toMatchObject({ name: 'Level 1', color: [1, 2, 3, 255], visible: true });
    expect(result.layers.map(l => l.spatial)).toEqual([
      { globalId: '0YvctVUKr0kugbFTf53O9L', ifcClass: 'IfcProject', elevation: null },
      { globalId: '2O2Fr$t4X7Zf8NOew3FLOH', ifcClass: 'IfcBuildingStorey', elevation: 3.5 },
      null, null, null,
      { globalId: '3cUkl32yn9qRSPvBJVyWYp', ifcClass: 'IfcSite', elevation: null },
    ]);
    expect(result.layers[2].userStrings).toEqual([['note', 'plain']]);
    expect(result.entities[0].layer).toBe(2);
    expect(Object.keys(result.layers[0]).sort()).toEqual(['color', 'fullPath', 'name', 'parent', 'spatial', 'userStrings', 'visible']);
  });

  test('an entity is hidden by its own flag or by any layer on its path', async () => {
    const result = await readRhino3dm(await craft(c => {
      const off = c.layer('Off', { visible: false }), child = c.layer('Child', { parent: off }), on = c.layer('On');
      const box = () => c.box([0, 0, 0], [1, 1, 1]);
      c.addMesh(box(), { name: 'visible', layer: on });
      c.addMesh(box(), { name: 'hidden object', layer: on, hidden: true });
      c.addMesh(box(), { name: 'on an off layer', layer: off });
      c.addMesh(box(), { name: 'under an off layer', layer: child });
    }));
    expect(result.entities.map(e => [e.name, e.hidden])).toEqual([
      ['visible', false], ['hidden object', true], ['on an off layer', true], ['under an off layer', true],
    ]);
    // The child layer keeps its own flag; only the entity folds the ancestors in.
    expect(result.layers.map(l => l.visible)).toEqual([false, true, true]);
  });

  test('an object whose layer index is outside the table lands on the first layer', async () => {
    const result = await readRhino3dm(await craft(c => { c.layer('Only'); c.addMesh(c.box([0, 0, 0], [1, 1, 1]), { layer: 7 }); }));
    expect(result.entities[0].layer).toBe(0);
    expect(result.layers).toHaveLength(1);
  });
});

describe('document', () => {
  test('reports strings, provenance, archive version and a real earth anchor', async () => {
    const { manifest, scene } = sceneWithAnchor();
    const result = await readRhino3dm((await writeRhino3dm(scene, { version: 7 })).bytes);
    expect(result.document).toEqual({
      archiveVersion: 70, application: '', unitSystem: 'Millimeters', metersPerUnit: 0.001,
      provenance: 'ifc-lite', frame: 'file',
      earthAnchor: { latitude: 47.3769, longitude: 8.5417, elevation: 408, modelBasePoint: [1, 2, 3] },
      strings: manifest.documentStrings,
    });
  });

  test('the anchor base point moves with the frame, like every other coordinate', async () => {
    const { manifest } = sceneWithAnchor();
    manifest.documentStrings.push(['IFC::Coordinates', 'local'], ['IFC::WorldFromModel', '1 0 0 2600000 0 1 0 1200000 0 0 1 400 0 0 0 1']);
    const result = await readRhino3dm((await writeRhino3dm({ manifest: JSON.stringify(manifest), blob: sceneWithAnchor().scene.blob })).bytes);
    expect(result.document.frame).toBe('ifc-world-from-model');
    expect(result.meshes[0].origin).toEqual([2_600_000, 1_200_000, 400]);
    expect(result.document.earthAnchor!.modelBasePoint).toEqual([2_600_001, 1_200_002, 403]);
  });

  test('a crafted file has no anchor and Rhino provenance', async () => {
    const { document } = await readRhino3dm(await craft(c => { c.addMesh(c.box([0, 0, 0], [1, 1, 1])); }));
    expect(document).toMatchObject({ archiveVersion: 80, provenance: 'rhino', frame: 'file', earthAnchor: null, strings: [] });
  });
});

/** A one-triangle scene for the writer, in millimetres, with an anchor whose base point is 1000, 2000, 3000 mm. */
function sceneWithAnchor() {
  const blob = new Uint8Array(96), view = new DataView(blob.buffer);
  [0, 0, 0, 1000, 0, 0, 0, 1000, 0].forEach((x, i) => view.setFloat64(i * 8, x, true));
  [0, 1, 2].forEach((x, i) => view.setUint32(72 + i * 4, x, true));
  const manifest = {
    format: 'ifc-lite.rhino-scene', version: 1,
    settings: { unitSystem: 'Millimeters', metersPerUnit: 0.001, absoluteTolerance: 0.01, angleToleranceDegrees: 1,
      earthAnchor: { latitude: 47.3769, longitude: 8.5417, elevation: 408, modelBasePoint: [1000, 2000, 3000], modelNorth: [0, 1, 0], modelEast: [1, 0, 0], name: 'Site' } },
    warnings: [], documentStrings: [['IFC::Schema', 'IFC4'], ['IFC::Exporter', 'ifc-lite 9.9.9']],
    layers: [{ name: 'Model', parent: null, color: [128, 128, 128, 255], visible: true, locked: false }],
    materials: [{ name: 'Default', diffuse: [1, 2, 3], transparency: 0 }], groups: [],
    meshes: [{ positions: { offset: 0, count: 9 }, normals: null, indices: { offset: 72, count: 3 } }], blocks: [],
    objects: [{ kind: 'mesh', mesh: 0, layer: 0, name: 'Triangle', objectId: '', color: [1, 2, 3, 255], material: 0, groups: [], userStrings: [] }],
  };
  return { manifest, scene: { manifest: JSON.stringify(manifest), blob } };
}

describe('errors', () => {
  test('garbage, empty and truncated input are not-3dm', async () => {
    const real = await craft(c => { c.addMesh(c.box([0, 0, 0], [1, 1, 1])); });
    expect(await code(readRhino3dm(new Uint8Array([1, 2, 3, 4])))).toBe('not-3dm');
    expect(await code(readRhino3dm(new Uint8Array(0)))).toBe('not-3dm');
    expect(await code(readRhino3dm(new TextEncoder().encode('ISO-10303-21;\nHEADER;\nENDSEC;\nEND-ISO-10303-21;\n')))).toBe('not-3dm');
    // The header survives, so only rhino3dm can tell.
    expect(await code(readRhino3dm(real.slice(0, real.length >> 1)))).toBe('not-3dm');
    // @ts-expect-error A caller without types can pass anything.
    expect(await code(readRhino3dm('model.3dm'))).toBe('not-3dm');
  });

  test('a header version above Rhino 8 is newer-archive, before rhino3dm is asked', async () => {
    const forged = await craft(c => { c.addMesh(c.box([0, 0, 0], [1, 1, 1])); });
    forged.set(new TextEncoder().encode('      90'), 24);
    const fromByteArray = vi.spyOn((await loadRhino()).File3dm, 'fromByteArray');
    try {
      const error = await readRhino3dm(forged).catch(e => e);
      expect(error.code).toBe('newer-archive');
      expect(error.message).toContain('Rhino 8 or older');
      expect(fromByteArray).not.toHaveBeenCalled();
    } finally { fromByteArray.mockRestore(); }
  });

  test('an input above the size cap is too-large, before rhino3dm is asked', async () => {
    const huge = new Uint8Array(MAX_3DM_BYTES + 1);
    huge.set(new TextEncoder().encode('3D Geometry File Format       80'));
    const fromByteArray = vi.spyOn((await loadRhino()).File3dm, 'fromByteArray');
    try {
      const error = await readRhino3dm(huge).catch(e => e);
      expect(error.code).toBe('too-large');
      expect(error.message).toContain(`${Math.round(huge.length / 1024 / 1024)} MB`);
      expect(fromByteArray).not.toHaveBeenCalled();
    } finally { fromByteArray.mockRestore(); }
  });

  /** A valid header and end-of-file mark around zeros: rhino3dm answers null for it, as it does at the heap limit. */
  const hollow = (megabytes: number) => {
    const bytes = new Uint8Array(megabytes * 1024 * 1024), view = new DataView(bytes.buffer), size = bytes.length;
    bytes.set(new TextEncoder().encode('3D Geometry File Format       80'));
    view.setUint32(size - 20, 0x7fff, true); view.setBigUint64(size - 16, 8n, true); view.setBigUint64(size - 8, BigInt(size), true);
    return bytes;
  };
  const trap = () => { throw new WebAssembly.RuntimeError('Aborted(). Build with -sASSERTIONS for more info.'); };

  test('a wasm trap is too-large on a large file and damage on a small one; either way the next read gets a fresh runtime', async () => {
    const small = await craft(c => { c.addMesh(c.box([0, 0, 0], [1, 1, 1])); });
    for (const [bytes, expected] of [[hollow(33), 'too-large'], [small, 'not-3dm']] as const) {
      const trapped = await loadRhino();
      const fromByteArray = vi.spyOn(trapped.File3dm, 'fromByteArray').mockImplementation(trap);
      try { expect(await code(readRhino3dm(bytes))).toBe(expected); } finally { fromByteArray.mockRestore(); }
      // A trapped module cannot be used again.
      expect(await loadRhino()).not.toBe(trapped);
    }
    expect((await readRhino3dm(small)).meshes).toHaveLength(1);
  });

  test('a null read of a large archive that ends in its own length is too-large, not damage', async () => {
    const before = await loadRhino();
    const error = await readRhino3dm(hollow(33)).catch(e => e);
    expect(error.code).toBe('too-large');
    expect(error.message).toContain('This file (33 MB) could not be read: it most likely needs more memory than the reader has');
    // The exhausted heap never shrinks, so the runtime is replaced.
    expect(await loadRhino()).not.toBe(before);
    // Cut short, or too small to exhaust anything: that is damage.
    expect(await code(readRhino3dm(hollow(33).subarray(0, -1)))).toBe('not-3dm');
    expect(await code(readRhino3dm(hollow(1)))).toBe('not-3dm');
  });

  test('other failures pass through unchanged', async () => {
    const bytes = await craft(c => { c.addMesh(c.box([0, 0, 0], [1, 1, 1])); });
    await expect(readRhino3dm(bytes, { onProgress: () => { throw new Error('cancelled'); } })).rejects.toThrow('cancelled');
    expect((await readRhino3dm(bytes)).meshes).toHaveLength(1);
  });

  test('what the caller\'s onProgress throws is never taken for a wasm failure', async () => {
    const bytes = await craft(c => { c.addMesh(c.box([0, 0, 0], [1, 1, 1])); });
    const runtime = await loadRhino();
    // A bare number is how a C++ exception escapes embind, and a RangeError is how an allocation fails.
    for (const thrown of [7, new RangeError('mine')]) {
      await expect(readRhino3dm(bytes, { onProgress: () => { throw thrown; } })).rejects.toBe(thrown);
    }
    expect(await loadRhino()).toBe(runtime);
  });

  test('invalid options are rejected', async () => {
    const bytes = await craft(c => { c.addMesh(c.box([0, 0, 0], [1, 1, 1])); });
    // @ts-expect-error Deliberately outside the option type.
    await expect(readRhino3dm(bytes, { subdLevel: 4 })).rejects.toThrow(RangeError);
    await expect(readRhino3dm(bytes, { maxTriangles: Number.NaN })).rejects.toThrow(RangeError);
  });
});
