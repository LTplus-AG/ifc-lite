/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** PR #10404 review: every numeric option is validated up front; glTF JSON is not mistaken for a tileset. */

import { describe, expect, it } from 'vitest';
import { detectContentKind } from './content/decode.js';
import { readTilesetRegion, type ReadTilesetRegionOptions } from './read.js';
import { readSwisstopoBuildings } from './swisstopo.js';
import { mapFetch, quadGlb, regionRad } from '../test/support.js';

const BASE = 'https://tiles.example/set/';
const WORLD = { west: -180, east: 180, south: -90, north: 90 };
const R = regionRad(7.9, 46.9, 8.1, 47.1, -100, 1000);
const tileset = (uri: string): object => ({
  asset: { version: '1.0' }, geometricError: 1,
  root: { boundingVolume: { region: R }, geometricError: 0, content: { uri } },
});
const enc = (o: object): Uint8Array => new TextEncoder().encode(JSON.stringify(o));

/** A glTF JSON document (embedded buffer) built from a GLB, with extras that look like tileset keys. */
function gltfJson(extras: object): Uint8Array {
  const glb = quadGlb();
  const dv = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  const jsonLen = dv.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLen))) as { buffers: Array<{ uri?: string; byteLength: number }>; extras?: object };
  const binStart = 20 + jsonLen + 8;
  const bin = glb.subarray(binStart, binStart + dv.getUint32(20 + jsonLen, true));
  json.buffers[0].uri = `data:application/octet-stream;base64,${Buffer.from(bin).toString('base64')}`;
  json.extras = extras;
  return enc(json);
}

const base = (extra: Partial<ReadTilesetRegionOptions> = {}): ReadTilesetRegionOptions => ({
  url: `${BASE}tileset.json`, region: WORLD, featureFilter: 'tiles',
  fetch: mapFetch({ [`${BASE}tileset.json`]: tileset('a.glb'), [`${BASE}a.glb`]: quadGlb() }), ...extra,
});

describe('numeric options are validated before any request (#10404 review)', () => {
  const bad: Array<[keyof ReadTilesetRegionOptions, number]> = [
    ['concurrency', NaN], ['concurrency', 0], ['concurrency', -1], ['concurrency', 1.5], ['concurrency', Infinity],
    ['maxRequests', NaN], ['maxRequests', -1],
    ['maxBytes', NaN], ['maxBytes', -1],
    ['timeoutMs', NaN], ['timeoutMs', 0], ['timeoutMs', -5], ['timeoutMs', Infinity],
    ['maxNodes', NaN], ['maxNodes', -1],
    ['maxDepth', NaN], ['maxDepth', -1],
    ['maxGeometricError', NaN], ['maxGeometricError', -1],
    ['tileCullMarginMetres', NaN], ['tileCullMarginMetres', -10], ['tileCullMarginMetres', Infinity],
    ['maxVerticesPerContent', NaN], ['maxIndicesPerContent', -1], ['maxDecodedVertices', NaN], ['maxDecodedIndices', NaN],
  ];
  for (const [name, value] of bad) {
    it(`rejects ${name}: ${value} with a RangeError and issues no request`, async () => {
      const opts = base({ [name]: value });
      await expect(readTilesetRegion(opts)).rejects.toThrow(RangeError);
      expect((opts.fetch as unknown as { urls: string[] }).urls).toEqual([]);
    });
  }

  it('rejects a non-number passed through an untyped caller', async () => {
    await expect(readTilesetRegion(base({ concurrency: '4' as unknown as number }))).rejects.toThrow(RangeError);
  });

  it('accepts valid values, including 0 and Infinity budgets, and reads the content', async () => {
    const res = await readTilesetRegion(base({ concurrency: 2, maxGeometricError: 0, tileCullMarginMetres: 0, maxRequests: Infinity, timeoutMs: 5000 }));
    expect(res.complete).toBe(true);
    expect(res.features.length).toBeGreaterThan(0);
  });

  it('the swisstopo preset rejects bad options too and keeps its defaults for explicit undefined', async () => {
    await expect(readSwisstopoBuildings({ region: WORLD, concurrency: NaN, fetch: mapFetch({}) })).rejects.toThrow(RangeError);
    await expect(readSwisstopoBuildings({ region: WORLD, maxRequests: NaN, fetch: mapFetch({}) })).rejects.toThrow(RangeError);
    await expect(readSwisstopoBuildings({ region: WORLD, tileCullMarginMetres: -1, fetch: mapFetch({}) })).rejects.toThrow(RangeError);
    // An explicit undefined must not erase the preset's request budget of 64.
    const kids = Array.from({ length: 100 }, (_, i) => ({ boundingVolume: { region: R }, geometricError: 0, content: { uri: `c${i}.glb` } }));
    const ts = { asset: { version: '1.0' }, geometricError: 1, root: { boundingVolume: { region: R }, geometricError: 1, refine: 'ADD', children: kids } };
    const fetch = mapFetch({ 'https://3d.geo.admin.ch/ch.swisstopo.swissbuildings3d.3d/v1/tileset.json': ts });
    const res = await readSwisstopoBuildings({ region: WORLD, fetch, maxRequests: undefined, maxBytes: undefined });
    expect(res.stats.requests).toBe(64);
    expect(res.truncated).toBe(true);
    expect(res.complete).toBe(false);
  });
});

describe('glTF JSON content is not mistaken for a tileset (#10404 review)', () => {
  for (const extras of [{ root: { a: 1 } }, { geometricError: 5 }]) {
    const key = Object.keys(extras)[0];
    it(`reads a glTF JSON whose extras.${key} sits in the first 4 KiB`, async () => {
      const bytes = gltfJson(extras);
      expect(detectContentKind(bytes)).toBe('gltf');
      const fetch = mapFetch({ [`${BASE}tileset.json`]: tileset('model.gltf'), [`${BASE}model.gltf`]: bytes });
      const res = await readTilesetRegion({ url: `${BASE}tileset.json`, region: WORLD, fetch, featureFilter: 'tiles' });
      expect(res.issues).toEqual([]);
      expect(res.features.length).toBeGreaterThan(0);
      expect(res.complete).toBe(true);
    });
  }

  it('still classifies a tileset by its top-level keys', () => {
    expect(detectContentKind(enc(tileset('a.glb')))).toBe('tileset');
    expect(detectContentKind(enc({ asset: { version: '1.0' }, geometricError: 1, root: {} }))).toBe('tileset');
  });
});

describe('a GLB shorter than its header declares is reported, not clamped (#10404 review, round 2)', () => {
  it('drops the last four bytes of a valid GLB: an invalid-content issue, no features, not complete', async () => {
    const glb = quadGlb();
    const cut = glb.slice(0, glb.byteLength - 4);
    const fetch = mapFetch({ [`${BASE}tileset.json`]: tileset('a.glb'), [`${BASE}a.glb`]: cut });
    const res = await readTilesetRegion({ url: `${BASE}tileset.json`, region: WORLD, fetch, featureFilter: 'tiles' });
    expect(res.complete).toBe(false);
    expect(res.features).toEqual([]);
    expect(res.issues).toMatchObject([{ severity: 'error', code: 'invalid-content' }]);
    expect(res.issues[0].message).toMatch(/truncated/);
  });
});
