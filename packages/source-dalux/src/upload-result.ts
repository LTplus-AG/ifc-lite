/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Turns a finalized Dalux upload into the contract's file and revision (#9522). */

import type { SourceFile, SourceRevision } from '@ifc-lite/plugin-api';

import type { DaluxFile } from './dalux-types.js';
import { currentRevisionId, LATEST_REVISION, nonEmptyString, toSourceFile } from './mapping.js';

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

export function uploadedFile(
  where: { fileAreaId: string; destinationFolderId: string | undefined },
  finalized: DaluxFile,
  sizeBytes: number,
): { file: SourceFile; revision: SourceRevision | null } {
  // A later lookup can observe another writer's revision. Finalize is the
  // only response tied to this write.
  const created = nonEmptyString(finalized.folderId)
    ? finalized
    : { ...finalized, folderId: where.destinationFolderId };
  return { file: toSourceFile(where.fileAreaId, created), revision: toSourceRevision(created, sizeBytes) };
}
