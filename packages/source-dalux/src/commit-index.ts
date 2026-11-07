/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// ============================================================================
// Turning a project's version sets into per-model commit histories.
//
// THE MAPPING, and why it is this one:
//
//   model  = a model FILE that appears in at least one version set.
//            `modelId` is the `fileId`, which is what
//            `capabilities.commits.modelIdsAreFileIds` promises a host.
//   commit = one distinct REVISION of that file. `commitId` is the
//            `fileRevisionId`.
//
// A commit is a revision, not a version set. Two sets that pin the SAME
// revision of a file are not two versions of that model — the model did not
// change between them — and rendering them as two rows would tell a
// coordinator their model changed when it did not. The sets that pin a
// revision are kept on the commit instead (its message, and `meta`), so the
// coordination context a version set carries is not lost.
//
// THE COST: building this needs one request per version set, because Dalux
// has no "revisions of this file" endpoint and no way to filter
// `listVersionSetFiles` down to one file. The sweep is therefore bounded,
// cached per project, and de-duplicated across concurrent callers.
// ============================================================================

import type { DaluxFile } from './dalux-types.js';
import { BrowserDaluxApiClient, fetchAllPages } from './http-client.js';
import { enc, nonEmptyString, unwrapDaluxEnvelope } from './mapping.js';
import { getPinnedModels, invalidatePinnedModels } from './version-set-browse.js';
import { commitTimestamp, decodeVersionSet, type DaluxVersionSet } from './version-sets.js';

/**
 * Hard ceiling on version sets swept for one project.
 *
 * Each one costs a paged file listing, so an unbounded sweep against a
 * project with thousands of sets is a hang, not a slow load. Hitting it
 * marks the index `truncated`, which the provider reports on every model it
 * builds — a partial history that says it is partial, rather than one that
 * silently claims an old revision is the newest.
 */
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
  /** `true` when {@link MAX_VERSION_SETS} cut the sweep short. */
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

/**
 * Newest first.
 *
 * Three signals, in descending order of how much they can be trusted:
 *
 *  1. `File.version` — "for files in file areas of type shared or published,
 *     the version corresponds to the revision number" (Dalux's own schema).
 *     A real revision number is the only signal that is unambiguous by
 *     construction.
 *  2. `lastModified` / `uploaded`. Good when the version-set file rows carry
 *     the pinned revision's own timestamps; useless if Dalux ever answers
 *     with the file's current metadata instead, which is why it is not the
 *     only signal.
 *  3. Sweep position, later-is-newer. A guess about an undocumented list
 *     order, and deliberately last: it only decides a pair that the two real
 *     signals could not separate.
 *
 * `trustRevisionNumber` decides whether signal 1 applies, and is computed
 * ONCE for the whole array of one model's commits, not per pair compared
 * (review on #8647). A per-pair "use the number when both sides have one"
 * rule is not a total order: with A (rev 2, 3 Jan), B (no number, 2 Jan), C
 * (rev 3, 1 Jan), that rule gives C > A (by number), A > B (by date, no
 * number on B), and B > C (by date, no number on B) — a cycle, so
 * `Array.prototype.sort`'s result depends on input order and on which pairs
 * it happens to compare. Trusting the number only when EVERY commit of this
 * model has one keeps the comparator a fixed function of each commit alone,
 * which is what a total order requires; falling back to date for the whole
 * array otherwise is the same "most trustworthy signal that's actually
 * available" idea, just decided before sorting starts instead of mid-sort.
 */
function newestFirst(a: DaluxModelCommit, b: DaluxModelCommit, trustRevisionNumber: boolean): number {
  if (trustRevisionNumber && a.revisionNumber !== b.revisionNumber) {
    return b.revisionNumber! - a.revisionNumber!;
  }
  const aTime = Date.parse(commitTimestamp(a.file) ?? '');
  const bTime = Date.parse(commitTimestamp(b.file) ?? '');
  const aValid = Number.isFinite(aTime);
  const bValid = Number.isFinite(bTime);
  // An undated row sinks below every dated one rather than sorting as epoch 0
  // at one end or NaN-poisoning the comparison.
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
  const setRows = await fetchAllPages(client, `/2.1/projects/${enc(projectId)}/version_sets`, {});
  const sets: DaluxVersionSet[] = [];
  for (const row of setRows) {
    try {
      // Every Dalux list row arrives as a `{ data: … }` envelope.
      sets.push(decodeVersionSet(unwrapDaluxEnvelope(row)));
    } catch (error) {
      client.debug('skipping an undecodable version set', { error: String(error) });
    }
  }

  const truncated = sets.length > MAX_VERSION_SETS;
  const swept = truncated ? sets.slice(0, MAX_VERSION_SETS) : sets;
  const accumulators = new Map<string, Accumulator>();
  let partial = false;

  for (let sweepIndex = 0; sweepIndex < swept.length; sweepIndex++) {
    const versionSet = swept[sweepIndex];
    let rows: readonly DaluxFile[];
    try {
      // Shared with the version-set BROWSE path (`version-set-browse.ts`),
      // which reads the same endpoint and applies the same three filters —
      // deleted, not a model, no revision id. One implementation because the
      // two must never disagree about what a set pins, and one CACHE because
      // a user who browses a version set and then opens its History would
      // otherwise fetch every set's rows twice.
      rows = await getPinnedModels(client, projectId, versionSet.versionSetId);
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
    // Whether every commit of THIS model carries a revision number, decided
    // once for the whole array rather than per pair compared — see
    // `newestFirst`'s doc for why a per-pair decision is not a total order.
    const trustRevisionNumber = commits.every((commit) => commit.revisionNumber !== undefined);
    commits.sort((a, b) => newestFirst(a, b, trustRevisionNumber));
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

  if (truncated) {
    client.debug('version-set sweep truncated', { swept: swept.length, total: sets.length });
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
}

const cache = new Map<string, CacheEntry>();

function cacheKey(client: BrowserDaluxApiClient, projectId: string): string {
  return `${client.baseUrl}|${client.cacheIdentity}|${projectId}`;
}

/**
 * Drops the cache. Exported for tests and for a "refresh history" action.
 *
 * Clears the PINNED-ROW cache too, because the index is now derived from it
 * (`getPinnedModels`). Dropping only the index would rebuild it from exactly
 * the same rows it was built from — "refresh" that cannot see a new revision
 * is not a refresh, and a test that invalidated between phases would be
 * asserting against data it believed it had discarded.
 */
export function invalidateCommitIndex(): void {
  cache.clear();
  invalidatePinnedModels();
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
  now: number = Date.now(),
): Promise<DaluxCommitIndex> {
  const key = cacheKey(client, projectId);
  const cached = cache.get(key);
  if (cached && now - cached.builtAt < cached.ttl) return cached.index;

  // NOT given the caller's `signal`: the result is shared, so one caller
  // aborting (a panel unmounting) must not cancel the sweep every other
  // caller is awaiting. The sweep is bounded by `MAX_VERSION_SETS` instead.
  void signal;
  const index = buildCommitIndex(client, projectId);
  const entry: CacheEntry = { index, builtAt: now, ttl: COMMIT_INDEX_TTL_MS };
  cache.set(key, entry);
  index.then(
    (result) => {
      if (result.partial) entry.ttl = PARTIAL_COMMIT_INDEX_TTL_MS;
    },
    () => {
      // Only this build's own entry, and only if nothing has replaced it: a
      // build that outlives the TTL can have a second one already running
      // under the same key by the time this rejects, and deleting
      // unconditionally would evict THAT one instead (review on #8647).
      if (cache.get(key) === entry) cache.delete(key);
    },
  );
  return index;
}
