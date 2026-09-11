/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Eviction for the partial sub-batch cache.
 *
 * A partial sub-batch is a cached clone holding a SUBSET of a colour batch:
 * the visible subset under hide/isolate, the `:promoted`/`:remaining` halves of
 * a colour-override split (#677), and one slot per distinct alpha of an X-Ray
 * split (#4129). Each clone owns real GPU buffers and is deliberately excluded
 * from the GPU residency budget, so nothing reclaims one implicitly — every
 * clone leaves through a function in this file or leaks for the session.
 *
 * Three maps move together and are only correct together, which is why they are
 * passed as one record: `batches` owns the clone (and its buffers), `keys` maps
 * a requesting SLOT to the cache entry it currently holds, and `versions`
 * records the epoch a slot was last rebuilt for. Dropping a clone without
 * clearing its slot's key strands the slot on a destroyed buffer; clearing the
 * key without dropping the clone leaks the buffers.
 */

import type { BatchedMesh } from './types.js';
import { destroyGpuResources } from './scene-geometry.js';
import { ALPHA_SLOT_KEY } from './xray-alpha.js';

/** The three parallel maps backing the partial sub-batch cache. */
export interface PartialBatchCaches {
  /** cacheKey -> the cloned sub-batch (owns GPU buffers). */
  batches: Map<string, BatchedMesh>;
  /** sourceBatchKey (a requesting slot) -> the cacheKey it currently holds. */
  keys: Map<string, string>;
  /** sourceBatchKey -> the epoch its cached clone was built for. */
  versions: Map<string, number>;
}

/** Drop one slot: destroy the clone it holds and forget the slot entirely. */
function releaseSlot(caches: PartialBatchCaches, sourceBatchKey: string): void {
  const cacheKey = caches.keys.get(sourceBatchKey);
  if (cacheKey !== undefined) {
    const cached = caches.batches.get(cacheKey);
    if (cached) {
      destroyGpuResources(cached);
      caches.batches.delete(cacheKey);
    }
  }
  caches.keys.delete(sourceBatchKey);
  caches.versions.delete(sourceBatchKey);
}

/**
 * Destroy + drop the cached sub-batches derived from `batch`. Their
 * sourceBatchKeys embed the batch id, so they are stale the moment it is
 * evicted or replaced — the prefix match therefore catches every slot shape
 * (`:promoted`, `:remaining`, `:xN`) without having to enumerate them.
 */
export function dropPartialCacheForBatch(caches: PartialBatchCaches, batch: BatchedMesh): void {
  const prefix = `${batch.colorKey}:${batch.id}`;
  // Deleting the CURRENT key during a Map iteration is well-defined (the
  // iterator skips removed entries) and nothing is added here, so no copy.
  for (const sourceBatchKey of caches.keys.keys()) {
    if (!sourceBatchKey.startsWith(prefix)) continue;
    releaseSlot(caches, sourceBatchKey);
  }
}

/**
 * Destroy + drop EVERY cached partial sub-batch. The render loop calls this on
 * the transition back to "no filtering and no X-Ray", because these clones are
 * otherwise only freed on clear()/finalize/evict — so ~model-sized clone VRAM
 * would stay pinned until the next model reload. Safe to call between frames:
 * the previous frame is already submitted and WebGPU defers the free past
 * in-flight work.
 */
export function dropAllPartialCaches(caches: PartialBatchCaches): void {
  if (caches.batches.size === 0 && caches.keys.size === 0 && caches.versions.size === 0) return;
  for (const batch of caches.batches.values()) destroyGpuResources(batch);
  caches.batches.clear();
  caches.keys.clear();
  caches.versions.clear();
}

/**
 * Free the X-Ray alpha-split slots (`…:xN`) that this frame did NOT request.
 *
 * Those slots are orphaned by an ordinary X-Ray edit, not only by switching
 * X-Ray off: a batch that stops needing a split is drawn whole again, so its
 * slots are never revisited, and a group count that shrinks (three alphas back
 * to two) leaves the tail behind. {@link dropAllPartialCaches} fires only once
 * hide/isolate AND X-Ray are all off, so without this sweep those clones stay
 * pinned for the rest of a long-running X-Ray session.
 *
 * Scoped to `:x` slots on purpose. Other slot shapes share this cache but are
 * requested from elsewhere in the frame — the sun shadow pass asks for the
 * plain `${colorKey}:${id}` slot BEFORE the colour pass runs — so a general
 * "retire whatever this pass did not ask for" sweep would free a clone another
 * pass is about to draw from.
 *
 * Cheap enough to run on every epoch change: it walks the cache KEYS (a handful
 * per batch), never the model's elements. Freeing the slot of a frustum-culled
 * batch is harmless — it rebuilds on demand like any cache miss.
 */
export function retireUnusedAlphaSlots(caches: PartialBatchCaches, inUse: ReadonlySet<string>): void {
  if (caches.keys.size === 0) return;
  let stale: string[] | null = null;
  for (const sourceBatchKey of caches.keys.keys()) {
    if (!ALPHA_SLOT_KEY.test(sourceBatchKey)) continue;
    if (inUse.has(sourceBatchKey)) continue;
    (stale ??= []).push(sourceBatchKey);
  }
  if (stale === null) return;
  for (const sourceBatchKey of stale) releaseSlot(caches, sourceBatchKey);
}
