/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Revert: a layer of inverse ops. Composing `[base, L, revert(L)]`
 * yields the same component state as `base` alone — additions are
 * tombstoned, deletions resurrected, edited components restored to their
 * base values. History stays append-only.
 */

import type { IfcxFile, ProvenanceAuthor } from '@ifc-lite/ifcx';
import { computeLayerId, createProvenanceManifest, setProvenance } from '@ifc-lite/ifcx';
import type { ComponentAttributes, MergeOp } from './types.js';
import type { StackState } from './component-state.js';
import { componentEntries, extractStackState, snapshotOf } from './component-state.js';
import { opsForComponentChange } from './three-way.js';
import { opsToNodes } from './merge-layer.js';

/** Ops that transform `after` back into `before` (state-based, per component). */
export function buildInverseOps(before: StackState, after: StackState): MergeOp[] {
  const ops: MergeOp[] = [];
  const paths = new Set<string>([...before.keys(), ...after.keys()]);

  for (const path of paths) {
    const beforeEntity = before.get(path);
    const afterEntity = after.get(path);
    const beforeAlive = beforeEntity !== undefined && !beforeEntity.deleted;
    const afterAlive = afterEntity !== undefined && !afterEntity.deleted;

    // Dead on both sides: invisible either way, nothing to undo.
    if (!beforeAlive && !afterAlive) continue;

    if (!beforeAlive && afterAlive) {
      // L added or resurrected the entity: re-tombstone it. When it was
      // resurrected AND edited, the tombstone alone is not enough — L's
      // component opinions stay in the stack and would shine through a
      // later resurrect, so the component loop below also restores the
      // before values (a dead entity's components stay visible to the
      // merge matrix).
      ops.push({ op: 'tombstone-entity', path });
    }
    if (beforeAlive && !afterAlive) {
      // L deleted it: resurrect. Keys L added before (or while)
      // tombstoning are still opinions in the stack — the component loop
      // reads the after-state's under-tombstone components so those keys
      // land in the union and get nulled, not just the pre-delete edits.
      ops.push({ op: 'resurrect-entity', path });
    }

    const beforeComponents: Map<string, ComponentAttributes> = beforeEntity
      ? componentEntries(beforeEntity)
      : new Map();
    const afterComponents: Map<string, ComponentAttributes> = afterEntity
      ? componentEntries(afterEntity)
      : new Map();
    const keys = new Set<string>([...beforeComponents.keys(), ...afterComponents.keys()]);
    for (const key of keys) {
      const beforeAttrs = beforeComponents.get(key);
      const afterAttrs = afterComponents.get(key);
      const beforeHash = beforeAttrs ? snapshotOf(beforeAttrs).hash : undefined;
      const afterHash = afterAttrs ? snapshotOf(afterAttrs).hash : undefined;
      if (beforeHash === afterHash) continue;
      ops.push(...opsForComponentChange(path, key, afterAttrs, beforeAttrs));
    }
  }

  return ops;
}

export interface RevertLayerInit {
  /** The layer to revert. */
  layer: IfcxFile;
  /** The stack the layer was applied on, ordered weakest first. */
  base: readonly IfcxFile[];
  author: ProvenanceAuthor;
  intent?: string;
  /** Layer id of the reverted layer (recorded as parent). */
  layerId?: string;
  created?: string;
}

export interface RevertLayerResult {
  file: IfcxFile;
  layerId: string;
  ops: MergeOp[];
}

/** Emit an inverse-op layer that undoes `layer` on top of `base + layer`. */
export function buildRevertLayer(init: RevertLayerInit): RevertLayerResult {
  const before = extractStackState(init.base);
  const after = extractStackState([...init.base, init.layer]);
  const ops = buildInverseOps(before, after);

  const manifest = createProvenanceManifest({
    author: init.author,
    intent: init.intent ?? `Revert layer ${init.layerId ?? init.layer.header.id}`,
    base: null,
    created: init.created,
    parents: init.layerId ? [init.layerId] : [],
  });

  const bare: IfcxFile = {
    header: {
      id: '',
      ifcxVersion: init.layer.header.ifcxVersion,
      dataVersion: init.layer.header.dataVersion,
      author: init.author.principal,
      timestamp: manifest.created,
    },
    imports: [],
    schemas: {},
    data: opsToNodes(ops),
  };
  const withManifest = setProvenance(bare, manifest);
  const layerId = computeLayerId(withManifest);
  return {
    file: { ...withManifest, header: { ...withManifest.header, id: layerId } },
    layerId,
    ops,
  };
}
