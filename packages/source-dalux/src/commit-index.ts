/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Per-file revision histories from Dalux version-set pins (#8646).
 * This index owns the only cache. Its internal commit records are revisions,
 * not a generic source-control API: the consumer is listRevisions. */

import type { DaluxFile } from './dalux-types.js';
import { BrowserDaluxApiClient, fetchAllPages } from './http-client.js';
import { enc, nonEmptyString, unwrapDaluxEnvelope } from './mapping.js';
import { getPinnedModels } from './version-set-browse.js';
import { commitTimestamp, decodeVersionSet, type DaluxVersionSet } from './version-sets.js';

/** Maximum sets whose files we will sweep. An oversized undated listing is
 * refused in full; choosing its first rows would silently hide newer pins. */
const MAX_VERSION_SETS = 250;

/** How long a built index is reused before the sweep runs again. */
const COMMIT_INDEX_TTL_MS = 5 * 60_000;

/**
 * How long a `partial` index (one or more sets' files could not be listed,
 * see {@link DaluxCommitIndex.partial}) is reused before retrying. Much
 * shorter than {@link COMMIT_INDEX_TTL_MS}: the failure that produced it was
 * most likely transient (a single set 404ing, a flaky request), and a
 * partial result is exactly the case where the full TTL is wrong to apply —
 * reusing it for five minutes would mean a model whose only history is in
 * the set that failed looks like it has no history for that long.
 */
const PARTIAL_COMMIT_INDEX_TTL_MS = 30_000;

export interface DaluxModelCommit {
  readonly revisionId: string;
  /** The pinned row, as the version set reported it. */
  readonly file: DaluxFile;
  readonly fileAreaId: string;
  /** Every version set pinning this revision, in sweep order. Never empty. */
  readonly versionSets: readonly DaluxVersionSet[];
  /** Position of the FIRST version set that pinned it. The last-resort ordering signal. */
  readonly sweepIndex: number;
  /** Dalux's revision number (`File.version`) parsed as a number, when it is one. */
  readonly revisionNumber?: number;
}

export interface DaluxModelHistory {
  readonly fileId: string;
  readonly fileName: string;
  readonly fileAreaId: string;
  readonly folderId?: string;
  /** Newest first. Never empty. */
  readonly commits: readonly DaluxModelCommit[];
}

export interface DaluxCommitIndex {
  /** Keyed by `fileId`. */
  readonly models: ReadonlyMap<string, DaluxModelHistory>;
  readonly versionSetCount: number;
  /** `true` when the project is too large to select a complete history safely. */
  readonly truncated: boolean;
  /**
   * `true` when at least one version set's files could not be listed and was
   * skipped (review on #8647). Independent of `truncated`: a sweep can be
   * complete over fewer sets than exist (`truncated`) while also missing
   * sets it did attempt but failed to read (`partial`), and the two must not
   * be conflated — a caller deciding whether to trust "this model has no
   * history" needs to know the sweep that produced that answer was
   * incomplete, which `truncated` alone does not say when every set fit
   * under {@link MAX_VERSION_SETS}.
   */
  readonly partial: boolean;
}

/** One total order for both the index and the Versions panel (#8647).
 * Numeric revisions first (missing last), then date, sweep position and id. */
export function newestFirst(a: DaluxModelCommit, b: DaluxModelCommit): number {
  if ((a.revisionNumber === undefined) !== (b.revisionNumber === undefined)) return a.revisionNumber === undefined ? 1 : -1;
  if (a.revisionNumber !== undefined && b.revisionNumber !== undefined && a.revisionNumber !== b.revisionNumber) return b.revisionNumber - a.revisionNumber;
  const aTime = Date.parse(commitTimestamp(a.file) ?? '');
  const bTime = Date.parse(commitTimestamp(b.file) ?? '');
  const aValid = Number.isFinite(aTime);
  const bValid = Number.isFinite(bTime);
  if (aValid !== bValid) return aValid ? -1 : 1;
  if (aValid && bValid && aTime !== bTime) return bTime - aTime;
  if (a.sweepIndex !== b.sweepIndex) return b.sweepIndex - a.sweepIndex;
  return a.revisionId < b.revisionId ? 1 : a.revisionId > b.revisionId ? -1 : 0;
}

function revisionNumberOf(file: DaluxFile): number | undefined {
  const raw = nonEmptyString(file.version);
  if (raw === undefined) return undefined;
  // `version` is a string in the schema and is a revision NUMBER only for
  // shared/published areas; anything non-numeric (`"A"`, `"draft"`) is a
  // label this cannot order by, and saying so is better than coercing it.
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

interface Accumulator {
  readonly fileId: string;
  /** Keyed by revision id. */
  readonly byRevision: Map<string, {
    file: DaluxFile;
    fileAreaId: string;
    versionSets: DaluxVersionSet[];
    sweepIndex: number;
  }>;
}

/**
 * Sweeps `projectId`'s version sets and builds the per-model histories.
 *
 * Failure isolation, deliberately per set: one version set that 404s (it was
 * deleted between the listing and the file fetch) or whose listing breaks
 * must not discard the history of every other set. The bad one is warned
 * about and skipped, exactly as `watchRevisions` already treats a bad file
 * area — and marks the index `partial` (review on #8647), because unlike
 * `truncated` (a known, bounded cut) this is a set the sweep meant to read
 * and could not.
 */
async function buildCommitIndex(client: BrowserDaluxApiClient, projectId: string): Promise<DaluxCommitIndex> {
  const sets: DaluxVersionSet[] = [];
  let partial = false;
  await fetchAllPages(client, `/2.1/projects/${enc(projectId)}/version_sets`, {}, undefined, (rows) => {
    for (const row of rows) {
      try {
        sets.push(decodeVersionSet(unwrapDaluxEnvelope(row)));
      } catch (error) {
        partial = true;
        client.warn('skipping an undecodable version set', { error: String(error) });
      }
      // No later page can make an already oversized project safe to sweep.
      if (sets.length > MAX_VERSION_SETS) return true;
    }
    return false;
  });

  // The listing has no documented set date/order. Refuse an oversized history
  // rather than choose 250 arbitrary sets and present an old revision as newest.
  const truncated = sets.length > MAX_VERSION_SETS;
  if (truncated) return { models: new Map(), versionSetCount: 0, truncated: true, partial };
  const swept = sets;
  const accumulators = new Map<string, Accumulator>();

  for (let sweepIndex = 0; sweepIndex < swept.length; sweepIndex++) {
    const versionSet = swept[sweepIndex];
    let rows: readonly DaluxFile[];
    try {
      const pinned = await getPinnedModels(client, projectId, versionSet.versionSetId);
      rows = pinned.models;
      partial ||= pinned.partial;
    } catch (error) {
      partial = true;
      client.warn('skipping a version set whose files could not be listed', {
        versionSetId: versionSet.versionSetId,
        error: String(error),
      });
      continue;
    }

    for (const file of rows) {
      // Non-null by construction: `getPinnedModels` drops a row without one,
      // because a pin with no revision id addresses nothing.
      const revisionId = nonEmptyString(file.fileRevisionId);
      if (revisionId === undefined) continue;

      let accumulator = accumulators.get(file.fileId);
      if (!accumulator) {
        // `fileName`/`fileAreaId`/`folderId` are not carried here: the model
        // history below always reads them off the NEWEST commit instead, so
        // a copy on the accumulator would be written once and never read
        // (review on #8647).
        accumulator = { fileId: file.fileId, byRevision: new Map() };
        accumulators.set(file.fileId, accumulator);
      }

      const existing = accumulator.byRevision.get(revisionId);
      if (existing) {
        // Same revision pinned by another set: one commit, two labels.
        existing.versionSets.push(versionSet);
        continue;
      }
      accumulator.byRevision.set(revisionId, {
        file,
        fileAreaId: file.fileAreaId,
        versionSets: [versionSet],
        sweepIndex,
      });
    }
  }

  const models = new Map<string, DaluxModelHistory>();
  for (const accumulator of accumulators.values()) {
    const commits: DaluxModelCommit[] = [...accumulator.byRevision].map(([revisionId, entry]) => {
      const revisionNumber = revisionNumberOf(entry.file);
      return {
        revisionId,
        file: entry.file,
        fileAreaId: entry.fileAreaId,
        versionSets: entry.versionSets,
        sweepIndex: entry.sweepIndex,
        ...(revisionNumber !== undefined ? { revisionNumber } : {}),
      };
    });
    commits.sort(newestFirst);
    // The NEWEST row wins for the model's display name and location: a file
    // renamed or moved between version sets should read as where it is now,
    // not where it started.
    const newest = commits[0];
    models.set(accumulator.fileId, {
      fileId: accumulator.fileId,
      fileName: newest.file.fileName,
      fileAreaId: newest.fileAreaId,
      ...(nonEmptyString(newest.file.folderId) !== undefined ? { folderId: newest.file.folderId } : {}),
      commits,
    });
  }

  return { models, versionSetCount: swept.length, truncated, partial };
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

interface CacheEntry {
  readonly index: Promise<DaluxCommitIndex>;
  readonly builtAt: number;
  /** Mutated in place once `index` resolves, to {@link PARTIAL_COMMIT_INDEX_TTL_MS}
   * if the result came back `partial` (review on #8647). */
  ttl: number;
  /** True once the build has resolved or rejected (so it may be evicted). */
  settled: boolean;
}

/**
 * Milliseconds on a clock that only moves forward. TTLs are elapsed time, so a
 * wall clock adjusted backwards must not keep a (partial) index alive past its
 * TTL (review on #8648).
 */
function monotonicNow(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/**
 * Whether an entry is within its TTL. Elapsed time below zero can only come
 * from a clock that went backwards (an injected wall clock); the age is then
 * unknown, so the entry is treated as expired rather than kept indefinitely.
 */
function isFresh(entry: CacheEntry, now: number): boolean {
  const elapsed = now - entry.builtAt;
  return elapsed >= 0 && elapsed < entry.ttl;
}

/** Upper bound on retained project indexes; in-flight builds are never evicted. */
const MAX_CACHED_INDEXES = 8;

const cache = new Map<string, CacheEntry>();

function cacheKey(client: BrowserDaluxApiClient, projectId: string): string {
  return `${client.baseUrl}|${client.cacheIdentity}|${projectId}`;
}

/** Drop expired settled entries, then the oldest settled ones past the bound. */
function evictStaleEntries(now: number): void {
  for (const [key, entry] of cache) {
    if (entry.settled && !isFresh(entry, now)) cache.delete(key);
  }
  for (const [key, entry] of cache) {
    if (cache.size < MAX_CACHED_INDEXES) break;
    if (entry.settled) cache.delete(key);
  }
}

/** Drop the one project-history cache, forcing fresh rows on the next sweep. */
export function invalidateCommitIndex(): void {
  cache.clear();
}

/**
 * The project's index, built at most once per {@link COMMIT_INDEX_TTL_MS}.
 *
 * The cached value is the PROMISE, not the result, so several callers
 * arriving together (the panel opening while a commit is being loaded) share
 * one sweep instead of each starting their own. A rejected build is evicted
 * so a transient outage is not remembered for the whole TTL.
 *
 * A TTL rather than "immutable, cache forever": individual commits are
 * immutable, but the SET of version sets is not — a new coordination package
 * is exactly what a user opens this panel to find.
 */
export async function getCommitIndex(
  client: BrowserDaluxApiClient,
  projectId: string,
  signal?: AbortSignal,
  now: number = monotonicNow(),
): Promise<DaluxCommitIndex> {
  const key = cacheKey(client, projectId);
  const cached = cache.get(key);
  if (cached && isFresh(cached, now)) return cached.index;

  // NOT given the caller's `signal`: the result is shared, so one caller
  // aborting (a panel unmounting) must not cancel the sweep every other
  // caller is awaiting. The sweep is bounded by `MAX_VERSION_SETS` instead.
  void signal;
  const index = buildCommitIndex(client, projectId);
  const entry: CacheEntry = { index, builtAt: now, ttl: COMMIT_INDEX_TTL_MS, settled: false };
  evictStaleEntries(now);
  cache.set(key, entry);
  index.then(
    (result) => {
      entry.settled = true;
      if (result.partial) entry.ttl = PARTIAL_COMMIT_INDEX_TTL_MS;
    },
    () => {
      entry.settled = true;
      // Only this build's own entry, and only if nothing has replaced it: a
      // build that outlives the TTL can have a second one already running
      // under the same key by the time this rejects, and deleting
      // unconditionally would evict THAT one instead (review on #8647).
      if (cache.get(key) === entry) cache.delete(key);
    },
  );
  return index;
}
