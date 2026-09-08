/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Cross-call tombstone bookkeeping for `applyIfcxOverlay` (`from-ifcx.ts`).
 *
 * `deleteEntity` purges a path from `entitiesMap` entirely, so once one
 * `applyIfcxOverlay` call's transaction ends there is nothing left on the
 * doc distinguishing "deleted, no opinion stated since" from "never
 * existed". Without this, a later, separate call touching the same path
 * with no deletion opinion of its own reads `hasEntity() === false` as
 * "brand new" and silently resurrects the entity — losing the deletion.
 * This mirrors the "false is the revert opinion, omission is not"
 * contract `applyIfcxOverlay` already enforces *within* one file, across
 * calls instead: a path stays deleted until a later layer explicitly
 * revives it. See `test/apply-ifcx-overlay.test.ts`.
 */

import type * as Y from 'yjs';

const OVERLAY_TOMBSTONES_META_KEY = 'overlay.tombstonedPaths';

/** Read the set of paths a previous `applyIfcxOverlay` call left deleted. */
export function readOverlayTombstones(meta: Y.Map<unknown>): Set<string> {
  const stored = meta.get(OVERLAY_TOMBSTONES_META_KEY);
  return new Set(Array.isArray(stored) ? (stored as string[]) : []);
}

/** Persist the updated tombstone set back onto the doc's meta map. */
export function writeOverlayTombstones(meta: Y.Map<unknown>, tombstones: Set<string>): void {
  meta.set(OVERLAY_TOMBSTONES_META_KEY, Array.from(tombstones));
}

/** A snapshot reset starts a new entity universe, so prior overlay deletions
 * must not suppress a legitimate path in the freshly seeded snapshot. */
export function clearOverlayTombstones(meta: Y.Map<unknown>): void {
  meta.delete(OVERLAY_TOMBSTONES_META_KEY);
}

/**
 * True when a node touching `path` with no opinion on deletion (`opinion
 * === undefined`) must NOT resurrect it, because an earlier call left it
 * tombstoned. An explicit opinion (revive with `false`, or a no-op
 * re-delete with `true`) always acts, so this only ever gates the
 * no-opinion case.
 */
export function resurrectionBlocked(
  tombstones: Set<string>,
  path: string,
  opinion: boolean | undefined,
): boolean {
  return opinion === undefined && tombstones.has(path);
}

/** Apply this file's final tombstone verdict for `path` to the running set. */
export function resolveTombstoneOpinion(tombstones: Set<string>, path: string, deleted: boolean): void {
  if (deleted) tombstones.add(path);
  else tombstones.delete(path);
}
