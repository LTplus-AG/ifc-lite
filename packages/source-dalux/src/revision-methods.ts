/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// ============================================================================
// `DaluxBuildProvider.listRevisions`, split out of `provider.ts` for the
// module-size rule.
//
// Dalux has no endpoint that lists a file's revisions directly — only
// "fetch this exact revision's content" if you already have its id. What it
// has is version sets: `GET /2.1/projects/{p}/version_sets` plus
// `GET /3.0/.../version_sets/{vs}/files` enumerate every revision a
// project's snapshots pinned, and sweeping them (`commit-index.ts`)
// reconstructs every file's history from that. This is the one place that
// sweep is turned into the plugin API's `listRevisions` surface, which is
// what lets the viewer's file-browser "Versions" panel
// (`SourceResourceDetails.tsx`) show it: it already calls
// `provider.listRevisions` when present and shows "no versions" when it
// isn't, which is what every Dalux file read until now.
// ============================================================================

import type { ListOptions, Page, SourceFileRef, SourceRevision } from '@ifc-lite/plugin-api';

import { getCommitIndex } from './commit-index.js';
import type { BrowserDaluxApiClient } from './http-client.js';
import { newestByDate, toSourceRevision } from './revision-mapping.js';

/**
 * The file's revisions, newest first.
 *
 * Shares `getCommitIndex`'s per-project sweep and cache with every other
 * call against the same project, so opening "Versions" on several files (or
 * reopening one) does not re-sweep the project's version sets each time.
 *
 * A file in no version set returns an empty page rather than throwing:
 * "this file is in no coordination package" is an answer, not an error —
 * the same reason a file with zero revisions isn't an error elsewhere in
 * this contract.
 *
 * Not paged against the server: the index is already in memory, and Dalux
 * has no endpoint that pages revisions. A single page with no cursor is the
 * honest answer — a synthetic cursor would make the host believe it was
 * streaming when it was slicing an array it already had.
 */
export async function listVersionSetRevisions(
  client: BrowserDaluxApiClient,
  ref: SourceFileRef,
  options?: ListOptions,
): Promise<Page<SourceRevision>> {
  const index = await getCommitIndex(client, ref.projectId, options?.signal);
  const history = index.models.get(ref.fileId);
  if (!history) return { items: [] };

  // Sorted here rather than relying on the index's internal order: that one
  // is revision-number-first (the ordering `commit-index.ts` itself needs
  // for its parent chain), and this list is read as a dated timeline. See
  // `newestByDate`.
  return { items: [...history.commits].sort(newestByDate).map(toSourceRevision) };
}
