/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// ============================================================================
// Mapping a pinned version-set row onto the 2.0 `SourceRevision` surface.
//
// Split out of `commit-methods.ts` for the module-size rule. The seam is a
// real one: `SourceCommit` and `SourceRevision` are two different contracts
// over the same Dalux rows, and this file owns the second one — including
// the fact that it sorts by a different key, which is the part most likely
// to look like a bug to someone reading only one of the two.
// ============================================================================

import type { SourceRevision } from '@ifc-lite/plugin-api';

import type { DaluxModelCommit } from './commit-index.js';
import { nonEmptyString, orUndefined } from './mapping.js';
import { commitTimestamp } from './version-sets.js';

/**
 * `SourceCommit.createdAt` is required, so an undated revision still needs a
 * value. The epoch reads as "older than everything real", which is where
 * `newestFirst` already sorts it — a fabricated recent date would put an
 * undated row at the TOP of the timeline and have it mistaken for the head.
 */
export const UNDATED = new Date(0).toISOString();

/**
 * One pinned revision as a `SourceRevision`, for the 2.0 file-browser
 * surface.
 *
 * The SAME rows `toSourceCommit` maps, deliberately: both are derived from
 * one `DaluxModelCommit`, and `label` reuses {@link commitMessage} so the
 * file browser's version list and the History panel can never describe the
 * same revision differently — which, since both are on screen in the same
 * app, is the kind of divergence a user reads as a bug.
 *
 * The revision NUMBER leads when Dalux gave one, because that is what a
 * coordinator says out loud ("we're on rev 4"), with the package name after
 * it for the context the number alone lacks.
 */
/**
 * The commit message: the version set(s) that pin this revision.
 *
 * A Dalux revision has no commit message of its own — the nearest thing is
 * what the team called the package it went into, which is exactly the label
 * a coordinator recognises ("Coordination round 14"). Several sets pinning
 * one revision are all named, because dropping the others would hide that
 * this same file went into several packages.
 */
export function commitMessage(commit: DaluxModelCommit): string {
  const names = commit.versionSets.map((set) => set.name);
  return names.length <= 1 ? names[0] ?? '' : `${names[0]} (also in ${names.slice(1).join(', ')})`;
}

export function toSourceRevision(commit: DaluxModelCommit): SourceRevision {
  const message = commitMessage(commit);
  const number = commit.revisionNumber !== undefined ? `Rev ${commit.revisionNumber}` : undefined;
  const label = number && message ? `${number} · ${message}` : number ?? message;
  return {
    id: commit.revisionId,
    // Never empty: the revision id is the last resort, and a row without one
    // is dropped before it reaches the index at all.
    label: label || commit.revisionId,
    createdAt: commitTimestamp(commit.file) ?? UNDATED,
    ...(nonEmptyString(commit.file.lastModifiedByUserId ?? commit.file.uploadedByUserId) !== undefined
      ? { createdBy: (commit.file.lastModifiedByUserId ?? commit.file.uploadedByUserId)! }
      : {}),
    ...(orUndefined(commit.file.fileSize) !== undefined ? { sizeBytes: commit.file.fileSize! } : {}),
  };
}

/**
 * Newest first BY DATE, with undated rows last.
 *
 * Deliberately a different primary key from `newestFirst` in
 * `commit-index.ts`, which trusts Dalux's revision NUMBER first. Both are
 * right for their surface:
 *
 *  - The History panel needs a total order it can hang a parent chain off
 *    (`parents: [commits[i + 1].revisionId]`), and the revision number is
 *    unambiguous by construction where a timestamp can be missing or echo
 *    the file's current metadata.
 *  - This list is read as a timeline — "which package went out when" — so
 *    the DATE is what the reader is comparing, and a row sorted away from
 *    its own date reads as a bug even when the numbering justifies it.
 *
 * They coincide for every well-behaved file, since `version` IS the revision
 * number for shared and published areas. The revision number stays as the
 * tiebreaker so same-day revisions still read in issue order rather than
 * arbitrarily, and the id is the final tiebreaker so the order is total and
 * does not shuffle between loads.
 */
export function newestByDate(a: DaluxModelCommit, b: DaluxModelCommit): number {
  const aTime = Date.parse(commitTimestamp(a.file) ?? '');
  const bTime = Date.parse(commitTimestamp(b.file) ?? '');
  const aValid = Number.isFinite(aTime);
  const bValid = Number.isFinite(bTime);
  // Undated sinks rather than sorting as epoch 0 at one end or
  // NaN-poisoning every comparison it takes part in.
  if (aValid !== bValid) return aValid ? -1 : 1;
  if (aValid && bValid && aTime !== bTime) return bTime - aTime;
  if (a.revisionNumber !== undefined && b.revisionNumber !== undefined && a.revisionNumber !== b.revisionNumber) {
    return b.revisionNumber - a.revisionNumber;
  }
  return a.revisionId < b.revisionId ? 1 : a.revisionId > b.revisionId ? -1 : 0;
}
