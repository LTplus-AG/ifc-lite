/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Hostile and malformed tile content (PR #10404 review): every count, length
 * and offset a file declares is checked before anything is allocated, and the
 * refusal comes back fast as a typed issue instead of a heap crash or a hang.
 */

import { describe, expect, it } from 'vitest';
import { readTilesetRegion, type ReadTilesetRegionOptions } from '../read.js';
import { buildB3dm, buildGlb, mapFetch, regionRad } from '../../test/support.js';
import { parseB3dm } from './b3dm.js';

const BASE = 'https://tiles.example/set/';
const WORLD = { west: -180, east: 180, south: -90, north: 90 };
const TILE_REGION = regionRad(7.9, 46.9, 8.1, 47.1, -100, 1000);

function tileset(uris: string[]): object {
  return {
    asset: { version: '1.0' }, geometricError: 1,
    root: { boundingVolume: { region: TILE_REGION }, geometricError: 1, refine: 'ADD', children: uris.map((uri) => ({ boundingVolume: { region: TILE_REGION }, geometricError: 0, content: { uri } })) },
  };
}

async function read(contents: Record<string, Uint8Array>, opts: Partial<ReadTilesetRegionOptions> = {}) {
  const fetch = mapFetch({ [`${BASE}tileset.json`]: tileset(Object.keys(contents)), ...Object.fromEntries(Object.entries(contents).map(([k, v]) => [BASE + k, v])) });
  const started = performance.now();
  const res = await readTilesetRegion({ url: `${BASE}tileset.json`, region: WORLD, fetch, featureFilter: 'tiles', ...opts });
  return { res, ms: performance.now() - started };
}

/** One triangle (3 vertices, batch id 0) with optional extra accessors and primitive overrides. */
function triangleGltf(edit: (json: Record<string, any>) => void = () => {}): Uint8Array {
  const pos = new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, -1]);
  const ids = new Float32Array([0, 0, 0]);
  const bin = new Uint8Array([...new Uint8Array(pos.buffer), ...new Uint8Array(ids.buffer)]);
  const json: Record<string, any> = {
    asset: { version: '2.0' }, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, _BATCHID: 1 } }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' },
      { bufferView: 1, componentType: 5126, count: 3, type: 'SCALAR' },
    ],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: 12 }],
    buffers: [{ byteLength: bin.byteLength }],
  };
  edit(json);
  return buildGlb(json, bin);
}

const issueCodes = (res: { issues: Array<{ code?: string; severity: string }> }) => res.issues.filter((i) => i.severity === 'error').map((i) => i.code);

describe('declared counts are bounded before allocation (#10404 review, item 1)', () => {
  it('refuses BATCH_LENGTH 2^32-1 in a 1 KB b3dm at once (it used to run 17 s and kill the process)', async () => {
    const { res, ms } = await read({ 'a.b3dm': buildB3dm({ featureTable: { BATCH_LENGTH: 4294967295 }, glb: triangleGltf() }) });
    expect(issueCodes(res)).toEqual(['limit']);
    expect(res.issues[0].message).toMatch(/BATCH_LENGTH 4294967295 exceeds/);
    expect(ms).toBeLessThan(1000);
  });

  it('refuses a BATCH_LENGTH that is negative or not an integer as invalid content', async () => {
    for (const bl of [-1, 1.5]) {
      const { res } = await read({ 'a.b3dm': buildB3dm({ featureTable: { BATCH_LENGTH: bl }, glb: triangleGltf() }) });
      expect(issueCodes(res)).toEqual(['invalid-content']);
    }
  });

  it('refuses a 4e8-element MAT4 accessor without a bufferView before allocating its 51 GB', async () => {
    const glb = triangleGltf((j) => {
      j.accessors.push({ componentType: 5126, count: 4e8, type: 'MAT4' });
      j.meshes[0].primitives[0].attributes.NORMAL = 2;
    });
    const { res, ms } = await read({ 'a.glb': glb });
    expect(issueCodes(res)).toEqual(['limit']);
    expect(res.truncation).toEqual({ reason: 'decoded', pendingUrls: [`${BASE}a.glb`] });
    expect(ms).toBeLessThan(1000);
  });

  it('refuses a huge POSITION count on a primitive without indices (the index list used to be built from it and crashed the heap)', async () => {
    const glb = triangleGltf((j) => {
      j.accessors[0] = { componentType: 5126, count: 3e8, type: 'VEC3' };
    });
    const { res, ms } = await read({ 'a.glb': glb });
    expect(issueCodes(res)).toEqual(['limit']);
    expect(res.truncation?.reason).toBe('decoded');
    expect(ms).toBeLessThan(1000);
  });

  it('checks an accessor byte range against its bufferView before allocating, even when the limits allow the count', async () => {
    const glb = triangleGltf((j) => {
      j.accessors[0].count = 1e8;
      j.accessors[1].count = 1e8;
    });
    const { res, ms } = await read({ 'a.glb': glb }, { maxVerticesPerContent: 1e9, maxIndicesPerContent: 1e9, maxDecodedVertices: 1e9, maxDecodedIndices: 1e9 });
    expect(issueCodes(res)).toEqual(['invalid-content']);
    expect(res.issues[0].message).toMatch(/extends past its bufferView/);
    expect(ms).toBeLessThan(1000);
  });

  it('trims JSON padding in linear time (a 1 MiB whitespace run used to hang the trailing-whitespace regex)', async () => {
    const pad = ' '.repeat(1 << 20);
    const b3dm = buildB3dm({ featureTable: { BATCH_LENGTH: 1 }, batchTable: { name: ['a'], [`k${pad}x`]: [1] }, glb: triangleGltf() });
    const { res, ms } = await read({ 'a.b3dm': b3dm });
    expect(res.features).toHaveLength(1);
    expect(ms).toBeLessThan(1000);
  });
});

describe('decoded vertex and index caps (#10404 review, item 2)', () => {
  it('stops at the query-wide cap with truncation reason "decoded", keeping what was decoded', async () => {
    const { res } = await read({ 'a.glb': triangleGltf(), 'b.glb': triangleGltf() }, { maxDecodedVertices: 4, concurrency: 1 });
    expect(res.features).toHaveLength(1);
    expect(res.truncation).toEqual({ reason: 'decoded', pendingUrls: [`${BASE}b.glb`] });
    expect(res.stats.decodedVertices).toBe(3);
    expect(res.complete).toBe(false);
  });

  it('counts every node instance of a shared mesh against the per-content cap', async () => {
    const glb = triangleGltf((j) => {
      j.nodes = [{ mesh: 0 }, { mesh: 0, translation: [5, 0, 0] }, { mesh: 0, translation: [10, 0, 0] }];
      j.scenes = [{ nodes: [0, 1, 2] }];
    });
    const ok = await read({ 'a.glb': glb }, { maxVerticesPerContent: 9 });
    expect(ok.res.features[0].positions.length / 3).toBe(9);
    const over = await read({ 'a.glb': glb }, { maxVerticesPerContent: 8 });
    expect(issueCodes(over.res)).toEqual(['limit']);
    expect(over.res.features).toEqual([]);
    expect(over.res.stats.decodedVertices).toBe(0);
  });
});

describe('feature splitting is linear in vertices (#10404 review, item 3)', () => {
  it('splits 20,000 features of one primitive quickly, every vertex in exactly one feature', async () => {
    // The old split allocated an Int32Array(vertexCount) per feature: 20,000 x 60,000 x 4 B = 4.8 GB here.
    const n = 20_000;
    const pos = new Float32Array(n * 9);
    const ids = new Float32Array(n * 3);
    for (let f = 0; f < n; f++) {
      pos.set([f, 0, 0, f + 1, 0, 0, f, 0, -1], f * 9);
      ids.set([f, f, f], f * 3);
    }
    const bin = new Uint8Array([...new Uint8Array(pos.buffer), ...new Uint8Array(ids.buffer)]);
    const glb = buildGlb({
      asset: { version: '2.0' }, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0, _BATCHID: 1 } }] }],
      accessors: [{ bufferView: 0, componentType: 5126, count: n * 3, type: 'VEC3' }, { bufferView: 1, componentType: 5126, count: n * 3, type: 'SCALAR' }],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: pos.byteLength }, { buffer: 0, byteOffset: pos.byteLength, byteLength: ids.byteLength }],
      buffers: [{ byteLength: bin.byteLength }],
    }, bin);
    const { res, ms } = await read({ 'a.b3dm': buildB3dm({ featureTable: { BATCH_LENGTH: n }, glb }) });
    expect(res.features).toHaveLength(n);
    expect(res.features.every((f) => f.positions.length === 9 && f.indices.length === 3)).toBe(true);
    expect(res.features.reduce((s, f) => s + f.positions.length / 3, 0)).toBe(n * 3);
    expect(ms).toBeLessThan(2000);
  });

  it('copies a vertex shared by two features into each, and only that vertex', async () => {
    // Two triangles sharing vertices 1 and 2; the first triangle is feature 0, the second feature 1.
    const pos = new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, -1, 1, 0, -1]);
    const ids = new Float32Array([0, 0, 0, 1]);
    const idx = new Uint16Array([0, 1, 2, 3, 2, 1]);
    const bin = new Uint8Array([...new Uint8Array(pos.buffer), ...new Uint8Array(ids.buffer), ...new Uint8Array(idx.buffer)]);
    const glb = buildGlb({
      asset: { version: '2.0' }, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0, _BATCHID: 1 }, indices: 2 }] }],
      accessors: [
        { bufferView: 0, componentType: 5126, count: 4, type: 'VEC3' },
        { bufferView: 1, componentType: 5126, count: 4, type: 'SCALAR' },
        { bufferView: 2, componentType: 5123, count: 6, type: 'SCALAR' },
      ],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 48 }, { buffer: 0, byteOffset: 48, byteLength: 16 }, { buffer: 0, byteOffset: 64, byteLength: 12 }],
      buffers: [{ byteLength: bin.byteLength }],
    }, bin);
    const { res } = await read({ 'a.glb': glb });
    expect(res.features.map((f) => [f.featureId, f.positions.length / 3, [...f.indices]])).toEqual([[0, 3, [0, 1, 2]], [1, 3, [0, 1, 2]]]);
    // Feature 1's local vertices are source vertices 3, 2, 1: the two shared ones equal feature 0's copies.
    const [f0, f1] = res.features.map((f) => f.positions);
    expect([...f1.subarray(3, 6)]).toEqual([...f0.subarray(6, 9)]);
    expect([...f1.subarray(6, 9)]).toEqual([...f0.subarray(3, 6)]);
  });
});

describe('glTF structure (#10404 review, item 6)', () => {
  it('without scenes, roots are the nodes nobody lists as a child, so a child listed first keeps its parent transform', async () => {
    const glb = triangleGltf((j) => {
      delete j.scenes;
      j.nodes = [{ mesh: 0 }, { children: [0], translation: [100, 0, 0] }];
    });
    const { res } = await read({ 'a.glb': glb });
    expect(res.features).toHaveLength(1);
    // The parent translation (+100 m on x, unchanged by the y-up to z-up rotation) is applied once, and no untranslated copy exists.
    expect(res.features[0].positions[0]).toBe(100);
    expect(res.features[0].groups.map((g) => g.node)).toEqual([0]);
  });

  it('refuses a byteStride shorter than the element, a negative byteOffset and float indices as invalid content', async () => {
    const stride = triangleGltf((j) => { j.bufferViews[0].byteStride = 4; });
    const offset = triangleGltf((j) => { j.accessors[0].byteOffset = -12; });
    const floatIndices = triangleGltf((j) => {
      j.accessors.push({ bufferView: 1, componentType: 5126, count: 3, type: 'SCALAR' });
      j.meshes[0].primitives[0].indices = 2;
    });
    for (const [glb, pattern] of [[stride, /byteStride 4 is smaller/], [offset, /byteOffset -12/], [floatIndices, /indices must be UNSIGNED/]] as const) {
      const { res } = await read({ 'a.glb': glb });
      expect(issueCodes(res)).toEqual(['invalid-content']);
      expect(res.issues[0].message).toMatch(pattern);
    }
  });
});

describe('batch table keys cannot reach a prototype (#10404 review, item 7)', () => {
  const batchJson = '{"__proto__":["p"],"constructor":["c"],"prototype":["q"],"name":["n"]}';
  const b3dm = (): Uint8Array => {
    const enc = new TextEncoder();
    const placeholder = buildB3dm({ featureTable: { BATCH_LENGTH: 1 }, batchTable: { x: 0 }, glb: triangleGltf() });
    // Rebuild with the raw batch table text: an object literal cannot carry an own "__proto__" key through JSON.stringify.
    const json = enc.encode(batchJson.padEnd(Math.ceil(batchJson.length / 8) * 8, ' '));
    const view = new DataView(placeholder.buffer, placeholder.byteOffset);
    const ftLen = view.getUint32(12, true);
    const oldBt = view.getUint32(20, true);
    const head = placeholder.subarray(0, 28 + ftLen);
    const glb = placeholder.subarray(28 + ftLen + oldBt);
    const out = new Uint8Array(head.byteLength + json.byteLength + glb.byteLength);
    out.set(head);
    out.set(json, head.byteLength);
    out.set(glb, head.byteLength + json.byteLength);
    const ov = new DataView(out.buffer);
    ov.setUint32(8, out.byteLength, true);
    ov.setUint32(20, json.byteLength, true);
    return out;
  };

  it('keeps __proto__, constructor and prototype columns as plain data on every row', async () => {
    const row = parseB3dm(b3dm()).row(0)!;
    expect(Object.getPrototypeOf(row)).toBe(Object.prototype);
    expect(Object.getOwnPropertyNames(row)).toEqual(['__proto__', 'constructor', 'prototype', 'name']);
    expect(Object.getOwnPropertyDescriptor(row, '__proto__')?.value).toBe('p');
    expect(row.constructor).toBe('c');
    expect(({} as Record<string, unknown>).p).toBeUndefined();

    const { res } = await read({ 'a.b3dm': b3dm() });
    const attrs = res.features[0].attributes;
    expect(Object.getPrototypeOf(attrs)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(attrs, '__proto__')?.value).toBe('p');
    expect(attrs.name).toBe('n');
  });
});
