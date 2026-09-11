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
 * content identity. A failed hash disables automatic matching, never samples. */
export function placementSourceIdentity(source: SourceBlob, cancelled?: () => boolean): Promise<string | undefined> {
  if (cancelled) return hashSource(source, cancelled);
  let pending = identities.get(source);
  if (!pending) {
    pending = hashSource(source);
    identities.set(source, pending);
  }
  return pending;
}

async function hashSource(source: SourceBlob, cancelled: () => boolean = () => false): Promise<string | undefined> {
  try {
    const chunks = [`placement-sha256-1m-v1:${source.size}`];
    for (let start = 0; start < source.size; start += CHUNK_BYTES) {
      if (cancelled()) return undefined;
      const hash = await computeFullSourceHash(await source.slice(start, start + CHUNK_BYTES).arrayBuffer());
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
