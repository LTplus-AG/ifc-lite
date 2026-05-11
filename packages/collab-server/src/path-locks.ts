/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Per-section / per-path write locks (spec §8.2 — open problem #7).
 *
 * Granular locks beyond role-based gating: an admin can declare that
 * specific entity-path prefixes (or relationship/geometry paths) are
 * temporarily read-only — e.g. "MEP coordination is in review, no
 * structural changes." The server inspects each incoming Y update,
 * decodes the affected paths, and rejects writes that touch any
 * locked prefix.
 *
 * The lock policy is path-prefix matching: a lock on
 * `proj/arch/storey-1/` blocks writes to any entity whose path starts
 * with that prefix. Locks may also exempt specific principals (e.g.
 * the locking admin can still edit) via `exemptUserIds` /
 * `exemptRoles`.
 *
 * Implementation note: we don't decode the entire Y update wire
 * format here — instead, we run the update through a throwaway Y.Doc
 * to reuse Yjs's parser, then walk the resulting tr.changed map to
 * harvest paths. That's O(update_size) but only runs on writes from
 * non-exempt principals.
 */

import * as Y from 'yjs';
import type { Principal, Role } from './auth.js';
import type { VerifyDecision, VerifyMessageFn, PeerConnection } from './room-manager.js';
import * as decoding from 'lib0/decoding';
import * as syncProtocol from 'y-protocols/sync';

export interface PathLock {
  /** Prefix that triggers this lock. Either `entities/<path-prefix>` or `geometry/<id-prefix>` etc. */
  prefix: string;
  /** Optional human-readable label for audit logs. */
  label?: string;
  /** Allow these userIds to bypass the lock. */
  exemptUserIds?: ReadonlySet<string>;
  /** Allow these roles to bypass the lock (e.g. the admin that placed it). */
  exemptRoles?: ReadonlySet<Role>;
}

export interface PathLockRegistry {
  /** Snapshot of currently-active locks. */
  list(): readonly PathLock[];
  /** Add a lock. Returns the lock for the caller to keep a reference to. */
  add(lock: PathLock): PathLock;
  /** Remove a previously-added lock. */
  remove(lock: PathLock): boolean;
  /** Drop every lock. */
  clear(): void;
  /** Returns the matching lock if `path` is locked AND `principal` is not exempt. */
  matches(path: string, principal: Principal): PathLock | null;
}

export function createPathLockRegistry(): PathLockRegistry {
  const locks: PathLock[] = [];

  return {
    list: () => [...locks],
    add(lock) {
      locks.push(lock);
      return lock;
    },
    remove(lock) {
      const idx = locks.indexOf(lock);
      if (idx < 0) return false;
      locks.splice(idx, 1);
      return true;
    },
    clear() {
      locks.length = 0;
    },
    matches(path, principal) {
      for (const lock of locks) {
        if (!path.startsWith(lock.prefix)) continue;
        if (lock.exemptUserIds?.has(principal.userId)) continue;
        if (lock.exemptRoles?.has(principal.role)) continue;
        return lock;
      }
      return null;
    },
  };
}

/**
 * Apply `update` to a throwaway Y.Doc and harvest the touched paths
 * as a list of `<top>/<key>` strings (`entities/wall`, `geometry/g1`,
 * etc.). Each top-level shared type the runtime knows about is
 * inspected.
 */
export function harvestUpdatePaths(update: Uint8Array): string[] {
  const tmp = new Y.Doc();
  tmp.getMap('entities');
  tmp.getMap('relationships');
  tmp.getMap('geometry');
  tmp.getMap('meta');

  const touched = new Set<string>();
  const onAfter = (tr: Y.Transaction) => {
    for (const [type, keys] of tr.changed.entries()) {
      let node: Y.AbstractType<unknown> | null = type as Y.AbstractType<unknown>;
      const basePath: string[] = [];
      while (node) {
        const item = (node as unknown as { _item?: { parent?: unknown; parentSub?: string | null } })._item;
        if (!item) {
          // Top-level: find its name.
          const name = topLevelKeyOf(node, tmp);
          if (name) basePath.unshift(name);
          break;
        }
        if (typeof item.parentSub === 'string') basePath.unshift(item.parentSub);
        node = item.parent as Y.AbstractType<unknown> | null;
      }
      if (basePath.length === 0) continue;
      // Always emit the base path itself …
      touched.add(basePath.join('/'));
      // … and every changed key under it (key === null means the
      // change is on a Y.Array's internal struct list — only the
      // base path is meaningful).
      for (const key of keys) {
        if (key === null) continue;
        touched.add([...basePath, key].join('/'));
      }
    }
  };
  tmp.on('afterTransaction', onAfter);
  Y.applyUpdate(tmp, update);
  tmp.off('afterTransaction', onAfter);
  tmp.destroy();
  return [...touched];
}

function topLevelKeyOf(type: Y.AbstractType<unknown>, doc: Y.Doc): string | null {
  for (const [name, shared] of doc.share) {
    if (shared === type) return name;
  }
  return null;
}

/**
 * Build a `VerifyMessageFn` that rejects sync-update messages whose
 * harvested paths intersect a locked prefix (and whose principal
 * isn't exempt). Pass-through for non-update frames.
 */
export function verifyAgainstPathLocks(registry: PathLockRegistry): VerifyMessageFn {
  return (msg: Uint8Array, conn: PeerConnection): VerifyDecision => {
    if (msg.byteLength === 0) return { ok: true };
    // Outer envelope is the y-protocols sync frame: [varint type][...].
    const decoder = decoding.createDecoder(msg);
    let outerType: number;
    try {
      outerType = decoding.readVarUint(decoder);
    } catch {
      // Malformed envelope: pass through. The frame can't apply anything
      // to the doc, so room-manager's own readSyncMessage will swallow
      // it without side effects.
      return { ok: true };
    }
    // Outer 0 = sync; inner 0/1/2 = step1/step2/update.
    if (outerType !== 0) return { ok: true };
    let inner: number;
    try {
      inner = decoding.readVarUint(decoder);
    } catch {
      return { ok: true };
    }
    // Both messageYjsSyncStep2 and messageYjsUpdate carry a Yjs binary
    // update payload that readSyncMessage applies to the doc as a side
    // effect — they must both go through path-lock checking. Step1 is
    // pure read intent and is exempt.
    const isWriteFrame =
      inner === syncProtocol.messageYjsUpdate ||
      inner === syncProtocol.messageYjsSyncStep2;
    if (!isWriteFrame) return { ok: true };

    let payload: Uint8Array;
    try {
      payload = decoding.readVarUint8Array(decoder);
    } catch {
      // A write-frame with an unreadable payload is suspicious — fail
      // closed rather than waving the message through to the doc.
      return { ok: false, reason: 'malformed-update-payload' };
    }
    const paths = harvestUpdatePaths(payload);
    for (const p of paths) {
      const hit = registry.matches(p, conn.principal);
      if (hit) {
        return { ok: false, reason: `locked:${hit.label ?? hit.prefix}` };
      }
    }
    return { ok: true };
  };
}
