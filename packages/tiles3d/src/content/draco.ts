/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * KHR_draco_mesh_compression decoding via Google's `draco3d` (Apache-2.0)
 * decoder build (about 59 KB of JS plus a 286 KB wasm). It is imported lazily
 * on the first Draco primitive, so a caller that never meets Draco content
 * never loads it.
 *
 * Node resolves the wasm next to the package. In a browser bundle, pass
 * `dracoModuleOptions` (for example `{ locateFile: () => wasmUrl }` or
 * `{ wasmBinary }`) or a custom `loadDraco` to the reader.
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

const NO_OPTIONS: Record<string, unknown> = {};
const modules = new WeakMap<object, Promise<DracoDecoderModule>>();

/**
 * Default loader: lazily import `draco3d` and instantiate its decoder once per
 * `moduleOptions` object (emscripten options such as `locateFile` or `wasmBinary`).
 */
export function defaultDracoLoader(moduleOptions: Record<string, unknown> = NO_OPTIONS): DracoLoader {
  return () => {
    let p = modules.get(moduleOptions);
    if (!p) {
      p = import('draco3d').then((m) => {
        // CommonJS package: native ESM puts module.exports on `default`, bundlers may not.
        type Api = { createDecoderModule(o: Record<string, unknown>): Promise<unknown> };
        const ns = m as unknown as Api & { default?: Api };
        const api = ns.default ?? ns;
        return api.createDecoderModule(moduleOptions) as Promise<DracoDecoderModule>;
      });
      // A failed load must not poison later attempts.
      p.catch(() => modules.delete(moduleOptions));
      modules.set(moduleOptions, p);
    }
    return p;
  };
}

export interface DecodedDraco {
  indices: Uint32Array;
  pointCount: number;
  /** Attribute semantic -> flat float values and component count. */
  attributes: Map<string, { values: Float32Array; size: number }>;
}

/** Decode one Draco-compressed primitive; `attributeIds` maps glTF semantics to Draco unique ids. */
export function decodeDracoPrimitive(
  M: DracoDecoderModule,
  bytes: Uint8Array,
  attributeIds: Record<string, number>,
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
