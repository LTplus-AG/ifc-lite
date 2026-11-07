/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { matchesGlob, type FileFilter, type SourceFile } from '@ifc-lite/plugin-api';
import type { Document } from './types.js';
export function modelFile(document: Document, containerId: string, filter?: FileFilter): SourceFile | undefined {
  const version = document.latestVersion;
  const name = version?.fileName ?? '';
  if (!version || document.archived || document.confidential || !/\.(ifc|ifczip|ifcxml|ifcx)$/i.test(name)) return;
  if (filter?.namePatterns?.length && !filter.namePatterns.some(pattern => matchesGlob(name, pattern))) return;
  return {
    id: document.documentId, name, containerId, currentRevisionId: version.documentVersionId,
    modifiedAt: version.modifiedDate ?? document.modifiedDate ?? undefined,
    meta: { documentNumber: document.documentNumber, versionNumber: version.versionNumber },
  };
}
export function paging(cursor?: string, requested = 100): { offset: number; limit: number } {
  const offset = cursor === undefined ? 0 : Number(cursor);
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isFinite(requested)) throw new Error('Invalid BIMcollab paging options.');
  return { offset, limit: Math.max(1, Math.min(100, Math.floor(requested))) };
}
