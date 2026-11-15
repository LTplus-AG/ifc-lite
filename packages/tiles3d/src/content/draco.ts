/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { tooLarge } from '../limits.js';

/**
 * KHR_draco_mesh_compression decoding via Google's `draco3d` (Apache-2.0)
 * decoder build (about 59 KB of JS plus a 286 KB wasm). Only the decoder
 * module (`draco3d/draco_decoder_nodejs.js`, an emscripten build that runs in
 * Node and in browsers) is imported, never the package entry that also pulls
 * the 49 KB encoder. It is imported lazily on the first Draco primitive, so a
 * caller that never meets Draco content never loads it.
 *
 * Node resolves the wasm next to the decoder. A browser bundle must say where
 * the wasm is: this package exports it as `@ifc-lite/tiles3d/draco_decoder.wasm`
 * (see the README for the two-line Vite usage), passed through
 * `dracoModuleOptions: { locateFile: () => url }`, or `{ wasmBinary }`.
 */

/** The subset of the emscripten decoder module this reader calls. */
export interface DracoDecoderModule {
  Decoder: new () => DracoDecoder;
  DecoderBuffer: new () => { Init(data: Int8Array, length: number): void };
  Mesh: new () => DracoMesh;
  TRIANGULAR_MESH: number;
  DT_FLOAT32: number;
  HEAPF32: Float32Array;
  HEAPU32: Uint32Array;
  _malloc(bytes: number): number;
  _free(ptr: number): void;
  destroy(obj: unknown): void;
}

interface DracoMesh {
  num_faces(): number;
  num_points(): number;
}

interface DracoAttribute {
  num_components(): number;
}

interface DracoDecoder {
  GetEncodedGeometryType(buffer: unknown): number;
  DecodeBufferToMesh(buffer: unknown, mesh: DracoMesh): { ok(): boolean; error_msg(): string };
  GetAttributeByUniqueId(mesh: DracoMesh, id: number): DracoAttribute | null;
  GetAttributeDataArrayForAllPoints(mesh: DracoMesh, attr: DracoAttribute, dataType: number, bytes: number, ptr: number): boolean;
  GetTrianglesUInt32Array(mesh: DracoMesh, bytes: number, ptr: number): boolean;
}

export type DracoLoader = () => Promise<DracoDecoderModule>;

type DecoderFactory = (options: Record<string, unknown>) => Promise<unknown>;

let shared: { promise: Promise<DracoDecoderModule>; failed: boolean } | undefined;

/**
 * Forget the shared decoder module, including a cached load failure, so the
 * next Draco primitive loads it again (for example with different
 * `dracoModuleOptions`, or after fixing a wasm URL).
 */
export function resetDracoDecoder(): void {
  shared = undefined;
}

/**
 * Default loader: lazily import the `draco3d` decoder module and instantiate
 * it once per process. Every query shares that one instance whatever options
 * object it passes; the options of the first load apply until
 * `resetDracoDecoder()`. A failed load is cached too, so a missing wasm is
 * reported for each Draco tile without being fetched again for each one.
 */
export function defaultDracoLoader(moduleOptions: Record<string, unknown> = {}): DracoLoader {
  return () => {
    if (!shared) {
      const promise = import('draco3d/draco_decoder_nodejs.js').then((m) => {
        // CommonJS module: native ESM puts module.exports on `default`, bundlers may not.
        const ns = m as unknown as { default?: unknown; DracoDecoderModule?: unknown };
        const factory = typeof ns.default === 'function' ? ns.default : ns.DracoDecoderModule;
        if (typeof factory !== 'function') throw new Error('draco3d decoder module has no factory export');
        return (factory as DecoderFactory)({ ...moduleOptions }) as Promise<DracoDecoderModule>;
      });
      const entry = { promise, failed: false };
      promise.catch(() => { entry.failed = true; });
      shared = entry;
    }
    return shared.promise.catch((err: unknown) => {
      throw new Error(`Draco decoder failed to load (cached until resetDracoDecoder()): ${err instanceof Error ? err.message : String(err)}`);
    });
  };
}

/** True when the shared default decoder load has failed and is cached as failed. */
export function dracoDecoderLoadFailed(): boolean {
  return shared?.failed === true;
}

export interface DecodedDraco {
  indices: Uint32Array;
  pointCount: number;
  /** Attribute semantic -> flat float values and component count. */
  attributes: Map<string, { values: Float32Array; size: number }>;
}

/**
 * Decode one Draco-compressed primitive; `attributeIds` maps glTF semantics to
 * Draco unique ids. The decoded point and face counts are checked against
 * `maxPoints` / `maxIndices` (the glTF-declared counts, already within the
 * caller's budget) before any output is allocated. Draco's own allocation
 * during `DecodeBufferToMesh` happens inside the wasm heap, which draco3d caps
 * at 2 GiB; a failure there is a decode error, not a process crash.
 */
export function decodeDracoPrimitive(
  M: DracoDecoderModule,
  bytes: Uint8Array,
  attributeIds: Record<string, number>,
  maxPoints: number,
  maxIndices: number,
): DecodedDraco {
  const decoder = new M.Decoder();
  const buffer = new M.DecoderBuffer();
  const mesh = new M.Mesh();
  try {
    buffer.Init(new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), bytes.byteLength);
    if (decoder.GetEncodedGeometryType(buffer) !== M.TRIANGULAR_MESH) throw new Error('Draco payload is not a triangle mesh');
    const status = decoder.DecodeBufferToMesh(buffer, mesh);
    if (!status.ok()) throw new Error(`Draco decode failed: ${status.error_msg()}`);
    const faces = mesh.num_faces();
    const pointCount = mesh.num_points();
    const indexCount = faces * 3;
    if (pointCount > maxPoints || indexCount > maxIndices) {
      throw tooLarge(`Draco payload decoded to ${pointCount} points / ${indexCount} indices, more than the ${maxPoints} / ${maxIndices} the glTF accessors declare or the limit allows`);
    }

    const ip = M._malloc(indexCount * 4);
    let indices: Uint32Array;
    try {
      decoder.GetTrianglesUInt32Array(mesh, indexCount * 4, ip);
      indices = new Uint32Array(M.HEAPU32.buffer, ip, indexCount).slice();
    } finally {
      M._free(ip);
    }

    const attributes = new Map<string, { values: Float32Array; size: number }>();
    for (const [semantic, id] of Object.entries(attributeIds)) {
      const attr = decoder.GetAttributeByUniqueId(mesh, id);
      if (!attr) throw new Error(`Draco attribute ${semantic} (id ${id}) missing`);
      const size = attr.num_components();
      const n = pointCount * size;
      const ptr = M._malloc(n * 4);
      try {
        if (!decoder.GetAttributeDataArrayForAllPoints(mesh, attr, M.DT_FLOAT32, n * 4, ptr)) {
          throw new Error(`Draco attribute ${semantic} could not be read`);
        }
        attributes.set(semantic, { values: new Float32Array(M.HEAPF32.buffer, ptr, n).slice(), size });
      } finally {
        M._free(ptr);
      }
    }
    return { indices, pointCount, attributes };
  } finally {
    M.destroy(mesh);
    M.destroy(buffer);
    M.destroy(decoder);
  }
}
