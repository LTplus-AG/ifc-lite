/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { GeometryCompressionSession, type CompressionWorkerPort } from './geometry-compression-client.js';
import { handleCompressionRequest } from './geometry-compression-handler.js';
import type { CompressionRequest } from './geometry-compression-protocol.js';
import { chooseStoredGeometryChunk, deflateRaw, inflateRaw } from '../sections/geometry-codec.js';

/** Real handler/codec plus real structured-clone transfers, without a browser claim. */
export class CodecPort implements CompressionWorkerPort {
  onmessage: CompressionWorkerPort['onmessage'] = null;
  onerror: CompressionWorkerPort['onerror'] = null;
  onmessageerror: CompressionWorkerPort['onmessageerror'] = null;
  terminated = 0;
  inFlight = 0;
  maxInFlight = 0;
  requests = 0;
  hold = false;
  rawReturnedWithOriginalBacking = false;
  postMessage(message: CompressionRequest, transfers: ArrayBuffer[]): void {
    const received = structuredClone(message, { transfer: transfers });
    this.requests++;
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    if (this.hold) return;
    void handleCompressionRequest(received, (response, outgoing) => {
      if ('buffer' in response && !response.compressed) {
        this.rawReturnedWithOriginalBacking = response.buffer === received.buffer && outgoing[0] === received.buffer;
      }
      const result = structuredClone(response, { transfer: outgoing });
      this.inFlight--;
      this.onmessage?.(new MessageEvent('message', { data: result }));
    }).catch(error => { throw error; });
  }
  terminate(): void { this.terminated++; }
}

afterEach(() => vi.unstubAllGlobals());

describe('cache compression ownership and lifecycle (#3985)', () => {
  it('uses identical canonical compressed bytes and returns nonpaying raw backing', async () => {
    const compressible = new Uint8Array(100_000).fill(42);
    const raw = new Uint8Array([51, 79, 111]);
    const rawResult = await chooseStoredGeometryChunk(raw);
    expect(rawResult.compressed).toBe(false);
    expect(rawResult.bytes).toBe(raw);
    const port = new CodecPort();
    const session = new GeometryCompressionSession(() => port);
    try {
      for (const source of [compressible, raw]) {
        const canonical = await chooseStoredGeometryChunk(source);
        const input = source.slice();
        const resultPromise = session.compress(input);
        expect(input.byteLength).toBe(0);
        const result = await resultPromise;
        expect(result.compressed).toBe(canonical.compressed);
        expect(result.bytes).toEqual(canonical.bytes);
        expect(result.compressed ? await inflateRaw(result.bytes) : result.bytes).toEqual(source);
      }
    } finally { session.close(); }
    expect(port.terminated).toBe(1);
    expect(port.onmessage).toBeNull();
    expect(port.rawReturnedWithOriginalBacking).toBe(true);
  });

  it('retains the existing subarray codec contract', async () => {
    const data = new Uint8Array(512).map((_, i) => i % 251).subarray(21, 179);
    expect(await inflateRaw(await deflateRaw(data))).toEqual(data);
  });

  for (const failure of ['worker error', 'messageerror', 'unknown id', 'bad length', 'codec error', 'close']) {
    it(`settles all four in-flight requests on ${failure}`, async () => {
      const port = new CodecPort(); port.hold = true;
      const session = new GeometryCompressionSession(() => port);
      const pending = Array.from({ length: 4 }, () => session.compress(new Uint8Array(100)));
      const settled = Promise.allSettled(pending);
      if (failure === 'worker error') {
        const event = new Event('error');
        Object.defineProperty(event, 'message', { value: 'intentional worker failure' });
        port.onerror?.(event as ErrorEvent);
      } else if (failure === 'messageerror') port.onmessageerror?.(new MessageEvent('messageerror'));
      else if (failure === 'close') session.close();
      else port.onmessage?.(new MessageEvent('message', { data: failure === 'unknown id'
        ? { id: 999, buffer: new ArrayBuffer(100), compressed: false }
        : failure === 'bad length' ? { id: 1, buffer: new ArrayBuffer(99), compressed: false }
        : { id: 1, error: 'intentional codec failure' } }));
      expect((await settled).every(result => result.status === 'rejected')).toBe(true);
      expect(port.terminated).toBe(1);
      expect(port.onmessage).toBeNull();
      await expect(session.compress(new Uint8Array(10))).rejects.toThrow();
      session.close();
      expect(port.terminated).toBe(1);
    });
  }

  it('rejects startup/postMessage failures and stays lazy when unused', async () => {
    let starts = 0;
    const lazy = new GeometryCompressionSession(() => { starts++; throw new Error('blocked worker'); });
    lazy.close();
    expect(starts).toBe(0);
    const startup = new GeometryCompressionSession(() => { throw new Error('blocked worker'); });
    await expect(startup.compress(new Uint8Array(10))).rejects.toThrow('blocked worker');
    const port = new CodecPort();
    port.postMessage = () => { throw new Error('transfer failed'); };
    const session = new GeometryCompressionSession(() => port);
    await expect(session.compress(new Uint8Array(10))).rejects.toThrow('transfer failed');
    expect(port.terminated).toBe(1);
  });
});

import { buildGeometrySectionV13, openGeometryChunksV13 } from '../sections/geometry-chunks.js';
import { FORMAT_VERSION } from '../types.js';
import type { MeshData, CoordinateInfo } from '@ifc-lite/geometry';

const coordinateInfo: CoordinateInfo = {
  originShift: { x: 0, y: 0, z: 0 }, hasLargeCoordinates: false,
  originalBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 300, y: 1, z: 1 } },
  shiftedBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 300, y: 1, z: 1 } },
};
const makeMesh = (id: number, vertices: number): MeshData => ({
  expressId: id, ifcType: 'IFCWALL', origin: [id * 64, 0, 0],
  positions: Float32Array.from({ length: vertices * 3 }, (_, i) => id * 16 + (i % 97) / 8),
  normals: Float32Array.from({ length: vertices * 3 }, (_, i) => (id + i % 3 + 1) / Math.hypot(id + 1, id + 2, id + 3)),
  indices: new Uint32Array([0, 1, 2]), color: [0.2, 0.3, 0.4, 1],
});

// Real compression/decompression of nine chunks can exceed Vitest's 5s default
// on shared CI runners; retain a finite per-test completion bound (#4003).
it('keeps complete geometry bytes/order and the four-record bound through actual codec transfers (#3985)', async () => {
  const meshes = Array.from({ length: 9 }, (_, i) => makeMesh(i + 1, 6000));
  const defaultBytes = await buildGeometrySectionV13(meshes, coordinateInfo);
  const ports: CodecPort[] = [];
  vi.stubGlobal('Worker', class extends CodecPort { constructor() { super(); ports.push(this); } });
  const workerBytes = await buildGeometrySectionV13(meshes, coordinateInfo, { compressInWorker: true });
  expect(new Uint8Array(workerBytes)).toEqual(new Uint8Array(defaultBytes));
  expect(ports).toHaveLength(1);
  expect(ports[0].requests).toBe(9);
  expect(ports[0].maxInFlight).toBe(4);
  expect(ports[0].terminated).toBe(1);
  const opened = openGeometryChunksV13(workerBytes, 0, FORMAT_VERSION);
  const restored = (await Promise.all(opened.chunks.map((_, i) => opened.readChunk(i)))).flat();
  expect(restored.map(mesh => mesh.expressId)).toEqual(meshes.map(mesh => mesh.expressId));
  expect(restored.map(mesh => mesh.positions)).toEqual(meshes.map(mesh => mesh.positions));
  expect(restored.map(mesh => mesh.normals)).toEqual(meshes.map(mesh => mesh.normals));
  expect(restored.map(mesh => mesh.origin)).toEqual(meshes.map(mesh => mesh.origin));
  expect(meshes.every(mesh => mesh.positions.byteLength > 0)).toBe(true);
}, 30_000);

it('starts no compression worker for disabled compression, empty geometry or small chunks (#3985)', async () => {
  let starts = 0;
  vi.stubGlobal('Worker', class extends CodecPort { constructor() { super(); starts++; } });
  await buildGeometrySectionV13([makeMesh(1, 6000)], coordinateInfo, { compress: false, compressInWorker: true });
  await buildGeometrySectionV13([], coordinateInfo, { compressInWorker: true });
  await buildGeometrySectionV13([makeMesh(1, 3)], coordinateInfo, { compressInWorker: true });
  expect(starts).toBe(0);
});
