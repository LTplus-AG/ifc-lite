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

import { matchesGlob } from '@ifc-lite/plugin-api';
import { decodeFile } from './dalux-types.js';
import type { DaluxFile } from './dalux-types.js';
import { BrowserDaluxApiClient, fetchAllPages } from './http-client.js';
import { enc, nonEmptyString, unwrapDaluxEnvelope } from './mapping.js';
import { commitTimestamp, decodeVersionSet, type DaluxVersionSet } from './version-sets.js';

/**
 * Which files are treated as models. A version set pins every document in a
 * file area — drawings, PDFs, spreadsheets — and none of those has a model
 * history worth showing, so they are dropped during the sweep rather than
 * carried in memory and filtered later.
 */
const MODEL_NAME_PATTERNS: readonly string[] = ['*.ifc', '*.ifczip', '*.ifcxml', '*.ifcx', '*.ifc5'];

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
}

/**
 * Newest first.
 *
 * Three signals, in descending order of how much they can be trusted:
 *
 *  1. `File.version` — "for files in file areas of type shared or published,
 *     the version corresponds to the revision number" (Dalux's own schema).
 *     A real revision number is the only signal that is unambiguous by
 *     construction, so it wins whenever BOTH sides have one.
 *  2. `lastModified` / `uploaded`. Good when the version-set file rows carry
 *     the pinned revision's own timestamps; useless if Dalux ever answers
 *     with the file's current metadata instead, which is why it is not the
 *     only signal.
 *  3. Sweep position, later-is-newer. A guess about an undocumented list
 *     order, and deliberately last: it only decides a pair that the two real
 *     signals could not separate.
 */
function newestFirst(a: DaluxModelCommit, b: DaluxModelCommit): number {
  if (a.revisionNumber !== undefined && b.revisionNumber !== undefined && a.revisionNumber !== b.revisionNumber) {
    return b.revisionNumber - a.revisionNumber;
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
  fileName: string;
  fileAreaId: string;
  folderId?: string;
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
 * area.
 */
async function buildCommitIndex(
  client: BrowserDaluxApiClient,
  projectId: string,
  signal?: AbortSignal,
): Promise<DaluxCommitIndex> {
  const setRows = await fetchAllPages(client, `/2.1/projects/${enc(projectId)}/version_sets`, {}, signal);
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

  for (let sweepIndex = 0; sweepIndex < swept.length; sweepIndex++) {
    if (signal?.aborted) break;
    const versionSet = swept[sweepIndex];
    let rows: unknown[];
    try {
      rows = await fetchAllPages(
        client,
        `/3.0/projects/${enc(projectId)}/version_sets/${enc(versionSet.versionSetId)}/files`,
        {},
        signal,
      );
    } catch (error) {
      if (signal?.aborted) break;
      client.debug('skipping a version set whose files could not be listed', {
        versionSetId: versionSet.versionSetId,
        error: String(error),
      });
      continue;
    }

    for (const row of rows) {
      let file: DaluxFile;
      try {
        file = decodeFile(unwrapDaluxEnvelope(row));
      } catch {
        continue;
      }
      if (file.deleted) continue;
      if (!MODEL_NAME_PATTERNS.some((pattern) => matchesGlob(file.fileName, pattern))) continue;
      // No revision id means nothing to pin, download or tell apart from the
      // next set's copy — there is no commit here, only a file name.
      const revisionId = nonEmptyString(file.fileRevisionId);
      if (revisionId === undefined) continue;

      let accumulator = accumulators.get(file.fileId);
      if (!accumulator) {
        accumulator = {
          fileId: file.fileId,
          fileName: file.fileName,
          fileAreaId: file.fileAreaId,
          ...(nonEmptyString(file.folderId) !== undefined ? { folderId: file.folderId } : {}),
          byRevision: new Map(),
        };
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
    const commits: DaluxModelCommit[] = [...accumulator.byRevision].map(([revisionId, entry]) => ({
      revisionId,
      file: entry.file,
      fileAreaId: entry.fileAreaId,
      versionSets: entry.versionSets,
      sweepIndex: entry.sweepIndex,
      ...(revisionNumberOf(entry.file) !== undefined ? { revisionNumber: revisionNumberOf(entry.file)! } : {}),
    }));
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

  if (truncated) {
    client.debug('version-set sweep truncated', { swept: swept.length, total: sets.length });
  }
  return { models, versionSetCount: swept.length, truncated };
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

interface CacheEntry {
  readonly index: Promise<DaluxCommitIndex>;
  readonly builtAt: number;
}

const cache = new Map<string, CacheEntry>();

function cacheKey(client: BrowserDaluxApiClient, projectId: string): string {
  return `${client.baseUrl}|${projectId}`;
}

/** Drops the cache. Exported for tests and for a "refresh history" action. */
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
  now: number = Date.now(),
): Promise<DaluxCommitIndex> {
  const key = cacheKey(client, projectId);
  const cached = cache.get(key);
  if (cached && now - cached.builtAt < COMMIT_INDEX_TTL_MS) return cached.index;

  // NOT given the caller's `signal`: the result is shared, so one caller
  // aborting (a panel unmounting) must not cancel the sweep every other
  // caller is awaiting. The sweep is bounded by `MAX_VERSION_SETS` instead.
  void signal;
  const index = buildCommitIndex(client, projectId);
  cache.set(key, { index, builtAt: now });
  index.catch(() => cache.delete(key));
  return index;
}
