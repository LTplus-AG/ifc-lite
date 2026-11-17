/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { createBafuRunoffProvider, snapRequestBox, type CachedHazardResponse } from '../src/bafu/provider.js';
import { BAFU_ATTRIBUTION, BAFU_DATASET_DATE, BAFU_LIMITS } from '../src/bafu/dataset.js';
import { FloodCheckRefusal, HazardRequestError, HazardResponseError } from '../src/errors.js';
import { BAFU_COVERAGE_RINGS, BAFU_COVERAGE_TOLERANCE } from '../src/bafu/coverage-data.js';
import { bafuCovers } from '../src/bafu/coverage.js';
import { decodePng } from '../src/png.js';
import { fixture, rgbaPng } from './helpers.js';

const SITE1 = { minX: 2599537, minY: 1199703, maxX: 2599637, maxY: 1199803 };

function stubFetch(body: Uint8Array | string, init: { status?: number; type?: string } = {}) {
  const calls: string[] = [];
  const fetchImpl = (async (url: string) => {
    calls.push(String(url));
    return new Response(typeof body === 'string' ? body : new Blob([body as BlobPart]), {
      status: init.status ?? 200,
      headers: { 'content-type': init.type ?? 'image/png' },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe('BAFU provider', () => {
  it('requests GetMap with easting,northing axis order and decodes the recorded response', async () => {
    const { fetchImpl, calls } = stubFetch(fixture('bern-three-classes-200px.png'));
    const provider = createBafuRunoffProvider({ fetch: fetchImpl, now: () => new Date('2026-11-15T10:55:00Z') });
    const raster = await provider.fetchRaster({ bbox: SITE1, crs: 'EPSG:2056' });
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      SERVICE: 'WMS',
      VERSION: '1.3.0',
      REQUEST: 'GetMap',
      LAYERS: 'ch.bafu.gefaehrdungskarte-oberflaechenabfluss',
      STYLES: '',
      CRS: 'EPSG:2056',
      BBOX: '2599537,1199703,2599637,1199803',
      WIDTH: '200',
      HEIGHT: '200',
      FORMAT: 'image/png',
      TRANSPARENT: 'true',
    });
    expect(raster.origin).toEqual({ x: 2599537, y: 1199803 });
    expect(raster.cellSize).toBe(0.5);
    expect(raster.counts.byClass['depth-gt-0.25']).toBe(10090);
    expect(raster.provenance).toMatchObject({
      datasetDate: BAFU_DATASET_DATE,
      retrievedAt: '2026-11-15T10:55:00.000Z',
      attribution: BAFU_ATTRIBUTION,
      requestUrl: calls[0],
    });
    expect(raster.provenance.limits).toBe(BAFU_LIMITS);
  });

  it('snaps outward to the cell grid and never asks for fewer than 9 px', () => {
    expect(snapRequestBox({ minX: 10.2, minY: 20.7, maxX: 19.9, maxY: 30.1 }, 0.5)).toEqual({
      bbox: { minX: 10, minY: 20.5, maxX: 20, maxY: 30.5 },
      width: 20,
      height: 20,
    });
    // A 1 x 1 request is answered with HTTP 500 by the server.
    expect(snapRequestBox({ minX: 0, minY: 0, maxX: 1, maxY: 1 }, 1)).toMatchObject({ width: 9, height: 9 });
  });

  it('serves repeated requests from the cache hook and keeps the first retrieval time', async () => {
    const store = new Map<string, CachedHazardResponse>();
    const { fetchImpl, calls } = stubFetch(fixture('bern-three-classes-200px.png'));
    let t = 0;
    const provider = createBafuRunoffProvider({
      fetch: fetchImpl,
      cache: { get: (k) => store.get(k), set: (k, v) => void store.set(k, v) },
      now: () => new Date(Date.UTC(2026, 10, 15, 10, t++)),
    });
    const a = await provider.fetchRaster({ bbox: SITE1, crs: 'EPSG:2056' });
    const b = await provider.fetchRaster({ bbox: SITE1, crs: 'EPSG:2056' });
    expect(calls).toHaveLength(1);
    expect(b.provenance.retrievedAt).toBe(a.provenance.retrievedAt);
  });

  it('turns HTTP errors, service exceptions and size mismatches into typed errors', async () => {
    const http = createBafuRunoffProvider({ fetch: stubFetch('boom', { status: 500, type: 'text/plain' }).fetchImpl });
    await expect(http.fetchRaster({ bbox: SITE1, crs: 'EPSG:2056' })).rejects.toMatchObject({ name: 'HazardRequestError', status: 500 });
    const xml = createBafuRunoffProvider({
      fetch: stubFetch('<ServiceExceptionReport>bad BBOX</ServiceExceptionReport>', { type: 'text/xml' }).fetchImpl,
    });
    await expect(xml.fetchRaster({ bbox: SITE1, crs: 'EPSG:2056' })).rejects.toThrow(/bad BBOX/);
    const wrongSize = createBafuRunoffProvider({ fetch: stubFetch(fixture('bern-uniform-9px.png')).fetchImpl });
    await expect(wrongSize.fetchRaster({ bbox: SITE1, crs: 'EPSG:2056' })).rejects.toBeInstanceOf(HazardResponseError);
  });

  it('times out and honours the abort signal', async () => {
    const hanging = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        if (init?.signal?.aborted) reject(init.signal.reason);
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      })) as unknown as typeof fetch;
    const slow = createBafuRunoffProvider({ fetch: hanging, timeoutMs: 20 });
    await expect(slow.fetchRaster({ bbox: SITE1, crs: 'EPSG:2056' })).rejects.toBeInstanceOf(HazardRequestError);
    const controller = new AbortController();
    const pending = createBafuRunoffProvider({ fetch: hanging, timeoutMs: 10_000 }).fetchRaster({
      bbox: SITE1,
      crs: 'EPSG:2056',
      signal: controller.signal,
    });
    controller.abort(new Error('user cancelled'));
    await expect(pending).rejects.toThrow('user cancelled');
  });

  it('a response whose body stalls after the headers times out as a HazardRequestError, and the rendering check says unconfirmed', async () => {
    const stalling = (async (_url: string, init?: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          // As a platform body read does: a plain AbortError, not the signal's reason.
          init?.signal?.addEventListener('abort', () => controller.error(new DOMException('The operation was aborted', 'AbortError')));
        },
      });
      return new Response(body, { headers: { 'content-type': 'image/png' } });
    }) as unknown as typeof fetch;
    const provider = createBafuRunoffProvider({ fetch: stalling, timeoutMs: 20 });
    await expect(provider.fetchRaster({ bbox: SITE1, crs: 'EPSG:2056' })).rejects.toBeInstanceOf(HazardRequestError);
    expect(await provider.confirmRendering!()).toMatchObject({ confirmed: false, detail: expect.stringMatching(/timed out/) });
  });

  it('refuses a foreign CRS and boxes outside the layer', async () => {
    const provider = createBafuRunoffProvider({ fetch: stubFetch(fixture('bern-uniform-9px.png')).fetchImpl });
    await expect(provider.fetchRaster({ bbox: SITE1, crs: 'EPSG:21781' })).rejects.toMatchObject({ code: 'crs-mismatch' });
    await expect(
      provider.fetchRaster({ bbox: { minX: 90770, minY: 435320, maxX: 90800, maxY: 435350 }, crs: 'EPSG:2056' }),
    ).rejects.toBeInstanceOf(FloodCheckRefusal);
  });

  it('refuses a request larger than the pixel limit with a typed refusal', async () => {
    const provider = createBafuRunoffProvider({ fetch: stubFetch(fixture('bern-uniform-9px.png')).fetchImpl });
    const huge = { minX: 2_600_000, minY: 1_200_000, maxX: 2_610_000, maxY: 1_205_000 };
    await expect(provider.fetchRaster({ bbox: huge, crs: 'EPSG:2056' })).rejects.toMatchObject({ code: 'request-too-large' });
  });

  it('rejects non-finite or non-positive numeric options instead of letting every guard pass', () => {
    for (const bad of [NaN, Infinity, -Infinity, 0, -1]) {
      expect(() => createBafuRunoffProvider({ maxPixels: bad })).toThrow(RangeError);
      expect(() => createBafuRunoffProvider({ timeoutMs: bad })).toThrow(RangeError);
      expect(() => createBafuRunoffProvider({ cellSize: bad })).toThrow(RangeError);
    }
    expect(() => createBafuRunoffProvider({ cellSize: 0.6 })).toThrow(RangeError);
    expect(() => createBafuRunoffProvider({ maxPixels: 100, timeoutMs: 1000, cellSize: 0.25 })).not.toThrow();
  });

  // Review finding 10.
  describe('no data versus no runoff', () => {
    const transparent = rgbaPng(9, 9, () => [0, 0, 0, 0]);

    it('confirms rendering with one 9 x 9 px request at the documented reference location, once', async () => {
      const { fetchImpl, calls } = stubFetch(fixture('bern-uniform-9px.png'));
      const provider = createBafuRunoffProvider({ fetch: fetchImpl });
      const answer = await provider.confirmRendering!();
      expect(answer).toMatchObject({ confirmed: true, detail: '81 of 81 reference pixels show a mapped class' });
      expect(new URL(calls[0]).searchParams.get('BBOX')).toBe('2599560,1199720,2599569,1199729');
      expect(new URL(calls[0]).searchParams.get('WIDTH')).toBe('9');
      await provider.confirmRendering!();
      expect(calls).toHaveLength(1);
    });

    it('does not confirm when the reference area comes back transparent, or the request fails, and asks again next time', async () => {
      const { fetchImpl, calls } = stubFetch(transparent);
      const provider = createBafuRunoffProvider({ fetch: fetchImpl });
      expect(await provider.confirmRendering!()).toMatchObject({ confirmed: false, detail: expect.stringMatching(/without any mapped class/) });
      await provider.confirmRendering!();
      expect(calls).toHaveLength(2);
      const failing = createBafuRunoffProvider({ fetch: stubFetch('down', { status: 503 }).fetchImpl });
      expect(await failing.confirmRendering!()).toMatchObject({ confirmed: false, detail: expect.stringMatching(/HTTP 503/) });
    });

    it('does not confirm a partially rendered reference: one classified pixel among 80 transparent ones', async () => {
      const full = decodePng(fixture('bern-uniform-9px.png'));
      const partial = rgbaPng(9, 9, (x, y) => (x === 4 && y === 4 ? [...full.rgba.slice(0, 4)] : [0, 0, 0, 0]));
      const provider = createBafuRunoffProvider({ fetch: stubFetch(partial).fetchImpl });
      expect(await provider.confirmRendering!()).toMatchObject({ confirmed: false, detail: expect.stringMatching(/only 1 of 81 pixels classified/) });
    });

    it('knows the perimeter of Switzerland and Liechtenstein, and says when a point is too close to tell', () => {
      expect(bafuCovers({ x: 2_600_000, y: 1_200_000 })).toBe(true); // Bern
      expect(bafuCovers({ x: 2_758_000, y: 1_222_000 })).toBe(true); // Vaduz (LI)
      expect(bafuCovers({ x: 2_733_000, y: 1_035_000 })).toBe(false); // Milan
      expect(bafuCovers({ x: 2_693_805, y: 1_283_550 })).toBe(false); // Büsingen enclave (DE)
      expect(bafuCovers({ x: 2_718_937, y: 1_091_917 })).toBe(false); // Campione enclave (IT)
      const [x, y] = BAFU_COVERAGE_RINGS[0].split(',').slice(0, 2).map(Number);
      expect(bafuCovers({ x, y })).toBeNull();
      expect(bafuCovers({ x: x + BAFU_COVERAGE_TOLERANCE / 2, y })).toBeNull();
      expect(createBafuRunoffProvider().covers).toBe(bafuCovers);
    });
  });
});
