/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Test support: offline fetch over recorded fixtures and synthetic tile builders. */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { FetchLike, FetchResponseLike } from '../src/fetcher.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
export const SWISS_BASE = 'https://3d.geo.admin.ch/ch.swisstopo.swissbuildings3d.3d/v1/';
export const SWISS_ROOT = `${SWISS_BASE}tileset.json`;

export function fixtureBytes(rel: string): Uint8Array {
  return new Uint8Array(readFileSync(join(FIXTURES, rel)));
}

function response(bytes: Uint8Array | undefined): FetchResponseLike {
  if (!bytes) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
  return { ok: true, status: 200, arrayBuffer: async () => bytes.slice().buffer };
}

/**
 * A streaming response: `chunks` yields the body piece by piece (it may be
 * endless). `arrayBuffer()` is deliberately unusable, so a reader that ignores
 * the stream fails loudly. `pulled` counts chunks handed out.
 */
export function streamResponse(
  chunks: () => Iterator<Uint8Array>,
  init: { contentLength?: number; url?: string } = {},
): FetchResponseLike & { pulled: () => number; readerOpened: () => boolean } {
  let pulled = 0;
  let opened = false;
  const it = chunks();
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = it.next();
      if (next.done) controller.close();
      else {
        pulled++;
        controller.enqueue(next.value);
      }
    },
  });
  return {
    ok: true,
    status: 200,
    url: init.url,
    headers: { get: (name: string) => (name.toLowerCase() === 'content-length' && init.contentLength !== undefined ? String(init.contentLength) : null) },
    body: {
      getReader: () => {
        opened = true;
        return body.getReader();
      },
      cancel: (reason?: unknown) => body.cancel(reason),
    },
    arrayBuffer: async () => {
      throw new Error('arrayBuffer() must not be used when a body stream is present');
    },
    pulled: () => pulled,
    readerOpened: () => opened,
  };
}

/** Fetch that serves the recorded swisstopo fixtures (404 for anything trimmed away) and logs every URL. */
export function swissFixtureFetch(): FetchLike & { urls: string[] } {
  const urls: string[] = [];
  const f: FetchLike = async (url) => {
    urls.push(url);
    if (!url.startsWith(SWISS_BASE)) return response(undefined);
    const rel = url.slice(SWISS_BASE.length);
    const file = rel === 'tileset.json' ? 'swisstopo-root-tileset.json' : rel.replace(/^20260520\//, 'swisstopo-20260520/');
    return response(existsSync(join(FIXTURES, file)) ? fixtureBytes(file) : undefined);
  };
  return Object.assign(f, { urls });
}

/** Fetch over an in-memory URL -> bytes/JSON map. */
export function mapFetch(entries: Record<string, Uint8Array | object>): FetchLike & { urls: string[] } {
  const urls: string[] = [];
  const f: FetchLike = async (url) => {
    urls.push(url);
    const v = entries[url];
    if (v === undefined) return response(undefined);
    return response(v instanceof Uint8Array ? v : new TextEncoder().encode(JSON.stringify(v)));
  };
  return Object.assign(f, { urls });
}

function pad(bytes: Uint8Array, align: number, fill: number): Uint8Array {
  const len = Math.ceil(bytes.byteLength / align) * align;
  if (len === bytes.byteLength) return bytes;
  const out = new Uint8Array(len).fill(fill);
  out.set(bytes);
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.byteLength, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.byteLength;
  }
  return out;
}

const enc = (o: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(o));

export function buildGlb(json: object, bin?: Uint8Array): Uint8Array {
  const j = pad(enc(json), 4, 0x20);
  const b = bin ? pad(bin, 4, 0) : undefined;
  const total = 12 + 8 + j.byteLength + (b ? 8 + b.byteLength : 0);
  const head = new DataView(new ArrayBuffer(12));
  head.setUint32(0, 0x46546c67, true);
  head.setUint32(4, 2, true);
  head.setUint32(8, total, true);
  const chunk = (type: number, data: Uint8Array): Uint8Array => {
    const h = new DataView(new ArrayBuffer(8));
    h.setUint32(0, data.byteLength, true);
    h.setUint32(4, type, true);
    return concat([new Uint8Array(h.buffer), data]);
  };
  return concat([new Uint8Array(head.buffer), chunk(0x4e4f534a, j), ...(b ? [chunk(0x004e4942, b)] : [])]);
}

export function buildB3dm(opts: {
  featureTable: object;
  featureBinary?: Uint8Array;
  batchTable?: object;
  batchBinary?: Uint8Array;
  glb: Uint8Array;
}): Uint8Array {
  const ftJson = pad(enc(opts.featureTable), 8, 0x20);
  const ftBin = pad(opts.featureBinary ?? new Uint8Array(0), 8, 0);
  const btJson = opts.batchTable ? pad(enc(opts.batchTable), 8, 0x20) : new Uint8Array(0);
  const btBin = pad(opts.batchBinary ?? new Uint8Array(0), 8, 0);
  const total = 28 + ftJson.byteLength + ftBin.byteLength + btJson.byteLength + btBin.byteLength + opts.glb.byteLength;
  const h = new DataView(new ArrayBuffer(28));
  [0x62, 0x33, 0x64, 0x6d].forEach((c, i) => h.setUint8(i, c));
  h.setUint32(4, 1, true);
  h.setUint32(8, total, true);
  h.setUint32(12, ftJson.byteLength, true);
  h.setUint32(16, ftBin.byteLength, true);
  h.setUint32(20, btJson.byteLength, true);
  h.setUint32(24, btBin.byteLength, true);
  return concat([new Uint8Array(h.buffer), ftJson, ftBin, btJson, btBin, opts.glb]);
}

/**
 * A plain (non-Draco) glTF with one node and one primitive: two triangles in
 * the y-up node frame, with per-vertex feature ids under `featureSemantic`.
 */
export function quadGlb(opts: { featureSemantic?: string; extra?: object; nodeTranslation?: number[]; meshFeatures?: boolean } = {}): Uint8Array {
  const sem = opts.featureSemantic ?? '_BATCHID';
  // Vertices 0-2 are feature 0, 3-5 are feature 1 (separate triangles).
  const pos = new Float32Array([0, 0, 0, 10, 0, 0, 0, 0, -10, 20, 0, 0, 30, 0, 0, 20, 5, -10]);
  const ids = new Float32Array([0, 0, 0, 1, 1, 1]);
  const idx = new Uint16Array([0, 1, 2, 3, 4, 5]);
  const bin = concat([new Uint8Array(pos.buffer), new Uint8Array(ids.buffer), new Uint8Array(idx.buffer)]);
  const attributes: Record<string, number> = { POSITION: 0, [sem]: 1 };
  const prim: Record<string, unknown> = { attributes, indices: 2, material: 0 };
  if (opts.meshFeatures) prim.extensions = { EXT_mesh_features: { featureIds: [{ featureCount: 2, attribute: 0 }] } };
  return buildGlb({
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, translation: opts.nodeTranslation }],
    meshes: [{ primitives: [prim] }],
    materials: [{ name: 'roof', pbrMetallicRoughness: { baseColorFactor: [1, 0, 0, 1] } }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 6, type: 'VEC3' },
      { bufferView: 1, componentType: 5126, count: 6, type: 'SCALAR' },
      { bufferView: 2, componentType: 5123, count: 6, type: 'SCALAR' },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 72 },
      { buffer: 0, byteOffset: 72, byteLength: 24 },
      { buffer: 0, byteOffset: 96, byteLength: 12 },
    ],
    buffers: [{ byteLength: bin.byteLength }],
    ...opts.extra,
  }, bin);
}

/** A tile region (radians) from degrees. */
export function regionRad(west: number, south: number, east: number, north: number, h0 = 0, h1 = 1000): number[] {
  const r = Math.PI / 180;
  return [west * r, south * r, east * r, north * r, h0, h1];
}
