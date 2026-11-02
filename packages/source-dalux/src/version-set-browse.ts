/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// ============================================================================
// Fetching and caching what ONE version set pins.
//
// `GET /3.0/projects/{p}/version_sets/{vs}/files` is the only endpoint that
// answers "what did this set pin", and it is read from exactly one place:
// `commit-index.ts`'s sweep, which needs it once per set to reconstruct every
// model's history. The result is cached here (not in the sweep) because a
// user who reopens the History panel, or who separately browses that same
// set, must not pay for the listing twice.
//
// NOT the whole of what a "browse version sets" feature needs — there is no
// per-project "list every set, dated" entry point here, because nothing in
// this slice needs one. That is a second, container-browsing read of the
// same two endpoints (listing a project's sets, then one set's files) for a
// different purpose — letting a user pick a set as a snapshot to browse, the
// way a file area is browsed today — and it would extend this module rather
// than duplicate it, exactly as `commit-index.ts` already shares this fetch
// instead of re-implementing it.
// ============================================================================

import { decodeFile } from './dalux-types.js';
import type { DaluxFile } from './dalux-types.js';
import { BrowserDaluxApiClient, fetchAllPages } from './http-client.js';
import { enc, nonEmptyString, unwrapDaluxEnvelope } from './mapping.js';
import { commitTimestamp, isModelFileName } from './version-sets.js';

/** How long one set's pinned rows are reused. Matched to `commit-index.ts`'s
 * TTL, which is the other reader of this cache. */
const BROWSE_TTL_MS = 5 * 60_000;

/** Parsed epoch milliseconds, or `undefined` for absent/unparseable. */
function epoch(timestamp: string | undefined): number | undefined {
  if (timestamp === undefined) return undefined;
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Newest first, with undated rows last, then by name.
 *
 * Name is the tiebreaker rather than sweep position: within ONE set the rows
 * are different FILES, so there is no "later is newer" to read into the
 * order Dalux listed them in, and an arbitrary-but-stable alphabetical order
 * is the honest answer for two models uploaded in the same batch.
 *
 * `version` (Dalux's revision number) is deliberately NOT used here, though
 * `commit-index.ts` trusts it first. There it compares revisions OF ONE
 * FILE, where the number is an ordering. Here it would compare revision 7 of
 * the architectural model against revision 2 of the services model, which
 * says nothing about which was issued first.
 */
function newestModelFirst(a: DaluxFile, b: DaluxFile): number {
  const aTime = epoch(commitTimestamp(a));
  const bTime = epoch(commitTimestamp(b));
  if ((aTime === undefined) !== (bTime === undefined)) return aTime === undefined ? 1 : -1;
  if (aTime !== undefined && bTime !== undefined && aTime !== bTime) return bTime - aTime;
  return a.fileName.localeCompare(b.fileName, undefined, { numeric: true, sensitivity: 'base' });
}

/**
 * The model rows one version set pinned, newest first.
 *
 * Swept in full (`fetchAllPages`) rather than paged: a set's pinned models
 * are a bounded, complete snapshot, and the sweep's only two readers
 * (`commit-index.ts` and, in future, a browse-as-containers view) both need
 * the whole set at once rather than one page of it.
 *
 * Rows with no `fileRevisionId` are dropped. A pinned row's whole purpose is
 * to address one specific revision's bytes; without an id there is nothing
 * to pin, and keeping it would hand a caller a row that silently resolves to
 * current content instead of the snapshot's.
 */
async function fetchPinnedModels(
  client: BrowserDaluxApiClient,
  projectId: string,
  versionSetId: string,
): Promise<readonly DaluxFile[]> {
  const rows = await fetchAllPages(
    client,
    `/3.0/projects/${enc(projectId)}/version_sets/${enc(versionSetId)}/files`,
    {},
  );

  const models: DaluxFile[] = [];
  for (const row of rows) {
    let file: DaluxFile;
    try {
      file = decodeFile(unwrapDaluxEnvelope(row));
    } catch (error) {
      client.debug('skipping an undecodable version-set file row', { versionSetId, error: String(error) });
      continue;
    }
    if (file.deleted) continue;
    if (!isModelFileName(file.fileName)) continue;
    if (nonEmptyString(file.fileRevisionId) === undefined) {
      client.debug('skipping a pinned row with no revision id', { versionSetId, fileId: file.fileId });
      continue;
    }
    models.push(file);
  }
  models.sort(newestModelFirst);
  return models;
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

interface CacheEntry<T> {
  readonly value: Promise<T>;
  readonly builtAt: number;
}

const pinnedCache = new Map<string, CacheEntry<readonly DaluxFile[]>>();

/** Drops the cache. Exported for tests and for a manual refresh. */
export function invalidatePinnedModels(): void {
  pinnedCache.clear();
}

/**
 * Reads `cache`, or fills it with `build()`.
 *
 * The cached value is the PROMISE, so callers arriving together share one
 * request instead of each making their own — the same reason
 * `getCommitIndex` caches a promise. A rejected build is evicted rather than
 * remembered for the whole TTL.
 */
function cached<T>(
  cache: Map<string, CacheEntry<T>>,
  key: string,
  now: number,
  build: () => Promise<T>,
): Promise<T> {
  const entry = cache.get(key);
  if (entry && now - entry.builtAt < BROWSE_TTL_MS) return entry.value;
  const value = build();
  cache.set(key, { value, builtAt: now });
  value.catch(() => cache.delete(key));
  return value;
}

/** One set's pinned models, newest first, cached per set.
 *
 * `signal` is accepted and NOT forwarded, for the same reason `getCommitIndex`
 * doesn't forward one: the result is shared, so one caller aborting (a panel
 * unmounting) must not cancel the fetch another caller is awaiting.
 */
export async function getPinnedModels(
  client: BrowserDaluxApiClient,
  projectId: string,
  versionSetId: string,
  signal?: AbortSignal,
  now: number = Date.now(),
): Promise<readonly DaluxFile[]> {
  void signal;
  return cached(pinnedCache, `${client.baseUrl}|${projectId}|${versionSetId}`, now, () =>
    fetchPinnedModels(client, projectId, versionSetId),
  );
}
