/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Version-set history plus the current file revision, for the Versions panel. */
import type { ListOptions, Page, SourceFileRef, SourceRevision } from '@ifc-lite/plugin-api';
import { getCommitIndex, type DaluxModelCommit } from './commit-index.js';
import { decodeFileResponse } from './dalux-types.js';
import type { BrowserDaluxApiClient } from './http-client.js';
import { decodeContainerId, enc, nonEmptyString } from './mapping.js';
import { toSourceRevision } from './revision-mapping.js';

/** Histories share one project sweep; current metadata is read afresh each time.
 * Incomplete sweeps reject so the host displays an error, never a partial success. */
export async function listVersionSetRevisions(
  client: BrowserDaluxApiClient,
  ref: SourceFileRef,
  options?: ListOptions,
): Promise<Page<SourceRevision>> {
  const { fileAreaId } = decodeContainerId(ref.containerId);
  const [index, response] = await Promise.all([
    getCommitIndex(client, ref.projectId, options?.signal),
    client.get(`/5.0/projects/${enc(ref.projectId)}/file_areas/${enc(fileAreaId)}/files/${enc(ref.fileId)}`, {}, options?.signal),
  ]);
  if (index.truncated) throw new Error('Revision history is unavailable for projects with more than 250 version sets; no partial history is shown.');
  if (index.partial) throw new Error('Revision history is incomplete because some version sets could not be read. Please retry.');
  const file = decodeFileResponse(response).data;
  const revisionId = nonEmptyString(file.fileRevisionId);
  if (!revisionId) throw new Error('Dalux did not supply an ID for the current file revision.');
  const commits = index.models.get(ref.fileId)?.commits ?? [];
  const pinnedCurrent = commits.find((commit) => commit.revisionId === revisionId);
  const current: DaluxModelCommit = { ...pinnedCurrent, revisionId, file, fileAreaId, versionSets: pinnedCurrent?.versionSets ?? [], sweepIndex: pinnedCurrent?.sweepIndex ?? -1 };
  // The current file is authoritative even when no coordination set pins it.
  return { items: [current, ...commits.filter((commit) => commit.revisionId !== revisionId)].map(toSourceRevision) };
}
