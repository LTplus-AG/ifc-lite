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
 *
 * Storage: one entry per path in a dedicated top-level `Y.Map`
 * (`TOP.OVERLAY_TOMBSTONES`, see `doc/schema.ts`), value `true` (tombstoned)
 * or `false` (explicitly revived). Two concurrent `applyIfcxOverlay` calls
 * that tombstone *different* paths now touch different map keys and both
 * survive the merge; only two calls opining on the *same* path race, which
 * is an ordinary, expected last-write-wins conflict on that path.
 *
 * This used to be a single JSON array under one `meta` key
 * (`overlay.tombstonedPaths`), read-modify-written whole on every call. Two
 * concurrent calls tombstoning different paths each overwrote the other's
 * array wholesale, and Yjs resolved the single key last-write-wins:
 * whichever call's array landed last silently discarded the other's path,
 * even though both peers converged (to the same, wrong, answer). See the
 * regression test `two concurrent overlay calls tombstoning different
 * paths both survive the merge`.
 *
 * Migration: `readOverlayTombstones` still folds in that legacy array so a
 * doc written before this change keeps blocking resurrection for the
 * paths it already recorded — ignoring it would itself cause the
 * resurrection this bookkeeping exists to prevent. The legacy key is only
 * ever read, never written, from this point on: an explicit per-path
 * `false` (recorded by `writeOverlayTombstone`) permanently overrides a
 * stale legacy entry for that path, since the per-path map is applied
 * after folding in the legacy array. This is a one-way, forward
 * migration: it does not support a not-yet-upgraded peer and an upgraded
 * peer concurrently editing the same room (the old peer only ever sees
 * the array, which stops being written).
 */

import type * as Y from 'yjs';
import { TOP, metaMap } from '../doc/schema.js';

const OVERLAY_TOMBSTONES_META_KEY = 'overlay.tombstonedPaths';

/**
 * The per-path registry. A ROOT-level shared type on purpose: Yjs looks a
 * root type up by name and merges it structurally, so two peers that both
 * create it concurrently land on one map. A `Y.Map` nested under a `meta`
 * key would be an LWW value that merely looks structural — two peers each
 * lazily creating it would race exactly like the old single array did.
 */
function registry(doc: Y.Doc): Y.Map<boolean> {
  return doc.getMap<boolean>(TOP.OVERLAY_TOMBSTONES);
}

/**
 * Read the effective set of paths a previous `applyIfcxOverlay` call left
 * deleted: the legacy array (if the doc predates the per-path registry)
 * merged with the per-path registry, where a per-path entry always wins
 * over the legacy array for that path.
 */
export function readOverlayTombstones(doc: Y.Doc): Set<string> {
  const tombstones = new Set<string>();
  const legacy = metaMap(doc).get(OVERLAY_TOMBSTONES_META_KEY);
  if (Array.isArray(legacy)) {
    for (const path of legacy as string[]) tombstones.add(path);
  }
  registry(doc).forEach((tombstoned, path) => {
    if (tombstoned) tombstones.add(path);
    else tombstones.delete(path);
  });
  return tombstones;
}

/**
 * Record this call's final verdict for `path` in the per-path registry.
 * Deliberately writes a key (`true`/`false`), never `Y.Map.delete`: a
 * `false` is a persistent "explicitly revived" record that must keep
 * overriding a stale legacy-array entry for `path` (see module doc); a
 * deleted key would stop doing that as soon as it merged. `writeOverlayTombstone`
 * replaces the old whole-array `writeOverlayTombstones` — the caller writes
 * one path per call to the registry instead of read-modify-writing one
 * blob for every path it knows about.
 */
export function writeOverlayTombstone(doc: Y.Doc, path: string, deleted: boolean): void {
  registry(doc).set(path, deleted);
}

/** A snapshot reset starts a new entity universe, so prior overlay deletions
 * must not suppress a legitimate path in the freshly seeded snapshot. */
export function clearOverlayTombstones(doc: Y.Doc): void {
  metaMap(doc).delete(OVERLAY_TOMBSTONES_META_KEY);
  registry(doc).clear();
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
