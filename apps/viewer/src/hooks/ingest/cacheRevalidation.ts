/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Background revalidation for a SERVED cache hit (either tier, #4269):
 * confirm the full-content hash of the FRESH source (the load's own identity
 * pass, #7022, not a second hash) matches what was stored at write. The mtime
 * guard already rejected any normal on-disk edit before serving; this closes
 * the deliberate mtime-PRESERVED in-place edit (a GUID or same-width
 * coordinate patch the O(1) spread key can't see) that the mtime guard alone
 * would miss. On mismatch: purge the stale entry and auto-reload
 * (a full reparse) with a notice. It only awaits that identity, so it never
 * blocks the instant hit it follows.
 */

import { toast } from '../../components/ui/toast.js';
import { useViewerStore } from '../../store/index.js';
import { deleteCached } from '../useIfcCache.js';
import type { LoadTarget } from '../useIfcLoader.js';

export interface ServedCacheHit {
  file: File;
  target: LoadTarget;
  /** The model the hit registered. */
  modelId: string;
  identity: Promise<string | undefined>;
  cacheKey: string;
  expectedHash: string;
  /**
   * Aborts when any newer load starts (L9), from any loader instance: the
   * user has moved on, and a reload would yank them off it.
   */
  supersession: { signal: AbortSignal; stop(): void };
}

export interface CacheRevalidationHost {
  /** Re-run the canonical load for this file (the latest `loadFile`). */
  reload(file: File, target: LoadTarget): Promise<void> | undefined;
}

export async function revalidateServedCache(hit: ServedCacheHit, host: CacheRevalidationHost): Promise<void> {
  try {
    const freshHash = await hit.identity;
    // Web Crypto unavailable (or a newer load cancelled the pass) → can't
    // revalidate; the mtime guard already vetted this hit, so leave it served.
    if (!freshHash) return;
    if (freshHash === hit.expectedHash) return; // validated: byte-identical source

    console.warn(`[useIfc] source-decoupled cache was stale (full-hash mismatch) — reloading "${hit.file.name}"`);
    await deleteCached(hit.cacheKey);
    // A newer load superseded this one: the entry is purged; don't yank the
    // user off whatever they loaded next. While the stale model is still
    // shown (a newer federated add left it in place), say so instead.
    if (hit.supersession.signal.aborted) {
      if (useViewerStore.getState().models.has(hit.modelId)) {
        toast.info(`"${hit.file.name}" changed since it was cached — reopen it to see the current file.`);
      }
      return;
    }
    hit.supersession.stop(); // the reload is this hit's own load
    toast.info(`"${hit.file.name}" changed since it was cached — reloading with the current file.`);
    await host.reload(hit.file, hit.target);
  } catch (err) {
    console.warn('[useIfc] background cache revalidation failed', err);
  } finally {
    hit.supersession.stop();
  }
}
