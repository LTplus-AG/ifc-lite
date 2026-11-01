/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { perfTally } from '@ifc-lite/load-trace';
import { blobChunks, hashSource, memoryChunks, type SourceBlob } from './source-identity-hash';
import type { SourceIdentityRequest } from './source-identity.worker';

export { PLACEMENT_IDENTITY_PREFIX } from './source-identity-hash';

const identities = new WeakMap<SourceBlob, Promise<string | undefined>>();
/** How often a worker pass checks `cancelled`; a cancelled pass is terminated. */
const CANCEL_POLL_MS = 100;

/** Hash every byte, including scan payloads, without allocating the whole file.
 * The version identifies this fixed-size, ordered SHA-256 chunk construction;
 * size distinguishes a short final chunk. Names and modification times are not
 * content identity. A failed hash disables automatic matching, never samples.
 *
 * `bytes`, when the caller already holds the source's exact contents in memory,
 * feeds the same chunks without re-reading the Blob (#6431): the IFC loader has
 * the whole file in hand, and a thousand awaited `slice().arrayBuffer()` round
 * trips cost several seconds on a 1 GB file before parsing could start. The
 * identity is the same whichever reader supplied the bytes.
 *
 * In a browser a File source is hashed in a worker: SubtleCrypto copies every
 * chunk it digests on the calling thread, which cost ~0.8 s of main-thread
 * time per 343 MB load. The worker reads a SharedArrayBuffer source in place,
 * otherwise the File itself (a plain ArrayBuffer cannot be shared without a
 * copy). Where workers are unavailable the pass runs here. */
export function placementSourceIdentity(
  source: SourceBlob,
  cancelled?: () => boolean,
  bytes?: Uint8Array,
): Promise<string | undefined> {
  const run = () => {
    perfTally('hash.fullSource', source.size);
    if (typeof Worker !== 'undefined' && typeof File !== 'undefined' && source instanceof File) {
      const shared = bytes && bytes.byteLength === source.size && typeof SharedArrayBuffer !== 'undefined'
        && bytes.buffer instanceof SharedArrayBuffer ? bytes.buffer : undefined;
      return hashInWorker({ file: source, shared }, cancelled);
    }
    const read = bytes && bytes.byteLength === source.size ? memoryChunks(bytes) : blobChunks(source);
    return hashSource(source.size, read, cancelled);
  };
  if (cancelled) return run();
  let pending = identities.get(source);
  if (!pending) {
    pending = run();
    identities.set(source, pending);
  }
  return pending;
}

function hashInWorker(request: SourceIdentityRequest, cancelled?: () => boolean): Promise<string | undefined> {
  return new Promise((resolve) => {
    const worker = new Worker(new URL('./source-identity.worker.ts', import.meta.url), { type: 'module' });
    const poll = cancelled ? setInterval(() => { if (cancelled()) finish(undefined); }, CANCEL_POLL_MS) : undefined;
    function finish(identity: string | undefined) {
      if (poll !== undefined) clearInterval(poll);
      worker.terminate();
      resolve(identity);
    }
    worker.onmessage = (event: MessageEvent<string | undefined>) => finish(cancelled?.() ? undefined : event.data ?? undefined);
    worker.onerror = (event) => {
      console.warn('[Reposition] Source identity worker failed:', event.message);
      finish(undefined);
    };
    worker.postMessage(request);
  });
}
