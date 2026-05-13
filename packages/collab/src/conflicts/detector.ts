/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Conflict detector.
 *
 * Observes Y.Doc transactions and emits structured events when concurrent
 * edits land on the same target within a tunable window. The viewer (or
 * any UI) listens to these events and renders a conflict badge plus an
 * optional ghost overlay (§9.4 / §9.7).
 *
 * The CRDT itself never blocks or rolls back on conflict — it converges
 * deterministically. Detection here is purely advisory: it tells the user
 * "your peer changed this at the same time."
 *
 * Implementation note: we use `Transaction.changed` (struct-level
 * changes) rather than `YEvent.keys` (head-level changes) because LWW
 * can keep the existing head value when a remote struct loses, in which
 * case `YEvent.keys` is empty even though there was a concurrent write.
 * The struct-level view is what we want for the conflict surface.
 */

import * as Y from 'yjs';
import {
  ENTITY_KEY,
  entitiesMap,
  geometryMap,
  GEOMETRY_KEY,
  relationshipsMap,
  RELATIONSHIP_KEY,
  TOP,
} from '../doc/schema.js';

export type ConflictKind =
  | 'attribute'
  | 'pset-property'
  | 'hierarchy'
  | 'geometry-blob'
  | 'geometry-param'
  | 'relationship-target'
  | 'concurrent-delete';

export interface ConflictEvent {
  kind: ConflictKind;
  /** Entity / relationship / geometry path involved. */
  path: string;
  /** Sub-path (e.g. attribute name, `pset.prop`, role). */
  field?: string;
  /** clientIDs that contributed conflicting writes within the window. */
  contributors: number[];
  /** Wall-clock ms when the detector first flagged this conflict. */
  detectedAt: number;
}

export type ConflictListener = (event: ConflictEvent) => void;

export interface ConflictDetectorOptions {
  /** Window in ms inside which two writes count as concurrent (default 750). */
  windowMs?: number;
}

export interface ConflictDetector {
  onConflict(listener: ConflictListener): () => void;
  /** All currently-active conflicts (cleared after `windowMs * 4`). */
  active(): ConflictEvent[];
  destroy(): void;
}

interface PendingWrite {
  client: number;
  at: number;
}

interface PathInfo {
  kind: ConflictKind;
  path: string;
  field?: string;
}

/**
 * Build a conflict detector for `doc`.
 *
 * Subscribes to `afterTransaction` and inspects `tr.changed`, which
 * reports every key whose underlying struct list changed (independent of
 * the head value). For each entry we resolve where in the tree the
 * change happened and classify it into one of `ConflictKind`s.
 */
export function createConflictDetector(
  doc: Y.Doc,
  options: ConflictDetectorOptions = {},
): ConflictDetector {
  const windowMs = options.windowMs ?? 750;
  const listeners = new Set<ConflictListener>();
  const conflicts: ConflictEvent[] = [];
  /** key = `${kind}|${path}|${field}` → recent writers. */
  const recentWrites = new Map<string, PendingWrite[]>();

  const flag = (info: PathInfo, writers: PendingWrite[]) => {
    const contributors = Array.from(new Set(writers.map((w) => w.client)));
    if (contributors.length < 2) return;
    const event: ConflictEvent = {
      kind: info.kind,
      path: info.path,
      field: info.field,
      contributors,
      detectedAt: Date.now(),
    };
    conflicts.push(event);
    listeners.forEach((l) => l(event));
  };

  const record = (info: PathInfo, client: number) => {
    if (client < 0) return;
    const key = `${info.kind}|${info.path}|${info.field ?? ''}`;
    const now = Date.now();
    const arr = (recentWrites.get(key) ?? []).filter((w) => now - w.at < windowMs);
    arr.push({ client, at: now });
    recentWrites.set(key, arr);
    if (arr.length >= 2) flag(info, arr);
  };

  const onAfterTransaction = (tr: Y.Transaction) => {
    if (tr.changed.size === 0) return;
    const client = tr.local ? doc.clientID : guessRemoteClient(tr);
    if (client < 0) return;

    for (const [type, keys] of tr.changed.entries()) {
      const top = topLevelKey(type);
      if (top !== TOP.ENTITIES && top !== TOP.RELATIONSHIPS && top !== TOP.GEOMETRY) continue;
      const path = pathFromTop(type);
      if (!path) continue;
      for (const key of keys) {
        // For top-level Y.Map changes the parent map's `has(key)` tells
        // us whether this was a delete (key absent → yes) or an add.
        // Only deletes count as conflict-inducing at the top level.
        const isDelete =
          path.length === 0 && key != null && !(type as unknown as Y.Map<unknown>).has(key);
        const info = classify(top, path, key, isDelete);
        if (info) record(info, client);
      }
    }

    const cutoff = Date.now() - windowMs * 4;
    while (conflicts.length > 0 && conflicts[0].detectedAt < cutoff) {
      conflicts.shift();
    }
  };

  doc.on('afterTransaction', onAfterTransaction);

  return {
    onConflict(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    active: () => [...conflicts],
    destroy() {
      doc.off('afterTransaction', onAfterTransaction);
      listeners.clear();
      conflicts.length = 0;
      recentWrites.clear();
    },
  };
}

/**
 * Resolve a changed Y.AbstractType's path from its top-level shared
 * type as a list of keys/indices. Keys at intermediate levels are
 * always strings — we only nest Y.Maps under named keys.
 */
function pathFromTop(type: Y.AbstractType<any>): string[] | null {
  const out: string[] = [];
  let node: Y.AbstractType<any> | null = type;
  while (node) {
    const item = (node as unknown as { _item?: { parent?: unknown; parentSub?: string | null } })._item;
    if (!item) break; // top-level
    const parentSub = item.parentSub;
    if (typeof parentSub !== 'string') return null; // array-indexed nesting; unsupported here
    out.unshift(parentSub);
    node = item.parent as Y.AbstractType<any> | null;
  }
  return out;
}

function topLevelKey(type: Y.AbstractType<any>): string | undefined {
  let node: Y.AbstractType<any> | null = type;
  while (node) {
    const item = (node as unknown as { _item?: { parent?: unknown } })._item;
    if (!item) {
      const doc = node.doc;
      if (!doc) return undefined;
      for (const [name, shared] of doc.share) {
        if (shared === node) return name;
      }
      return undefined;
    }
    node = item.parent as Y.AbstractType<any> | null;
  }
  return undefined;
}

/**
 * Map a (top, path[], key) triple to a ConflictKind + path + field.
 * `path` is the list of map keys descending from the top-level shared
 * type to the changed AbstractType. `key` is the changed leaf key (or
 * null for array-shaped changes). `isDelete` only matters at
 * `path.length === 0` (top-level entity churn).
 */
function classify(
  top: string,
  path: string[],
  key: string | null,
  isDelete: boolean,
): PathInfo | null {
  if (top === TOP.ENTITIES) {
    if (path.length === 0) {
      // Entity create OR delete on the top-level entities map. We only
      // surface deletes — concurrent creates are CRDT-friendly (both
      // entities coexist if they have different paths).
      if (isDelete && key) return { kind: 'concurrent-delete', path: key };
      return null;
    }
    const entityPath = path[0];
    if (path.length === 1) {
      // Change on the entity Y.Map itself; sub-key is `key` (e.g. the
      // attributes Y.Map being added/replaced). Not a leaf conflict.
      return null;
    }
    const subMap = path[1];
    if (path.length === 2) {
      switch (subMap) {
        case ENTITY_KEY.ATTRIBUTES:
          return key ? { kind: 'attribute', path: entityPath, field: key } : null;
        case ENTITY_KEY.CHILDREN:
          return key ? { kind: 'hierarchy', path: entityPath, field: key } : null;
        case ENTITY_KEY.PSETS:
          // A new (or replaced) Pset Y.Map at the entity level. Treat
          // the pset name as the field — useful when two peers seed the
          // same Pset concurrently.
          return key ? { kind: 'pset-property', path: entityPath, field: key } : null;
        default:
          return null;
      }
    }
    if (path.length === 3 && subMap === ENTITY_KEY.PSETS) {
      const psetName = path[2];
      return key
        ? { kind: 'pset-property', path: entityPath, field: `${psetName}.${key}` }
        : null;
    }
    return null;
  }

  if (top === TOP.GEOMETRY) {
    if (path.length === 0) {
      return null;
    }
    const geomId = path[0];
    if (path.length === 1) {
      // direct field on a geometry node
      if (key === GEOMETRY_KEY.BLOB_HASH) {
        return { kind: 'geometry-blob', path: geomId };
      }
      return null;
    }
    if (path.length === 2 && path[1] === GEOMETRY_KEY.PARAMS) {
      return key ? { kind: 'geometry-param', path: geomId, field: key } : null;
    }
    return null;
  }

  if (top === TOP.RELATIONSHIPS) {
    if (path.length === 0) {
      return null;
    }
    const relPath = path[0];
    if (path.length === 1 && key === RELATIONSHIP_KEY.TARGETS) {
      return { kind: 'relationship-target', path: relPath };
    }
    // Targets array changes: the Y.Array is at path=[relPath, 'targets']
    if (path.length === 2 && path[1] === RELATIONSHIP_KEY.TARGETS) {
      return { kind: 'relationship-target', path: relPath };
    }
    return null;
  }

  return null;
}

/**
 * Best-effort attribution of a remote transaction to a clientID.
 *
 * Yjs doesn't carry "the client that authored this transaction" directly;
 * it carries per-struct clientIDs in the `afterState`/`beforeState`
 * vectors. We pick the client whose clock advanced the furthest. Ties
 * are rare and harmless — the conflict UI surfaces all contributors.
 */
function guessRemoteClient(tr: Y.Transaction): number {
  let bestClient = -1;
  let bestDelta = 0;
  for (const [client, after] of tr.afterState) {
    const before = tr.beforeState.get(client) ?? 0;
    const delta = after - before;
    if (delta > bestDelta) {
      bestDelta = delta;
      bestClient = client;
    }
  }
  return bestClient;
}
