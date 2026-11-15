/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Region reads over small synthetic tilesets: refinement, transforms, 1.1 content, unsupported formats. */

import { describe, expect, it } from 'vitest';
import { BudgetedFetcher } from './fetcher.js';
import { enuToEcefMatrix, ecefToGeodetic, geodeticToEcef } from './geodesy.js';
import { readTilesetRegion } from './read.js';
import { resolveUri, traverseTileset } from './traverse.js';
import { prepareRegion } from './volume.js';
import { buildB3dm, buildGlb, mapFetch, quadGlb, regionRad } from '../test/support.js';

const BASE = 'https://tiles.example/set/';
const LON = 8.0, LAT = 47.0;
const REGION = { west: LON - 0.001, east: LON + 0.001, south: LAT - 0.001, north: LAT + 0.001 };
const TILE_REGION = regionRad(LON - 0.002, LAT - 0.002, LON + 0.002, LAT + 0.002, -100, 2000);

function tileset(root: object, version = '1.0'): object {
  return { asset: { version }, geometricError: 100, root };
}

function leaf(uri: string, extra: object = {}): object {
  return { boundingVolume: { region: TILE_REGION }, geometricError: 0, content: { uri }, ...extra };
}

describe('refinement', () => {
  const tree = (refine: string) => tileset({
    boundingVolume: { region: TILE_REGION }, geometricError: 50, refine,
    content: { uri: 'coarse.b3dm' },
    children: [
      { boundingVolume: { region: TILE_REGION }, geometricError: 10, content: { uri: 'mid.b3dm' }, children: [leaf('fine.b3dm')] },
    ],
  });
  const select = async (refine: string, maxGeometricError?: number) => {
    const t = await traverseTileset(new BudgetedFetcher({ fetch: mapFetch({ [`${BASE}tileset.json`]: tree(refine) }) }), `${BASE}tileset.json`, prepareRegion(REGION), { maxGeometricError });
    return t.selected.map((s) => s.url.slice(BASE.length));
  };

  it('ADD collects every intersecting content down to the requested error', async () => {
    expect(await select('ADD')).toEqual(['coarse.b3dm', 'mid.b3dm', 'fine.b3dm']);
    expect(await select('ADD', 20)).toEqual(['coarse.b3dm', 'mid.b3dm']);
  });

  it('REPLACE selects only the level that meets the requested error', async () => {
    expect(await select('REPLACE')).toEqual(['fine.b3dm']);
    expect(await select('REPLACE', 20)).toEqual(['mid.b3dm']);
    expect(await select('REPLACE', 60)).toEqual(['coarse.b3dm']);
  });
});

describe('transforms and content', () => {
  // Tileset root frame: ENU at (LON, LAT, 500 m), split over a root and a child transform.
  const enu = enuToEcefMatrix(LON, LAT, 500);
  // Root: the ENU frame moved 30 m west; child: 30 m east in the root's local frame. Only parent * child gives back `enu`.
  const rootTransform = [...enu.slice(0, 12), enu[12] - 30 * enu[0], enu[13] - 30 * enu[1], enu[14] - 30 * enu[2], 1];
  const ecefShift = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 30, 0, 0, 1];

  it('applies node, y-up to z-up, RTC_CENTER and tile transforms in order', async () => {
    // b3dm with RTC_CENTER (0, 0, 5) in the tile's local frame: everything 5 m up.
    const b3dm = buildB3dm({ featureTable: { BATCH_LENGTH: 2, RTC_CENTER: [0, 0, 5] }, batchTable: { name: ['west', 'east'] }, glb: quadGlb({ nodeTranslation: [1, 0, 0] }) });
    const fetch = mapFetch({
      [`${BASE}tileset.json`]: tileset({
        boundingVolume: { box: [0, 0, 0, 100, 0, 0, 0, 100, 0, 0, 0, 100] }, geometricError: 10, refine: 'ADD', transform: rootTransform,
        children: [{ boundingVolume: { box: [0, 0, 0, 100, 0, 0, 0, 100, 0, 0, 0, 100] }, geometricError: 0, transform: ecefShift, content: { uri: 'a.b3dm' } }],
      }),
      [`${BASE}a.b3dm`]: b3dm,
    });
    const res = await readTilesetRegion({ url: `${BASE}tileset.json`, region: REGION, fetch, featureFilter: 'tiles' });
    expect(res.complete).toBe(true);
    expect(res.features.map((f) => f.attributes.name)).toEqual(['west', 'east']);
    const west = res.features[0];
    // Vertex 0 is the node origin: (1, 0, 0) y-up -> 1 m east, plus RTC 5 m up.
    const [e0, n0, u0] = toEnu(west.positions, 0, enu);
    expect([e0, n0, u0].map((v) => +v.toFixed(6) + 0)).toEqual([1, 0, 5]);
    // Vertex 2 is (0, 0, -10) in y-up glTF: 10 m north once rotated to z-up.
    const [e2, n2, u2] = toEnu(west.positions, 2, enu);
    expect([e2, n2, u2].map((v) => +v.toFixed(6) + 0)).toEqual([1, 10, 5]);
    expect(west.groups).toEqual([{ start: 0, count: 3, node: 0, mesh: 0, primitive: 0, material: 0, materialName: 'roof', baseColorFactor: [1, 0, 0, 1] }]);
  });

  it('reads 3D Tiles 1.1 glb content with CESIUM_RTC and EXT_mesh_features ids, flagging metadata it does not read', async () => {
    const centre = geodeticToEcef(LON, LAT, 500);
    const glb = quadGlb({
      featureSemantic: '_FEATURE_ID_0',
      meshFeatures: true,
      extra: { extensions: { CESIUM_RTC: { center: centre } }, extensionsUsed: ['CESIUM_RTC', 'EXT_mesh_features', 'EXT_structural_metadata'] },
    });
    const fetch = mapFetch({ [`${BASE}tileset.json`]: tileset(leaf('a.glb'), '1.1'), [`${BASE}a.glb`]: glb });
    const res = await readTilesetRegion({ url: `${BASE}tileset.json`, region: REGION, fetch, featureFilter: 'tiles' });
    expect(res.tiles[0].kind).toBe('glb');
    expect(res.features.map((f) => f.featureId)).toEqual([0, 1]);
    const g = ecefToGeodetic(res.features[0].positions[0], res.features[0].positions[1], res.features[0].positions[2]);
    expect(g.height).toBeCloseTo(500, 6);
    expect(res.issues.map((i) => i.message)).toEqual([expect.stringContaining('EXT_structural_metadata')]);
  });

  it('carries the parent query parameters to same-origin child URIs, the child winning on conflict (as CesiumJS does)', () => {
    expect(resolveUri('sub/t.json', 'https://h/a/tileset.json?key=1')).toBe('https://h/a/sub/t.json?key=1');
    // #10404 review item 4: a child with its own query string used to lose key=.
    expect(resolveUri('files/x.glb?session=S', 'https://h/a/root.json?key=K')).toBe('https://h/a/files/x.glb?session=S&key=K');
    expect(resolveUri('x.glb?key=child&v=2', 'https://h/a/root.json?key=K&lang=de')).toBe('https://h/a/x.glb?key=child&v=2&lang=de');
    expect(resolveUri('https://h/b/x.glb', 'https://h/a/root.json?key=K')).toBe('https://h/b/x.glb?key=K');
    expect(resolveUri('x.glb?sig=a%2Bb', 'https://h/a/root.json?key=K%20L')).toBe('https://h/a/x.glb?sig=a%2Bb&key=K%20L');
    // Never to another origin: an API key in the root URL stays with its host.
    expect(resolveUri('https://o/t.json', 'https://h/a/tileset.json?key=1')).toBe('https://o/t.json');
  });
});

describe('unsupported and malformed input is reported, not dropped', () => {
  const magic = (m: string) => {
    const b = new Uint8Array(32);
    for (let i = 0; i < 4; i++) b[i] = m.charCodeAt(i);
    return b;
  };

  it('flags i3dm, pnts and cmpt content as unsupported and the result as incomplete', async () => {
    const fetch = mapFetch({
      [`${BASE}tileset.json`]: tileset({ boundingVolume: { region: TILE_REGION }, geometricError: 1, refine: 'ADD', children: [leaf('a.i3dm'), leaf('b.pnts'), leaf('c.cmpt')] }),
      [`${BASE}a.i3dm`]: magic('i3dm'),
      [`${BASE}b.pnts`]: magic('pnts'),
      [`${BASE}c.cmpt`]: magic('cmpt'),
    });
    const res = await readTilesetRegion({ url: `${BASE}tileset.json`, region: REGION, fetch });
    expect(res.complete).toBe(false);
    expect(res.issues.map((i) => [i.url.slice(BASE.length), i.severity, i.message.split(' ')[0]])).toEqual(expect.arrayContaining([
      ['a.i3dm', 'unsupported', 'Instanced'], ['b.pnts', 'unsupported', 'Point'], ['c.cmpt', 'unsupported', 'Composite'],
    ]));
    expect(res.tiles.map((t) => t.kind).sort()).toEqual(['cmpt', 'i3dm', 'pnts']);
  });

  it('flags implicit tiling, required glTF extensions and external tileset cycles', async () => {
    const meshopt = buildGlb({ asset: { version: '2.0' }, extensionsRequired: ['EXT_meshopt_compression'] });
    const fetch = mapFetch({
      [`${BASE}tileset.json`]: tileset({
        boundingVolume: { region: TILE_REGION }, geometricError: 1, refine: 'ADD',
        children: [
          { ...leaf('{level}/{x}/{y}.glb'), implicitTiling: { subdivisionScheme: 'QUADTREE' } },
          leaf('m.glb'),
          leaf('loop.json'),
        ],
      }),
      [`${BASE}m.glb`]: meshopt,
      [`${BASE}loop.json`]: tileset(leaf('tileset.json')),
    });
    const res = await readTilesetRegion({ url: `${BASE}tileset.json`, region: REGION, fetch });
    const messages = res.issues.map((i) => `${i.severity}: ${i.message}`);
    expect(messages).toEqual(expect.arrayContaining([
      expect.stringMatching(/^unsupported: implicit tiling/),
      'error: decode: glTF requires unsupported extension EXT_meshopt_compression',
      expect.stringMatching(/^error: external tileset cycle/),
    ]));
  });

  it('reports a bounding volume it cannot cull with and keeps the tile', async () => {
    const fetch = mapFetch({
      [`${BASE}tileset.json`]: tileset({ boundingVolume: { extensions: { '3DTILES_bounding_volume_S2': {} } }, geometricError: 0, content: { uri: 'a.glb' } }),
      [`${BASE}a.glb`]: quadGlb(),
    });
    const t = await traverseTileset(new BudgetedFetcher({ fetch }), `${BASE}tileset.json`, prepareRegion(REGION));
    expect(t.selected).toHaveLength(1);
    expect(t.issues[0]).toMatchObject({ severity: 'unsupported', message: expect.stringContaining('no region, box or sphere') });
  });
});

function toEnu(p: Float64Array, v: number, enu: number[]): [number, number, number] {
  const dx = p[v * 3] - enu[12], dy = p[v * 3 + 1] - enu[13], dz = p[v * 3 + 2] - enu[14];
  return [
    enu[0] * dx + enu[1] * dy + enu[2] * dz,
    enu[4] * dx + enu[5] * dy + enu[6] * dz,
    enu[8] * dx + enu[9] * dy + enu[10] * dz,
  ];
}
