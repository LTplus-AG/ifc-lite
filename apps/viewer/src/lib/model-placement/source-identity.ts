/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { perfTally } from '@ifc-lite/load-trace';
import { sha256Hex } from '@/utils/sourceContentHash';

const CHUNK_BYTES = 1024 * 1024;
/** Chunk digests in flight at once (#7022). The pass runs beside a busy load, so
 * one-at-a-time digests would wait for a main-thread turn per MiB. */
const DIGEST_WINDOW = 8;
/** Every identity starts with this; a stored hash without it predates #7022. */
export const PLACEMENT_IDENTITY_PREFIX = 'placement-sha256-1m-v1:';
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

/** Reads `[start, end)` of the source as an ArrayBuffer-backed view. `slot`
 * (< DIGEST_WINDOW) names a buffer the reader may reuse once that chunk's
 * digest has settled. */
type ChunkReader = (start: number, end: number, slot: number) => Promise<Uint8Array>;

function blobChunks(source: SourceBlob): ChunkReader {
  return async (start, end) => new Uint8Array(await source.slice(start, end).arrayBuffer());
}

/** Plain-ArrayBuffer bytes are digested in place: SubtleCrypto copies its input
 * off the caller's hands, and the loader never writes the source. A
 * SharedArrayBuffer view is rejected by SubtleCrypto, so those chunks are
 * copied into one scratch buffer per digest in flight. */
function memoryChunks(bytes: Uint8Array): ChunkReader {
  if (bytes.buffer instanceof ArrayBuffer) return async (start, end) => bytes.subarray(start, end);
  const scratch: Uint8Array[] = [];
  return async (start, end, slot) => {
    scratch[slot] ??= new Uint8Array(Math.min(CHUNK_BYTES, bytes.byteLength));
    const view = scratch[slot].subarray(0, end - start);
    view.set(bytes.subarray(start, end));
    return view;
  };
}

/** One full-source pass, counted as `hash.fullSource` (#7022: at most one per load). */
async function hashSource(size: number, read: ChunkReader, cancelled: () => boolean = () => false): Promise<string | undefined> {
  try {
    perfTally('hash.fullSource', size);
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
