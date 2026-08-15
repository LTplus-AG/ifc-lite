/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Build a value that is guaranteed to describe the world as of the moment it
 * is returned (#1891).
 *
 * The recurring defect on the compare path is one shape: an async run captures
 * something about the world, yields, and the world moves underneath it —
 * federation re-alignment re-frames vertices and their `geometryAabb`s IN
 * PLACE, under unchanged model ids and an unchanged `geometryResult` object.
 * Three separate symptoms came from it: a cache reused across a re-frame, and
 * an in-flight run finishing after the invalidation that was meant to cancel
 * it and republishing what the invalidation had just cleared.
 *
 * Both are the same question — "do these fingerprints still describe the
 * meshes?" — asked at two moments, so this asks it at both:
 *
 *   1. BEFORE reusing a cached value, so a stale cache is never reused.
 *   2. AFTER the extraction's awaits, so a value built across a re-frame is
 *      never returned.
 *
 * When (2) fails the extraction is simply repeated against the world that
 * replaced it, because abandoning silently is its own bug: the user pressed
 * Run and is owed an answer. `maxAttempts` bounds that so a pathological
 * stream of re-aligns cannot spin here forever; exhausting it returns null and
 * the caller reports rather than publishing something it knows is stale.
 *
 * Deliberately NOT what this covers: the diff OPTIONS (scope / blacklist /
 * content matching). Those are a different axis with a different remedy —
 * `publishCompareResult` reads them synchronously at publish time so a
 * captured value can never go stale in the first place. A version check cannot
 * express that and should not try.
 */

export interface VersionedBuildOptions<T> {
  /** Read the world's current version. Called fresh each time — never cached,
   *  since the whole point is to observe it moving. */
  readVersion: () => number;
  /** A previously built value to reuse, if it is still current. */
  cached: T | null;
  /** Does `candidate` describe the world at `version`? */
  isCurrent: (candidate: T, version: number) => boolean;
  /** Build the value from scratch. May await; that is exactly the window this
   *  function exists to close. Receives the version it is building against so
   *  the result can be stamped with it. */
  extract: (version: number) => Promise<T>;
  /** How many times to re-extract before giving up. Default 3. */
  maxAttempts?: number;
}

/**
 * Return a value that `isCurrent` accepts against the version read at the
 * moment of return, or null if that could not be achieved within
 * `maxAttempts`.
 */
export async function buildAtCurrentVersion<T>(options: VersionedBuildOptions<T>): Promise<T | null> {
  const { readVersion, cached, isCurrent, extract } = options;
  const maxAttempts = options.maxAttempts ?? 3;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const version = readVersion();
    // Reusing the cache is synchronous, so nothing can move between this check
    // and the one below; extracting is not, which is the case that retries.
    const candidate = cached && isCurrent(cached, version) ? cached : await extract(version);
    if (isCurrent(candidate, readVersion())) return candidate;
    // The world moved while we were reading it, so whatever we just produced
    // describes a mix of before and after. No need to retire `cached` here:
    // versions only ever move forward, so the reuse check above rejects it on
    // the next pass for the same reason the re-check just did.
  }
  return null;
}
