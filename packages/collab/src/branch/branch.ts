/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Branching (spec §12.4 — v0.7 starter).
 *
 * `forkSession(parent, opts)` — snapshot the parent Y.Doc, seed a new
 * Y.Doc with the snapshot, and wrap it as a fresh `CollabSession`. The
 * branch carries `meta.parentRoomId` + `meta.branchName` for round-trip
 * tooling.
 *
 * `mergeBranch(parent, branch, strategy)` — bring the branch's edits
 * back. Two strategies ship in v0.7:
 *   - `'ops'`   : encode the branch's full state as a Y update and
 *                 `applyUpdate` it into the parent. Works for any pair
 *                 of CRDT docs; concurrent parent edits LWW-merge with
 *                 the branch's edits per Yjs semantics.
 *   - `'layer'` : extract the branch contents as an IFCX layer and
 *                 apply it over the parent as a layer of opinions.
 *                 Useful when the branch was edited by tools that only
 *                 speak IFCX, not the live Y.Doc.
 *
 * The proper differential layer composer lands later in v0.7 — for now
 * `'layer'` produces a snapshot-of-branch layer, which is the same
 * trade-off documented in `snapshot/layers.ts`.
 */

import * as Y from 'yjs';
import {
  createCollabSession,
  type CollabSession,
  type CollabSessionOptions,
} from '../session.js';
import { entitiesMap, metaMap } from '../doc/schema.js';
import { snapshotToIfcx } from '../snapshot/to-ifcx.js';
import { applyIfcxOverlay } from '../snapshot/from-ifcx.js';

export interface ForkOptions {
  /** New room id for the branch. Defaults to `<parent.roomId>/branches/<name>`. */
  roomId?: string;
  /** Branch name; stored in branch's meta for UI. */
  name: string;
  /** Override the user identity on the branch session. Defaults to parent's. */
  user?: CollabSessionOptions['user'];
  /** Provider for the branch (default: parent's provider). */
  provider?: CollabSessionOptions['provider'];
  /** Forwarded to the new session. */
  serverUrl?: CollabSessionOptions['serverUrl'];
  token?: CollabSessionOptions['token'];
  WebSocketPolyfill?: CollabSessionOptions['WebSocketPolyfill'];
}

export interface BranchSession {
  readonly session: CollabSession;
  readonly parentRoomId: string;
  readonly branchName: string;
}

const META_PARENT = 'branch.parentRoomId';
const META_NAME = 'branch.name';
const META_FORKED_AT = 'branch.forkedAt';
/**
 * The parent's Yjs state vector at fork time, stored IN the branch doc
 * (#5216). The branch doc is a replica of the parent at that point, so an
 * item whose id this vector covers existed at fork, and one it does not was
 * written after. Persisting it in the doc, not in process memory, is the
 * point: the fork-time view must survive a reload, a second tab, or a merge
 * job rebuilding the session from persistence (a `WeakMap` keyed by the
 * original `Y.Doc` object missed on every one of those). Written once at
 * fork and never again, so the single meta key cannot race.
 */
const META_FORK_STATE = 'branch.forkStateVector';

export async function forkSession(
  parent: CollabSession,
  opts: ForkOptions,
): Promise<BranchSession> {
  // 1. Snapshot the parent Y.Doc as a binary update.
  const update = Y.encodeStateAsUpdate(parent.doc);

  // 2. Build the branch session.
  const branchRoomId = opts.roomId ?? `${parent.roomId}/branches/${opts.name}`;
  const branchUser = opts.user ?? parent.presence.getSelf()?.user ?? {
    id: 'forker',
    name: 'forker',
  };
  const branch = await createCollabSession({
    roomId: branchRoomId,
    user: branchUser,
    provider: opts.provider ?? parent.provider,
    serverUrl: opts.serverUrl,
    token: opts.token,
    WebSocketPolyfill: opts.WebSocketPolyfill,
  });

  // 3. Seed the branch doc with the parent state, then stamp branch metadata.
  Y.applyUpdate(branch.doc, update, { source: 'fork', parentRoomId: parent.roomId });
  branch.transact(() => {
    const meta = metaMap(branch.doc);
    meta.set(META_FORK_STATE, Y.encodeStateVectorFromUpdate(update));
    meta.set(META_PARENT, parent.roomId);
    meta.set(META_NAME, opts.name);
    meta.set(META_FORKED_AT, new Date().toISOString());
  });

  return {
    session: branch,
    parentRoomId: parent.roomId,
    branchName: opts.name,
  };
}

export type MergeStrategy = 'ops' | 'layer';

export interface MergeReport {
  strategy: MergeStrategy;
  /** Bytes of the merged update payload. */
  bytes: number;
  /** ISO timestamp of when the merge transaction landed on `parent`. */
  mergedAt: string;
  /**
   * Count of entities the `'layer'` strategy could not remove from
   * `parent` even though `branch` deleted them before merge. An IFCX
   * snapshot of the branch (see below) emits only what an entity has, so
   * a branch-side deletion is indistinguishable on the wire from "no
   * opinion" — `applyIfcxOverlay` therefore leaves the parent's copy of
   * that entity untouched. Always `0` for the `'ops'` strategy, which
   * applies the branch's Y update directly and propagates deletions like
   * any other Yjs change.
   *
   * `null` when the branch doc carries no fork record: it was forked by a
   * version that predates the persisted fork state (#5216). Without that
   * record, `'layer'` can neither count dropped deletions NOR keep the
   * merge from recreating entities the parent deleted after the fork, so
   * `null` also means "parent-side deletions were not protected". It never
   * means zero.
   */
  droppedDeletions: number | null;
}

/**
 * Merge `branch` back into `parent`. Returns a small report.
 *
 * The branch session is NOT disposed by this call — the caller decides
 * whether to keep it around (e.g. for diff inspection) or `dispose()`
 * it after merge.
 */
export function mergeBranch(
  parent: CollabSession,
  branch: BranchSession,
  strategy: MergeStrategy = 'ops',
): MergeReport {
  if (strategy === 'ops') {
    const update = Y.encodeStateAsUpdate(branch.session.doc);
    Y.applyUpdate(parent.doc, update, {
      source: 'merge-branch',
      branchName: branch.branchName,
    });
    return {
      strategy,
      bytes: update.byteLength,
      mergedAt: new Date().toISOString(),
      droppedDeletions: 0,
    };
  }

  // 'layer' strategy: snapshot the branch as IFCX, then apply it to the
  // parent as a layer of opinions. `seedFromIfcx` cannot do this job —
  // its `createEntity` no-ops on a path the doc already has, and since a
  // branch forks from its parent, essentially every entity the branch
  // *modified* is already there, so seeding landed only the branch's
  // brand-new entities and dropped every edit. Regression coverage lives
  // in test/branch-merge-layer-overlay.test.ts.
  //
  // `applyIfcxOverlay` creates what is missing and writes the branch's
  // opinions on top of what is not, leaving parent state the branch
  // snapshot says nothing about untouched. Deletions made on the branch
  // still do not propagate: an IFCX snapshot emits only what an entity
  // has, so a removal is indistinguishable from "no opinion" on the wire.
  //
  // Both directions of deletion are judged against the fork state the
  // branch doc recorded (`META_FORK_STATE`), per top-level entity item:
  //   - dropped (branch deleted it, parent still has it): the parent's
  //     item predates the fork — so the branch had it — and the branch
  //     no longer does. A parent entity created after the fork is not
  //     counted, since the branch never had it.
  //   - resurrection (parent deleted it, branch never re-created it): the
  //     snapshot carries every entity the branch still has, touched or
  //     not, and `applyIfcxOverlay` creates whatever the parent lacks. A
  //     node is dropped when the parent lacks its path and the branch's
  //     item for it predates the fork, i.e. it is the fork-inherited
  //     entity, not one the branch created or re-created after. The
  //     parent's deletion wins even over branch edits INSIDE that entity,
  //     matching the 'ops' strategy, where a nested edit under a deleted
  //     map entry is deleted with it.
  const fork = forkStateOf(branch.session.doc);
  const parentEntities = entitiesMap(parent.doc);
  const branchEntities = entitiesMap(branch.session.doc);
  let droppedDeletions: number | null = null;
  const ifcx = snapshotToIfcx(branch.session.doc);
  if (fork) {
    droppedDeletions = 0;
    for (const path of parentEntities.keys()) {
      if (existedAtFork(parentEntities, path, fork) && !branchEntities.has(path)) droppedDeletions++;
    }
    ifcx.data = ifcx.data.filter((node) =>
      parentEntities.has(node.path) || !existedAtFork(branchEntities, node.path, fork));
  }

  const before = Y.encodeStateAsUpdate(parent.doc);
  applyIfcxOverlay(parent.doc, ifcx);
  const after = Y.encodeStateAsUpdate(parent.doc);
  return {
    strategy,
    bytes: Math.max(0, after.byteLength - before.byteLength),
    mergedAt: new Date().toISOString(),
    droppedDeletions,
  };
}

/** The fork-time state vector a branch doc recorded, or `null` if it has none. */
function forkStateOf(doc: Y.Doc): Map<number, number> | null {
  const sv = metaMap(doc).get(META_FORK_STATE);
  return sv instanceof Uint8Array ? Y.decodeStateVector(sv) : null;
}

/** Whether `map`'s live entry for `key` was written before the fork. */
function existedAtFork<T>(map: Y.Map<T>, key: string, fork: Map<number, number>): boolean {
  const item = map._map.get(key);
  return item !== undefined && !item.deleted && item.id.clock < (fork.get(item.id.client) ?? 0);
}

/** Read branch metadata back off a session's Y.Doc. */
export function readBranchMeta(
  session: CollabSession,
): { parentRoomId?: string; branchName?: string; forkedAt?: string } {
  const meta = metaMap(session.doc);
  return {
    parentRoomId: meta.get(META_PARENT) as string | undefined,
    branchName: meta.get(META_NAME) as string | undefined,
    forkedAt: meta.get(META_FORKED_AT) as string | undefined,
  };
}
