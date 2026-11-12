/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * W1 (load hillclimb, pre-pixel lane): look the cache up and draw a stored
 * scene while the file is still being read.
 *
 * The cache key is a spread-sampled fingerprint (head, tail, interior windows
 * and the exact length: `computeSourceFingerprint`). For a STEP file outside any
 * archive the bytes it samples are the file's own, so the same value comes from
 * Blob slices without the whole-file read. The loader used to wait for that
 * read (0.1 s on Holter, 0.3-0.5 s on BWK, whose streamed read also kept the
 * main thread busy) before it could even look the entry up.
 *
 * What a served hit must satisfy is unchanged, and decided by the same code:
 *  - the lookup key: the loader still derives it from the bytes it read and
 *    compares; a different key (the bytes or the key settings changed in
 *    between) abandons the early adoption and the load goes on as before;
 *  - the hit gate: `decideCacheHit` (mtime guard, stored full hash);
 *  - the content check: the served hit's background revalidation against the
 *    load's full-source identity (purge and reload on mismatch, #4269).
 * A load that ends without serving the hit (miss, read failure, supersession,
 * a newer load) abandons the adopted scene, so the viewport never keeps a
 * scene its load did not serve.
 */

import { computeSourceFingerprintFromBlob } from '@ifc-lite/cache';
import type { LoadTrace } from '@ifc-lite/load-trace';
import { decideCacheHit } from './cacheTier.js';
import { abandonAdoptedSceneSnapshot, adoptCachedSceneSnapshot, type AdoptedSceneSnapshot } from './sceneSnapshotLoad.js';
import { getCached, type CacheResult } from '../services/cacheService.js';

export interface EarlyCacheHit {
  /** The key from Blob slices, or null when this size is not cached or the slices could not be read. */
  cacheKey(): Promise<string | null>;
  /** The entry under that key, as `getCached` returns it. */
  lookup(): Promise<CacheResult | null>;
  /** The adoption begun for a servable hit; the caller that takes it owns it. Taken once. */
  take(): Promise<AdoptedSceneSnapshot | null>;
  /** Drop the adoption unless it was taken. Idempotent. */
  abandon(): void;
}

export interface EarlyCacheHitRequest {
  file: File;
  modelId: string;
  /** The loader's own key derivation, for a source of `byteLength` bytes with this fingerprint. */
  cacheKeyFor(byteLength: number, fingerprintHex: string): string;
  /** The loader's own cache plan: whether a source of this size is read from the cache at all. */
  cachesSize(byteLength: number): boolean;
  isStale(): boolean;
  trace: LoadTrace;
}

type Outcome<T> = { value: T } | { error: unknown };
/** Held as a value, so a step the loader never awaits (it abandoned the early hit) cannot become an unhandled rejection. */
const settle = <T>(promise: Promise<T>): Promise<Outcome<T>> => promise.then((value) => ({ value }), (error: unknown) => ({ error }));
const unwrap = <T>(outcome: Outcome<T>): T | Promise<T> => ('error' in outcome ? Promise.reject(outcome.error) : outcome.value);

/** Start the lookup (and, for a servable hit with a stored scene, the adoption) for a primary STEP file outside any archive. */
export function beginEarlyCacheHit(request: EarlyCacheHitRequest): EarlyCacheHit {
  const { file, trace } = request;
  let owner: 'none' | 'taken' | 'abandoned' = 'none';
  // An abandoned early hit stops adopting at its next check, like a superseded load.
  const isStale = () => owner === 'abandoned' || request.isStale();
  const cacheKey = trace.span('source.fingerprintSlices', () => computeSourceFingerprintFromBlob(file))
    .then((fingerprint) => (request.cachesSize(file.size) ? request.cacheKeyFor(file.size, fingerprint.hex) : null));
  const lookup = cacheKey.then((key) => (key ? trace.span('cache.lookup', () => getCached(key)) : null));
  const adoption = lookup.then((entry) => {
    if (!entry || isStale()) return null;
    const { serve } = decideCacheHit({ sourceDecoupled: !entry.sourceBuffer, storedMtime: entry.lastModified,
      freshMtime: file.lastModified, fullSourceHash: entry.fullSourceHash });
    return serve ? adoptCachedSceneSnapshot(entry, request.modelId, isStale, trace) : null;
  });
  const [keyOutcome, lookupOutcome, adoptionOutcome] = [settle(cacheKey), settle(lookup), settle(adoption)];
  return {
    cacheKey: () => keyOutcome.then((outcome) => {
      if ('value' in outcome) return outcome.value;
      console.warn('[useIfc] cache key from file slices failed; looking up after the read instead:', outcome.error);
      return null;
    }),
    lookup: () => lookupOutcome.then(unwrap),
    take: () => {
      if (owner !== 'none') return Promise.resolve(null);
      owner = 'taken';
      return adoptionOutcome.then(unwrap);
    },
    abandon: () => {
      if (owner !== 'none') return;
      owner = 'abandoned';
      // A failed read or lookup is the loader's to report; here it only means nothing was adopted.
      void adoptionOutcome.then((outcome) => ('value' in outcome ? abandonAdoptedSceneSnapshot(outcome.value) : undefined));
    },
  };
}
