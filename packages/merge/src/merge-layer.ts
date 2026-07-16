/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Resolution application and merge-layer emission.
 *
 * Resolutions (ours/theirs/edited per conflict) append as ops; the result
 * publishes as a merge layer with `manifest.merge` filled. The candidate
 * layer is never mutated; history is append-only.
 */

import type { IfcxFile, IfcxNode, MergeRecord, MergeResolution, ProvenanceAuthor, ProvenanceBase, ProvenanceCheck, WaivedCheck } from '@ifc-lite/ifcx';
import { IFCLITE_ATTR, computeLayerId, createProvenanceManifest, setProvenance } from '@ifc-lite/ifcx';
import type { ComponentAttributes, MergeConflict, MergeOp, MergePlan, ResolutionInput } from './types.js';
import { opsForComponentChange } from './three-way.js';

export interface AppliedResolutions {
  /** Ops produced by `theirs`/`edited` choices, in conflict order. */
  ops: MergeOp[];
  /** Resolution records for the merge manifest (includes `ours` picks). */
  resolutions: MergeResolution[];
  /** Conflicts no resolution addressed. */
  unresolved: MergeConflict[];
}

function resolutionKey(path: string, componentKey?: string): string {
  return componentKey === undefined ? path : `${path}\u0000${componentKey}`;
}

/**
 * Turn reviewer decisions into ops. `ours` keeps the target state (no op),
 * `theirs` adopts the candidate value, `edited` takes the supplied
 * replacement component value (component-scoped conflicts only).
 */
export function applyResolutions(
  plan: MergePlan,
  inputs: readonly ResolutionInput[]
): AppliedResolutions {
  const byKey = new Map<string, ResolutionInput>();
  for (const input of inputs) {
    byKey.set(resolutionKey(input.path, input.componentKey), input);
  }

  const ops: MergeOp[] = [];
  const resolutions: MergeResolution[] = [];
  const unresolved: MergeConflict[] = [];

  for (const conflict of plan.conflicts) {
    const input = byKey.get(resolutionKey(conflict.path, conflict.componentKey));
    if (!input) {
      unresolved.push(conflict);
      continue;
    }
    const record: MergeResolution = { entity: conflict.path, choice: input.choice };
    if (conflict.componentKey !== undefined) record.componentKey = conflict.componentKey;
    resolutions.push(record);

    if (input.choice === 'ours') continue;

    if (input.choice === 'edited') {
      if (conflict.componentKey === undefined || input.attributes === undefined) {
        throw new Error(
          `edited resolution for ${conflict.path} requires a componentKey-scoped conflict and replacement attributes`
        );
      }
      if (conflict.componentKey.startsWith('child:') || conflict.componentKey.startsWith('inherit:')) {
        // A set-component on a relation pseudo-component would serialize
        // as a literal attribute instead of a children/inherits edge.
        throw new Error(
          `edited resolution cannot target relation component ${conflict.componentKey} on ${conflict.path}; resolve ours/theirs instead`
        );
      }
      ops.push({
        op: 'set-component',
        path: conflict.path,
        componentKey: conflict.componentKey,
        attributes: input.attributes,
      });
      continue;
    }

    // choice === 'theirs'
    ops.push(...opsForTheirs(conflict));
  }

  return { ops, resolutions, unresolved };
}

function opsForTheirs(conflict: MergeConflict): MergeOp[] {
  if (conflict.componentKey !== undefined) {
    return opsForComponentChange(
      conflict.path,
      conflict.componentKey,
      conflict.base?.attributes,
      conflict.theirs?.attributes,
      // Attribute keys ours added inside this component must be nulled,
      // or they survive a "theirs" resolution via per-attribute LWW.
      conflict.ours?.attributes
    );
  }
  switch (conflict.kind) {
    case 'modify-vs-delete': {
      // A recorded (empty) theirs state means theirs STRIPPED the entity
      // rather than tombstoning it — resolve with removal opinions so no
      // subtree-shadowing tombstone is fabricated.
      if (conflict.theirs !== undefined) {
        const baseComponents = (conflict.base?.attributes ?? {}) as Record<string, ComponentAttributes>;
        const oursComponents = (conflict.ours?.attributes ?? {}) as Record<string, ComponentAttributes>;
        const ops: MergeOp[] = [];
        const keys = new Set([...Object.keys(baseComponents), ...Object.keys(oursComponents)]);
        for (const componentKey of keys) {
          ops.push(
            ...opsForComponentChange(
              conflict.path,
              componentKey,
              baseComponents[componentKey],
              undefined,
              oursComponents[componentKey]
            )
          );
        }
        return ops;
      }
      // Theirs tombstoned the entity ours kept editing.
      return [{ op: 'tombstone-entity', path: conflict.path }];
    }
    case 'delete-vs-modify': {
      // Theirs kept editing what ours tombstoned: resurrect and restore.
      // Ours' pre-tombstone opinions become visible again on resurrect, so
      // the restore must cover the union of theirs' and ours' components —
      // an ours-only component has to be tombstoned, not left shining.
      const ops: MergeOp[] = [{ op: 'resurrect-entity', path: conflict.path }];
      const theirsComponents = (conflict.theirs?.attributes ?? {}) as Record<string, ComponentAttributes>;
      const oursComponents = (conflict.ours?.attributes ?? {}) as Record<string, ComponentAttributes>;
      const keys = new Set([...Object.keys(theirsComponents), ...Object.keys(oursComponents)]);
      for (const componentKey of keys) {
        ops.push(
          ...opsForComponentChange(
            conflict.path,
            componentKey,
            undefined,
            theirsComponents[componentKey],
            oursComponents[componentKey]
          )
        );
      }
      return ops;
    }
    default:
      throw new Error(`entity-level conflict of kind ${conflict.kind} cannot take theirs`);
  }
}

/** Serialize ops as ordinary IFCX node opinions, one node per path. */
export function opsToNodes(ops: readonly MergeOp[]): IfcxNode[] {
  const byPath = new Map<string, IfcxNode>();
  const nodeFor = (path: string): IfcxNode => {
    let node = byPath.get(path);
    if (!node) {
      node = { path };
      byPath.set(path, node);
    }
    return node;
  };

  for (const op of ops) {
    const node = nodeFor(op.path);
    switch (op.op) {
      case 'set-component':
      case 'tombstone-component':
        node.attributes = { ...node.attributes, ...op.attributes };
        break;
      case 'tombstone-entity':
        node.attributes = { ...node.attributes, [IFCLITE_ATTR.DELETED]: true };
        break;
      case 'resurrect-entity':
        node.attributes = { ...node.attributes, [IFCLITE_ATTR.DELETED]: false };
        break;
      case 'set-child':
        node.children = { ...node.children, [op.name]: op.child };
        break;
      case 'remove-child':
        node.children = { ...node.children, [op.name]: null };
        break;
      case 'set-inherit':
        node.inherits = { ...node.inherits, [op.name]: op.target };
        break;
      case 'remove-inherit':
        node.inherits = { ...node.inherits, [op.name]: null };
        break;
    }
  }

  return [...byPath.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export interface MergeLayerInit {
  /** Auto ops plus resolution ops, in application order. */
  ops: readonly MergeOp[];
  author: ProvenanceAuthor;
  intent: string;
  /** The state the merge layer applies on top of (the target ref's stack). */
  base: ProvenanceBase | null;
  merge: {
    /** Candidate layer id that was merged. */
    candidate: string;
    /** Target ref name or stack hash. */
    into: string;
    resolutions: MergeResolution[];
    waived_checks?: WaivedCheck[];
    /** Principal who resolved the merge. */
    resolver: string;
  };
  parents?: string[];
  checks?: ProvenanceCheck[];
  created?: string;
  ifcxVersion?: string;
  dataVersion?: string;
}

export interface PublishedMergeLayer {
  file: IfcxFile;
  layerId: string;
}

/**
 * Emit an immutable merge layer: ops as IFCX nodes plus a provenance
 * manifest with `merge` filled, content-addressed by canonical blake3.
 */
export function buildMergeLayer(init: MergeLayerInit): PublishedMergeLayer {
  const mergeRecord: MergeRecord = {
    candidate: init.merge.candidate,
    into: init.merge.into,
    resolutions: init.merge.resolutions,
    waived_checks: init.merge.waived_checks ?? [],
    resolver: init.merge.resolver,
  };
  const manifest = createProvenanceManifest({
    author: init.author,
    intent: init.intent,
    base: init.base,
    created: init.created,
    parents: init.parents ?? (init.base ? [init.base.id] : []),
    checks: init.checks ?? [],
    merge: mergeRecord,
  });

  const bare: IfcxFile = {
    header: {
      id: '',
      ifcxVersion: init.ifcxVersion ?? 'ifcx_alpha',
      dataVersion: init.dataVersion ?? '1.0.0',
      author: init.author.principal,
      timestamp: manifest.created,
    },
    imports: [],
    schemas: {},
    data: opsToNodes(init.ops),
  };
  const withManifest = setProvenance(bare, manifest);
  const layerId = computeLayerId(withManifest);
  return {
    file: { ...withManifest, header: { ...withManifest.header, id: layerId } },
    layerId,
  };
}
