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
 *                 re-seed the parent with parent + branch composed.
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
import { metaMap } from '../doc/schema.js';
import { snapshotToIfcx } from '../snapshot/to-ifcx.js';
import { seedFromIfcx } from '../snapshot/from-ifcx.js';

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
    };
  }

  // 'layer' strategy: snapshot the branch as IFCX, then re-seed the
  // parent with reset:false so existing parent state is preserved and
  // branch nodes overlay (composition is left to the caller's IFCX
  // layer stack — for now we fall back to "set everything we have").
  const ifcx = snapshotToIfcx(branch.session.doc);
  const before = Y.encodeStateAsUpdate(parent.doc);
  seedFromIfcx(parent.doc, ifcx, { reset: false });
  const after = Y.encodeStateAsUpdate(parent.doc);
  return {
    strategy,
    bytes: Math.max(0, after.byteLength - before.byteLength),
    mergedAt: new Date().toISOString(),
  };
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
