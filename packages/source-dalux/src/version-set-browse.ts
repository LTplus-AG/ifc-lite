/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Fresh pinned rows for one version set. The project index owns the only cache:
 * a rebuild must not reuse rows from an older sweep of an unlocked set. */

import { decodeFile } from './dalux-types.js';
import type { DaluxFile } from './dalux-types.js';
import { BrowserDaluxApiClient, fetchAllPages } from './http-client.js';
import { enc, nonEmptyString, unwrapDaluxEnvelope } from './mapping.js';
import { commitTimestamp, isModelFileName } from './version-sets.js';

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
export async function getPinnedModels(
  client: BrowserDaluxApiClient,
  projectId: string,
  versionSetId: string,
): Promise<{ models: readonly DaluxFile[]; partial: boolean }> {
  const rows = await fetchAllPages(
    client,
    `/3.0/projects/${enc(projectId)}/version_sets/${enc(versionSetId)}/files`,
    {},
  );

  const models: DaluxFile[] = [];
  let partial = false;
  for (const row of rows) {
    let file: DaluxFile;
    try {
      file = decodeFile(unwrapDaluxEnvelope(row));
    } catch (error) {
      partial = true;
      client.warn('skipping an undecodable version-set file row', { versionSetId, error: String(error) });
      continue;
    }
    if (file.deleted) continue;
    if (!isModelFileName(file.fileName)) continue;
    if (nonEmptyString(file.fileRevisionId) === undefined) {
      partial = true;
      client.warn('skipping a pinned row with no revision id', { versionSetId, fileId: file.fileId });
      continue;
    }
    models.push(file);
  }
  models.sort(newestModelFirst);
  return { models, partial };
}
