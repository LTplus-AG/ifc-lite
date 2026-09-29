/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { computeFullSourceHash } from '@/utils/sourceContentHash';

const CHUNK_BYTES = 1024 * 1024;
interface SourceBlob { size: number; slice(start: number, end: number): { arrayBuffer(): Promise<ArrayBuffer> } }
const identities = new WeakMap<SourceBlob, Promise<string | undefined>>();

/** Hash every byte, including scan payloads, without allocating the whole file.
 * The version identifies this fixed-size, ordered SHA-256 chunk construction;
 * size distinguishes a short final chunk. Names and modification times are not
 * content identity. A failed hash disables automatic matching, never samples.
 *
 * `bytes`, when the caller already holds the source's exact contents in memory,
 * feeds the same chunks without re-reading the Blob (#6431): the IFC loader has
 * the whole file in hand, and a thousand awaited `slice().arrayBuffer()` round
 * trips cost several seconds on a 1 GB file before parsing could start. The
 * identity is the same whichever reader supplied the bytes. */
export function placementSourceIdentity(
  source: SourceBlob,
  cancelled?: () => boolean,
  bytes?: Uint8Array,
): Promise<string | undefined> {
  const read = bytes && bytes.byteLength === source.size ? memoryChunks(bytes) : blobChunks(source);
  if (cancelled) return hashSource(source.size, read, cancelled);
  let pending = identities.get(source);
  if (!pending) {
    pending = hashSource(source.size, read);
    identities.set(source, pending);
  }
  return pending;
}

/** Reads `[start, end)` of the source as an ArrayBuffer-backed view. */
type ChunkReader = (start: number, end: number) => Promise<Uint8Array>;

function blobChunks(source: SourceBlob): ChunkReader {
  return async (start, end) => new Uint8Array(await source.slice(start, end).arrayBuffer());
}

/** Copies each chunk into one reusable scratch buffer: SubtleCrypto rejects a
 * SharedArrayBuffer view, and it takes its own copy of the input, so reuse is safe. */
function memoryChunks(bytes: Uint8Array): ChunkReader {
  const scratch = new Uint8Array(Math.min(CHUNK_BYTES, bytes.byteLength));
  return async (start, end) => {
    const view = scratch.subarray(0, end - start);
    view.set(bytes.subarray(start, end));
    return view;
  };
}

async function hashSource(size: number, read: ChunkReader, cancelled: () => boolean = () => false): Promise<string | undefined> {
  try {
    const chunks = [`placement-sha256-1m-v1:${size}`];
    for (let start = 0; start < size; start += CHUNK_BYTES) {
      if (cancelled()) return undefined;
      const hash = await computeFullSourceHash(await read(start, Math.min(size, start + CHUNK_BYTES)));
      if (!hash) return undefined;
      chunks.push(hash);
    }
    if (cancelled()) return undefined;
    const digest = await computeFullSourceHash(new TextEncoder().encode(chunks.join(':')));
    return digest ? `placement-sha256-1m-v1:${digest}` : undefined;
  } catch (error) {
    console.warn('[Reposition] Source identity unavailable:', error);
    return undefined;
  }
}
