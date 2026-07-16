/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { DaluxFile } from 'dalux-build-api/src/models/files/index.js';
import type { SourceFile, SourceRevision } from '@ifc-lite/plugin-api';

export function toSourceFile(fileAreaId: string, file: DaluxFile): SourceFile {
  const currentRevisionId = file.fileRevisionId ?? file.fileId;
  const folderId = nonEmptyString(file.folderId);

  const revision: SourceRevision = {
    id: currentRevisionId,
    version: file.version ? Number(file.version) || 1 : 1,
    createdAt: file.lastModified ?? file.uploaded ?? new Date(0).toISOString(),
    createdBy: orUndefined(file.lastModifiedByUserId ?? file.uploadedByUserId),
    sizeBytes: orUndefined(file.fileSize),
  };

  return {
    id: file.fileId,
    name: file.fileName,
    // A file's real container is whichever folder it's actually filed under
    // — not the container the caller happened to query — falling back to
    // the file area root only when it has no folder at all.
    containerId: folderId ?? fileAreaId,
    mimeType: orUndefined(file.fileType),
    sizeBytes: orUndefined(file.fileSize),
    currentRevisionId,
    revisions: [revision],
    meta: {
      fileAreaId,
      folderId,
    },
  };
}

export function enc(segment: string): string {
  return encodeURIComponent(segment);
}

export function orUndefined<T>(value: T | null | undefined): T | undefined {
  return value ?? undefined;
}

export function nonEmptyString(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function matchGlob(pattern: string, name: string): boolean {
  const re = new RegExp(
    '^' +
      pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.') +
      '$',
    'i',
  );
  return re.test(name);
}
