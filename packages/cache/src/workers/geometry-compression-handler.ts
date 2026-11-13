/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { chooseStoredGeometryChunk, inflateRaw } from '../sections/geometry-codec.js';
import { isCompressionRequest, isDecodeRequest, isInflateRequest, type CompressionResponse } from './geometry-compression-protocol.js';
import { decodeChunkRecords } from '../sections/geometry-chunks.js';
import { packDecodedChunk } from './decoded-chunk-transfer.js';

/** Canonical codec handler shared by the real worker and transport contract tests. */
/** The appearance-source pool this worker was last sent (one cache hit's section). */
let cachedPool: Uint32Array[] | undefined;

export async function handleCompressionRequest(
  value: unknown,
  send: (response: CompressionResponse, transfers: ArrayBuffer[]) => void,
): Promise<void> {
  if (isDecodeRequest(value)) {
    if (value.pool) cachedPool = value.pool;
    const pool = value.pool ?? (value.samePool ? cachedPool : undefined);
    try {
      const stored = new Uint8Array(value.buffer);
      const raw = value.compressed ? await inflateRaw(stored) : stored;
      const meshes = decodeChunkRecords(raw, { meshCount: value.meshCount, uncompressedLength: value.rawLength, appearanceSources: pool }, value.version, { sharedArena: true }); // arena blocks: transferred whole to the caller
      const { poolRefs, transfers } = packDecodedChunk(meshes, pool);
      send({ id: value.id, meshes, poolRefs }, transfers);
    } catch (error) {
      send({ id: value.id, error: error instanceof Error ? error.message : String(error) }, []);
    }
    return;
  }
  if (isInflateRequest(value)) {
    try {
      const raw = await inflateRaw(new Uint8Array(value.buffer));
      send({ id: value.id, buffer: raw.buffer, compressed: false }, [raw.buffer]);
    } catch (error) {
      send({ id: value.id, error: error instanceof Error ? error.message : String(error) }, []);
    }
    return;
  }
  if (!isCompressionRequest(value)) throw new Error('Invalid geometry compression request');
  try {
    const result = await chooseStoredGeometryChunk(new Uint8Array(value.buffer));
    send({ id: value.id, buffer: result.bytes.buffer, compressed: result.compressed }, [result.bytes.buffer]);
  } catch (error) {
    send({ id: value.id, error: error instanceof Error ? error.message : String(error) }, []);
  }
}
