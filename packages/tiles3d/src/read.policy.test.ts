/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Network-facing robustness (PR #10404 review): streamed byte budget, URL
 * policy, external tilesets detected by content, the shared Draco decoder,
 * and traversal edge cases raised in review threads.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { defaultDracoLoader, resetDracoDecoder } from './content/draco.js';
import type { FetchLike, FetchResponseLike } from './fetcher.js';
import { geodeticToEcef } from './geodesy.js';
import { readTilesetRegion, type ReadTilesetRegionOptions } from './read.js';
import { buildGlb, mapFetch, quadGlb, regionRad, streamResponse } from '../test/support.js';

const BASE = 'https://tiles.example/set/';
const ROOT = `${BASE}tileset.json`;
const WORLD = { west: -180, east: 180, south: -90, north: 90 };
const TILE_REGION = regionRad(7.9, 46.9, 8.1, 47.1, -100, 1000);

const leaf = (uri: string): object => ({ boundingVolume: { region: TILE_REGION }, geometricError: 0, content: { uri } });
const tileset = (children: object[]): object => ({
  asset: { version: '1.0' }, geometricError: 1,
  root: { boundingVolume: { region: TILE_REGION }, geometricError: 1, refine: 'ADD', children },
});
const json = (o: object): Uint8Array => new TextEncoder().encode(JSON.stringify(o));
const ok = (bytes: Uint8Array, url?: string): FetchResponseLike => ({ ok: true, status: 200, url, arrayBuffer: async () => bytes.slice().buffer });

/** Fetch where each URL maps to a response factory; logs every URL requested. */
function routes(table: Record<string, () => FetchResponseLike>): FetchLike & { urls: string[] } {
  const urls: string[] = [];
  const f: FetchLike = async (url) => {
    urls.push(url);
    const r = table[url];
    return r ? r() : { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
  };
  return Object.assign(f, { urls });
}

function* endless(chunkBytes: number): Iterator<Uint8Array> {
  for (;;) yield new Uint8Array(chunkBytes);
}

function* chunked(bytes: Uint8Array, size: number): Iterator<Uint8Array> {
  for (let o = 0; o < bytes.byteLength; o += size) yield bytes.slice(o, o + size);
}

const read = (fetch: FetchLike, opts: Partial<ReadTilesetRegionOptions> = {}) =>
  readTilesetRegion({ url: ROOT, region: WORLD, fetch, featureFilter: 'tiles', ...opts });

describe('maxBytes bounds every response (#10404 review, item 2)', () => {
  it('stops an endless body at the remaining budget, keeps the tile fetched before it, and reports bytes', async () => {
    const fetch = routes({
      [ROOT]: () => ok(json(tileset([leaf('a.glb'), leaf('endless.glb')]))),
      [`${BASE}a.glb`]: () => ok(quadGlb()),
      [`${BASE}endless.glb`]: () => streamResponse(() => endless(64 * 1024)),
    });
    const started = performance.now();
    const res = await read(fetch, { maxBytes: 1 << 20, concurrency: 1 });
    expect(performance.now() - started).toBeLessThan(2000);
    expect(res.truncation).toEqual({ reason: 'bytes', pendingUrls: [`${BASE}endless.glb`] });
    expect(res.features.map((f) => f.featureId)).toEqual([0, 1]);
    expect(res.stats.bytes).toBeLessThanOrEqual(1 << 20);
  });

  it('keeps four concurrent bodies together within the budget', async () => {
    const big = (): FetchResponseLike => streamResponse(() => chunked(new Uint8Array(1_000_000), 100_000));
    const fetch = routes({
      [ROOT]: () => ok(json(tileset(['a', 'b', 'c', 'd'].map((n) => leaf(`${n}.glb`))))),
      [`${BASE}a.glb`]: big, [`${BASE}b.glb`]: big, [`${BASE}c.glb`]: big, [`${BASE}d.glb`]: big,
    });
    const res = await read(fetch, { maxBytes: 2_500_000, concurrency: 4 });
    expect(res.truncation?.reason).toBe('bytes');
    expect(res.stats.bytes).toBeLessThanOrEqual(2_500_000);
  });

  it('does not trust Content-Length: an encoded size above the decoded size still reads, an endless body is still stopped', async () => {
    const glb = quadGlb();
    // Encoded (gzip) size 120 bytes above a tile that decodes to glb.byteLength: it fits the budget exactly.
    const small = streamResponse(() => chunked(glb, 16), { contentLength: glb.byteLength + 120 });
    const fits = await read(routes({ [ROOT]: () => ok(json(tileset([leaf('a.glb')]))), [`${BASE}a.glb`]: () => small }), { maxBytes: glb.byteLength + json(tileset([leaf('a.glb')])).byteLength });
    expect(fits.truncated).toBe(false);
    expect(fits.complete).toBe(true);
    expect(fits.features).toHaveLength(2);

    const resp = streamResponse(() => endless(1024), { contentLength: 10_000_000 });
    const res = await read(routes({ [ROOT]: () => ok(json(tileset([leaf('a.glb')]))), [`${BASE}a.glb`]: () => resp }), { maxBytes: 1_000_000 });
    expect(res.truncation).toEqual({ reason: 'bytes', pendingUrls: [`${BASE}a.glb`] });
    expect(res.stats.bytes).toBeLessThanOrEqual(1_000_000);
  });

  it('reads a streamed tile in full when it fits', async () => {
    const fetch = routes({ [ROOT]: () => ok(json(tileset([leaf('a.glb')]))), [`${BASE}a.glb`]: () => streamResponse(() => chunked(quadGlb(), 7)) });
    const res = await read(fetch);
    expect(res.complete).toBe(true);
    expect(res.features).toHaveLength(2);
  });
});

describe('URL policy (#10404 review, item 8)', () => {
  it('refuses data: and cross-origin child URIs by default and never requests them', async () => {
    const dataUri = `data:application/octet-stream;base64,${Buffer.from(quadGlb()).toString('base64')}`;
    const fetch = mapFetch({ [ROOT]: tileset([leaf(dataUri), leaf('https://elsewhere.example/x.glb'), leaf('a.glb')]), [`${BASE}a.glb`]: quadGlb() });
    const res = await read(fetch);
    expect(res.issues.map((i) => [i.code, i.message.split(':')[0]])).toEqual([['url-policy', 'URL refused by the URL policy'], ['url-policy', 'URL refused by the URL policy']]);
    expect(fetch.urls).toEqual([ROOT, `${BASE}a.glb`]);
    expect(res.features).toHaveLength(2);
    expect(res.complete).toBe(false);
  });

  it('follows an allowed origin and, when asked, any origin', async () => {
    const cdn = 'https://cdn.example/x.glb';
    const fetch = mapFetch({ [ROOT]: tileset([leaf(cdn)]), [cdn]: quadGlb() });
    expect((await read(fetch, { allowedOrigins: ['https://cdn.example'] })).complete).toBe(true);
    expect((await read(fetch, { allowedOrigins: '*' })).complete).toBe(true);
  });

  it('refuses a root URL with a disallowed protocol before any request', async () => {
    const fetch = mapFetch({});
    await expect(readTilesetRegion({ url: 'file:///etc/tileset.json', region: WORLD, fetch })).rejects.toThrow(/protocol file: is not allowed/);
    expect(fetch.urls).toEqual([]);
  });

  it('refuses a response that was redirected to another origin', async () => {
    const fetch = routes({ [ROOT]: () => ok(json(tileset([leaf('a.glb')]))), [`${BASE}a.glb`]: () => ok(quadGlb(), 'http://169.254.169.254/latest') });
    const res = await read(fetch);
    expect(res.issues).toMatchObject([{ url: `${BASE}a.glb`, severity: 'error', code: 'url-policy' }]);
    expect(res.features).toEqual([]);
  });
});

describe('external tilesets are recognised by content (#10404 review, item 5)', () => {
  it('follows a child tileset whose URL does not end in .json', async () => {
    const fetch = mapFetch({
      [ROOT]: tileset([leaf('sub/tileset?format=3dtiles')]),
      [`${BASE}sub/tileset?format=3dtiles`]: tileset([leaf('a.glb')]),
      [`${BASE}sub/a.glb?format=3dtiles`]: quadGlb(),
    });
    const res = await read(fetch);
    expect(res.issues).toEqual([]);
    expect(res.complete).toBe(true);
    expect(res.features).toHaveLength(2);
    expect(res.features[0].tile.tilesetChain).toEqual([ROOT, `${BASE}sub/tileset?format=3dtiles`]);
    expect(res.stats.tilesetsLoaded).toBe(2);
    expect(res.stats.contentsSelected).toBe(1);
  });

  it('reports a content-detected tileset cycle instead of looping', async () => {
    const fetch = mapFetch({ [ROOT]: tileset([leaf('loop')]), [`${BASE}loop`]: tileset([leaf('loop')]) });
    const res = await read(fetch);
    expect(res.issues.map((i) => i.message)).toEqual([`external tileset cycle via ${BASE}loop`]);
  });
});

describe('shared Draco decoder (#10404 review, item 9)', () => {
  afterEach(() => resetDracoDecoder());

  it('caches a failed load instead of retrying it per tile, until reset', async () => {
    let located = 0;
    const options = { locateFile: () => { located++; return '/nonexistent/draco_decoder.wasm'; }, print: () => {}, printErr: () => {} };
    const load = defaultDracoLoader(options);
    await expect(load()).rejects.toThrow(/Draco decoder failed to load/);
    await expect(defaultDracoLoader(options)()).rejects.toThrow(/cached until resetDracoDecoder/);
    expect(located).toBe(1);
    resetDracoDecoder();
    await expect(load()).rejects.toThrow(/Draco decoder failed to load/);
    expect(located).toBe(2);
  });

  it('reuses one decoder instance whatever options object each call passes', async () => {
    const a = await defaultDracoLoader({})();
    const b = await defaultDracoLoader({})();
    // Compared as a boolean: a failing toBe() would try to diff two emscripten modules with their heaps.
    expect(a === b).toBe(true);
    expect(typeof a.Decoder).toBe('function');
  });
});

describe('review threads on #10404', () => {
  it('keeps a feature that crosses the antimeridian out of a query near Greenwich', async () => {
    // A triangle straddling 180 degrees: two vertices at 179.999 E, one at 179.999 W.
    const [x0, y0, z0] = geodeticToEcef(179.999, 0, 0);
    const pts = [geodeticToEcef(179.999, 0, 0), geodeticToEcef(179.999, 0.001, 0), geodeticToEcef(-179.999, 0, 0)];
    // Positions relative to RTC (x0, y0, z0) in glTF y-up: (x, y, z)_zup = (x, -z, y)_yup.
    const local = pts.flatMap(([x, y, z]) => [x - x0, z - z0, -(y - y0)]);
    const pos = new Float32Array(local);
    const glb = buildGlb({
      asset: { version: '2.0' }, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
      extensionsUsed: ['CESIUM_RTC'], extensions: { CESIUM_RTC: { center: [x0, y0, z0] } },
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' }],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }], buffers: [{ byteLength: 36 }],
    }, new Uint8Array(pos.buffer));
    // The tile region spans every longitude, so the tile is selected for both queries and only the feature filter decides.
    const region = regionRad(-180, -1, 180, 1, -100, 100);
    const fetch = mapFetch({
      [ROOT]: { asset: { version: '1.1' }, geometricError: 1, root: { boundingVolume: { region }, geometricError: 0, content: { uri: 'a.glb' } } },
      [`${BASE}a.glb`]: glb,
    });
    const nearGreenwich = await readTilesetRegion({ url: ROOT, region: { west: -1, east: 1, south: -1, north: 1 }, fetch, featureFilter: 'intersects', tileCullMarginMetres: 0 });
    expect(nearGreenwich.stats.featuresOutsideRegion + nearGreenwich.features.length).toBeLessThanOrEqual(1);
    expect(nearGreenwich.features).toEqual([]);
    const across = await readTilesetRegion({ url: ROOT, region: { west: 179.99, east: -179.99, south: -0.01, north: 0.01 }, fetch });
    expect(across.features).toHaveLength(1);
  });

  it('lists the unvisited content, not the already-fetched tileset, when the node budget stops traversal', async () => {
    const fetch = mapFetch({ [ROOT]: tileset([leaf('a.glb')]) });
    const res = await read(fetch, { maxNodes: 1 });
    expect(res.truncation).toEqual({ reason: 'nodes', pendingUrls: [`${BASE}a.glb`] });
  });
});
