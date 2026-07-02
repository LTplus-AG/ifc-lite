/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { buildMergedGLB } from './cesium-glb.js';

function makeMesh(over: Partial<{ positions: number[]; normals: number[]; indices: number[]; color: number[]; origin: number[] }> = {}) {
  return {
    expressId: 1,
    ifcType: 'IfcWall',
    positions: new Float32Array(over.positions ?? [0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array(over.normals ?? [0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array(over.indices ?? [0, 1, 2]),
    color: (over.color ?? [0.5, 0.5, 0.5, 1]) as [number, number, number, number],
    origin: (over.origin ?? [0, 0, 0]) as [number, number, number],
  } as unknown as import('@ifc-lite/geometry').MeshData;
}

/** Parse the GLB container → { json, binLength }. */
function parseGlb(glb: Uint8Array) {
  const dv = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  assert.equal(dv.getUint32(0, true), 0x46546c67, 'GLB magic');
  assert.equal(dv.getUint32(4, true), 2, 'GLB version');
  assert.equal(dv.getUint32(8, true), glb.byteLength, 'GLB total length matches buffer');
  const jsonLen = dv.getUint32(12, true);
  assert.equal(dv.getUint32(16, true), 0x4e4f534a, 'JSON chunk tag');
  const jsonBytes = glb.subarray(20, 20 + jsonLen);
  const json = JSON.parse(new TextDecoder().decode(jsonBytes));
  const binHeaderOff = 20 + jsonLen;
  const binLen = dv.getUint32(binHeaderOff, true);
  assert.equal(dv.getUint32(binHeaderOff + 4, true), 0x004e4942, 'BIN chunk tag');
  return { json, binLen };
}

describe('buildMergedGLB (#1355 Cesium shading)', () => {
  it('emits a NORMAL attribute so Cesium can light the model', () => {
    const { json } = parseGlb(buildMergedGLB([makeMesh()]));
    const attrs = json.meshes[0].primitives[0].attributes;
    assert.ok('NORMAL' in attrs, 'primitive must declare a NORMAL attribute');
    assert.ok('POSITION' in attrs && 'COLOR_0' in attrs);
  });

  it('uses a LIT PBR material (no KHR_materials_unlit)', () => {
    const { json } = parseGlb(buildMergedGLB([makeMesh()]));
    assert.ok(!(json.extensionsUsed ?? []).includes('KHR_materials_unlit'), 'must not be unlit');
    assert.ok(Array.isArray(json.materials) && json.materials.length === 1, 'has a material');
    assert.equal(json.meshes[0].primitives[0].material, 0, 'primitive references the material');
    assert.equal(json.materials[0].doubleSided, true, 'double-sided (IFC winding not reliably outward)');
  });

  it('accessor/bufferView byte math is self-consistent (4 views, sizes sum to BIN)', () => {
    const { json, binLen } = parseGlb(buildMergedGLB([makeMesh(), makeMesh()]));
    assert.equal(json.accessors.length, 4); // POSITION, NORMAL, COLOR_0, indices
    assert.equal(json.bufferViews.length, 4);
    const sum = json.bufferViews.reduce((acc: number, bv: { byteLength: number }) => acc + bv.byteLength, 0);
    assert.equal(json.buffers[0].byteLength, sum, 'buffer length = sum of bufferViews');
    assert.ok(binLen >= sum, 'BIN chunk holds the buffer (plus alignment pad)');
    // 2 triangles, 3 verts each
    assert.equal(json.accessors[0].count, 6); // POSITION vert count
    assert.equal(json.accessors[1].count, 6); // NORMAL vert count
    assert.equal(json.accessors[3].count, 6); // index count
  });

  it('folds per-mesh origin into world-space positions', () => {
    const glb = buildMergedGLB([makeMesh({ origin: [10, 20, 30] })]);
    const { json } = parseGlb(glb);
    // POSITION accessor min should reflect the +[10,20,30] shift of vertex (0,0,0)
    assert.deepEqual(json.accessors[0].min, [10, 20, 30]);
  });
});
