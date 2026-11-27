/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Turns a finalized Dalux upload into the contract's file and revision (#9522). */

import type { PluginContext, SourceFile, SourceRevision } from '@ifc-lite/plugin-api';

import { decodeFileResponse } from './dalux-types.js';
import type { DaluxFile } from './dalux-types.js';
import type { BrowserDaluxApiClient } from './http-client.js';
import { currentRevisionId, enc, LATEST_REVISION, nonEmptyString, toSourceFile } from './mapping.js';

/** A read-back the user can no longer cancel still must not hang the save. */
const READ_BACK_TIMEOUT_MS = 15_000;

type RevisionIdentity = Pick<DaluxFile, 'fileRevisionId' | 'contentHash'>;

function hasChangedRevision(previous: RevisionIdentity, fresh: RevisionIdentity): boolean {
  const previousId = nonEmptyString(previous.fileRevisionId);
  const freshId = nonEmptyString(fresh.fileRevisionId);
  if (previousId && freshId) return previousId !== freshId;
  const previousHash = nonEmptyString(previous.contentHash);
  const freshHash = nonEmptyString(fresh.contentHash);
  return !!previousHash && !!freshHash && previousHash !== freshHash;
}

function toSourceRevision(file: DaluxFile, sizeBytes: number): SourceRevision | null {
  const id = currentRevisionId(file);
  if (id === LATEST_REVISION) return null;
  return {
    id,
    label: file.version ?? id,
    // Dalux reports date-only strings; an upload that just happened is "now".
    createdAt: new Date().toISOString(),
    // Dalux gives only a raw user id here; like revision-mapping.ts, do not show it as a name.
    sizeBytes: file.fileSize ?? sizeBytes,
  };
}

export async function uploadedFile(
  ctx: PluginContext,
  client: BrowserDaluxApiClient,
  where: { projectId: string; fileAreaId: string; destinationFolderId: string | undefined },
  finalized: DaluxFile,
  sizeBytes: number,
  previousRevision?: RevisionIdentity,
): Promise<{ file: SourceFile; revision: SourceRevision | null }> {
  let created = finalized;
  // A response without a revision identity would bind the model to the
  // no-revision sentinel, which a later new version cannot verify. Read the
  // file once more. The write has landed, so a cancel no longer applies and a
  // failure here leaves the committed upload without a verified revision.
  if (currentRevisionId(created) === LATEST_REVISION) {
    try {
      const fresh = decodeFileResponse(await client.get(
        `/5.0/projects/${enc(where.projectId)}/file_areas/${enc(where.fileAreaId)}/files/${enc(created.fileId)}`, {}, AbortSignal.timeout(READ_BACK_TIMEOUT_MS),
      )).data;
      // A new-version lookup can still serve the preceding revision. Compare
      // identities of the same kind before adopting the read-back metadata.
      if (!previousRevision || hasChangedRevision(previousRevision, fresh)) {
        created = { ...created, fileRevisionId: fresh.fileRevisionId, contentHash: fresh.contentHash };
      }
    } catch (err) {
      ctx.log.warn('Dalux: could not read the uploaded file\'s revision', { error: err instanceof Error ? err.message : String(err) });
    }
  }
  // Without this a response lacking folderId would file the result under the
  // area root, which write-back then refuses as a destination.
  if (!nonEmptyString(created.folderId)) created = { ...created, folderId: where.destinationFolderId };
  return { file: toSourceFile(where.fileAreaId, created), revision: toSourceRevision(created, sizeBytes) };
}
