/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Decoding one v13 geometry chunk record into meshes (see geometry-chunks.ts
 * for the section layout): where it inflates, and how its mesh arrays are
 * allocated. Re-exported by geometry-chunks.ts.
 */

import type { MeshData } from '@ifc-lite/geometry';
import { GeometryChunkFlags, type GeometryChunkInfo } from '../types.js';
import { ArrayArena, BufferReader } from '../utils/buffer-utils.js';
import { readMeshRecord } from './geometry.js';
import { inflateRaw } from './geometry-codec.js';

/** Inflates a stored deflate-raw chunk to its `rawLength`-byte record; the default runs on the calling thread. */
export type ChunkInflate = (stored: Uint8Array, rawLength: number) => Promise<Uint8Array>;
/** Inflates (when compressed) and decodes one stored chunk into meshes, e.g. on a worker (`ChunkInflatePool.decode`). */
export type ChunkDecode = (stored: Uint8Array, info: GeometryChunkInfo, version: number) => Promise<MeshData[]>;

const inflateHere: ChunkInflate = (stored) => inflateRaw(stored);

/** How a chunk decode inflates and allocates the meshes' arrays. */
export interface ChunkDecodeOptions {
  /** Where compressed chunks inflate, e.g. a worker pool on a cache hit (`ChunkInflatePool`). Default: this thread. */
  inflate?: ChunkInflate;
  /**
   * Copy each mesh's `positions`, `normals` and `indices` into shared, aligned
   * ~1 MiB blocks (`ArrayArena`): one allocation per block instead of one
   * ArrayBuffer per array. Default `false`: every array owns its own buffer.
   *
   * With `true`, an array is a VIEW into a block that other meshes of the
   * chunk share. Read it through the view (`byteOffset`, `length`). Never
   * transfer its `.buffer` to a worker, which detaches every other mesh in the
   * block, and never reinterpret the whole `.buffer`. Copy first
   * (`array.slice()`) to hand one mesh's arrays on.
   */
  sharedArena?: boolean;
}

/**
 * Decode one chunk record's stored bytes into meshes. Arrays own their buffers unless `sharedArena`.
 * The fourth argument is the options, or (as before) just the inflate function.
 */
export async function decodeGeometryChunk(
  stored: Uint8Array,
  info: GeometryChunkInfo,
  version: number,
  how: ChunkDecodeOptions | ChunkInflate = {},
): Promise<MeshData[]> {
  const options: ChunkDecodeOptions = typeof how === 'function' ? { inflate: how } : how;
  const inflate = options.inflate ?? inflateHere;
  const raw = (info.flags & GeometryChunkFlags.DeflateRaw) ? await inflate(stored, info.uncompressedLength) : stored;
  return decodeChunkRecords(raw, info, version, { sharedArena: options.sharedArena === true });
}

/**
 * Decode an inflated chunk record into meshes: the same on the calling thread and on a decode
 * worker (`ChunkInflatePool.decode`). Throws on any record that does not match the directory.
 */
export function decodeChunkRecords(
  raw: Uint8Array,
  info: Pick<GeometryChunkInfo, 'meshCount' | 'uncompressedLength' | 'appearanceSources'>,
  version: number,
  options: Pick<ChunkDecodeOptions, 'sharedArena'> = {},
): MeshData[] {
  if (raw.byteLength !== info.uncompressedLength) {
    throw new Error(`Invalid cache: chunk decoded to ${raw.byteLength} bytes, directory says ${info.uncompressedLength}`);
  }
  // BufferReader wants an exact ArrayBuffer; raw may be a view.
  const buffer = raw.byteOffset === 0 && raw.byteLength === raw.buffer.byteLength
    ? raw.buffer
    : raw.slice().buffer;
  const reader = new BufferReader(buffer as ArrayBuffer);
  // Opt-in: mesh arrays share arena blocks (one allocation per ~1 MiB, not three per mesh).
  if (options.sharedArena) reader.arena = new ArrayArena();
  const meshes: MeshData[] = [];
  for (let i = 0; i < info.meshCount; i++) {
    meshes.push(readMeshRecord(reader, version, i, info.appearanceSources));
  }
  // `meshCount` and `uncompressedLength` are two independently-corruptible
  // directory fields; a lying pair (meshCount inflated, uncompressedLength
  // adjusted to match a byteLength that swallowed a NEIGHBOURING chunk's
  // bytes — see readChunk's bounds check) would otherwise let this loop
  // silently decode the next chunk's real mesh records as if they belonged
  // to this one, duplicating that geometry under two chunks with no error.
  // Requiring the reader to land exactly on `raw`'s end closes that: valid
  // records always consume the whole (decompressed) chunk record exactly.
  if (reader.position !== raw.byteLength) {
    throw new Error(
      `Invalid cache: chunk claims ${info.meshCount} mesh record(s) but consumed ${reader.position} of ${raw.byteLength} bytes`,
    );
  }
  return meshes;
}
