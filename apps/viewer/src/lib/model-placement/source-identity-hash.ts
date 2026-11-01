/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { sha256Hex } from '@/utils/sourceContentHash';

/**
 * The placement identity construction (#7022), shared by the in-thread pass and
 * `source-identity.worker.ts`: fixed 1 MiB chunks, SHA-256 each, then SHA-256
 * of the ordered chunk digests. Whichever thread runs it, the identity is the same.
 */

export const CHUNK_BYTES = 1024 * 1024;
/** Chunk digests in flight at once (#7022). */
const DIGEST_WINDOW = 8;
/** Every identity starts with this; a stored hash without it predates #7022. */
export const PLACEMENT_IDENTITY_PREFIX = 'placement-sha256-1m-v1:';
export interface SourceBlob { size: number; slice(start: number, end: number): { arrayBuffer(): Promise<ArrayBuffer> } }

/** Reads `[start, end)` of the source as an ArrayBuffer-backed view. `slot`
 * (< DIGEST_WINDOW) names a buffer the reader may reuse once that chunk's
 * digest has settled. */
export type ChunkReader = (start: number, end: number, slot: number) => Promise<Uint8Array>;

export function blobChunks(source: SourceBlob): ChunkReader {
  return async (start, end) => new Uint8Array(await source.slice(start, end).arrayBuffer());
}

/** Plain-ArrayBuffer bytes are digested in place: SubtleCrypto copies its input
 * off the caller's hands, and the loader never writes the source. A
 * SharedArrayBuffer view is rejected by SubtleCrypto, so those chunks are
 * copied into one scratch buffer per digest in flight. */
export function memoryChunks(bytes: Uint8Array): ChunkReader {
  if (bytes.buffer instanceof ArrayBuffer) return async (start, end) => bytes.subarray(start, end);
  const scratch: Uint8Array[] = [];
  return async (start, end, slot) => {
    scratch[slot] ??= new Uint8Array(Math.min(CHUNK_BYTES, bytes.byteLength));
    const view = scratch[slot].subarray(0, end - start);
    view.set(bytes.subarray(start, end));
    return view;
  };
}

/** One full-source pass. The caller counts it as `hash.fullSource` (#7022: at most one per load). */
export async function hashSource(size: number, read: ChunkReader, cancelled: () => boolean = () => false): Promise<string | undefined> {
  try {
    const chunks = [`${PLACEMENT_IDENTITY_PREFIX}${size}`];
    const inFlight: Promise<string | null>[] = [];
    const settleOldest = async () => {
      const hash = await inFlight.shift();
      if (hash) chunks.push(hash);
      return !!hash;
    };
    for (let start = 0, slot = 0; start < size; start += CHUNK_BYTES, slot = (slot + 1) % DIGEST_WINDOW) {
      if (inFlight.length === DIGEST_WINDOW && !await settleOldest()) return undefined;
      if (cancelled()) return undefined;
      inFlight.push(sha256Hex(await read(start, Math.min(size, start + CHUNK_BYTES), slot)));
    }
    while (inFlight.length) if (!await settleOldest()) return undefined;
    if (cancelled()) return undefined;
    const digest = await sha256Hex(new TextEncoder().encode(chunks.join(':')));
    return digest ? `${PLACEMENT_IDENTITY_PREFIX}${digest}` : undefined;
  } catch (error) {
    console.warn('[Reposition] Source identity unavailable:', error);
    return undefined;
  }
}
