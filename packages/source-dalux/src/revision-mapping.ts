/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Display one pinned or current file revision using the existing plugin API. */
import type { SourceRevision } from '@ifc-lite/plugin-api';
import type { DaluxModelCommit } from './commit-index.js';
import { nonEmptyString, orUndefined } from './mapping.js';
import { commitTimestamp } from './version-sets.js';

/** Names of the coordination packages that pin this revision. */
export function commitMessage(commit: DaluxModelCommit): string {
  const names = commit.versionSets.map((set) => set.name);
  return names.length <= 1 ? names[0] ?? '' : `${names[0]} (also in ${names.slice(1).join(', ')})`;
}

export function toSourceRevision(commit: DaluxModelCommit): SourceRevision {
  const message = commitMessage(commit);
  const version = nonEmptyString(commit.file.version);
  const number = version ? `Rev ${version}` : undefined;
  return {
    id: commit.revisionId,
    label: number && message ? `${number} · ${message}` : number ?? (message || commit.revisionId),
    // Empty means unknown to the existing host, which omits an absent date.
    createdAt: commitTimestamp(commit.file) ?? '',
    // The API only supplies raw user IDs here; do not render them as names.
    ...(orUndefined(commit.file.fileSize) !== undefined ? { sizeBytes: commit.file.fileSize! } : {}),
  };
}
