/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Layer-merge type vocabulary.
 *
 * Ops are state-based at (entity, componentKey) granularity: a
 * `set-component` carries the full component value, never a transform.
 * Composing is a deterministic fold where stronger layers shadow weaker
 * per (entity, componentKey) — no OT machinery.
 *
 * Spec: docs/architecture/layer-prs/02-layer-format.md §2.2,
 *       05-merge.md §5.3.
 */

/**
 * Component key vocabulary shared with `@ifc-lite/diff` sub-hash mode:
 * `attr:<group>`, `pset:<PsetName>`, `qset:<QsetName>`, `type-assignment`,
 * `placement`, `geometry:<tier>`, plus `child:<name>` for relation slots.
 */
export type ComponentKey = string;

/** A component's merged value: the IFCX attributes that form it. */
export type ComponentAttributes = Record<string, unknown>;

/** Semantic reading of a layer's nodes — the op model of 02 §2.2. */
export type MergeOp =
  | {
      readonly op: 'set-component';
      readonly path: string;
      readonly componentKey: ComponentKey;
      /** Full component value (state-based; LWW within a stack). */
      readonly attributes: ComponentAttributes;
    }
  | {
      readonly op: 'tombstone-component';
      readonly path: string;
      readonly componentKey: ComponentKey;
      /** Attribute keys to null out (IFCX null = remove opinion). */
      readonly attributes: ComponentAttributes;
    }
  | { readonly op: 'tombstone-entity'; readonly path: string }
  | { readonly op: 'resurrect-entity'; readonly path: string }
  | {
      readonly op: 'set-child';
      readonly path: string;
      readonly name: string;
      readonly child: string;
    }
  | { readonly op: 'remove-child'; readonly path: string; readonly name: string }
  | {
      readonly op: 'set-inherit';
      readonly path: string;
      readonly name: string;
      readonly target: string;
    }
  | { readonly op: 'remove-inherit'; readonly path: string; readonly name: string };

/**
 * Conflict taxonomy, lifted from `collab/conflicts/detector.ts` kinds from
 * session level to merge level (05 §5.3).
 */
export type MergeConflictKind =
  | 'concurrent-edit'
  | 'delete-vs-modify'
  | 'modify-vs-delete'
  | 'hierarchy';

export interface ComponentSnapshot {
  /** Stable sub-hash of the component value. */
  hash: string;
  attributes: ComponentAttributes;
}

export interface MergeConflict {
  kind: MergeConflictKind;
  /** Entity path the conflict is on. */
  path: string;
  /** Component the conflict is scoped to; absent for entity-level kinds. */
  componentKey?: ComponentKey;
  /** Ancestor value (undefined when the component did not exist in A). */
  base?: ComponentSnapshot;
  /** Target-side value (undefined when removed/absent on ours). */
  ours?: ComponentSnapshot;
  /** Candidate-side value (undefined when removed/absent on theirs). */
  theirs?: ComponentSnapshot;
}

export interface MergePlanStats {
  /** (entity, componentKey) pairs touched by either side. */
  touched: number;
  autoMerged: number;
  conflicting: number;
}

/**
 * Result of a three-way plan: ops that apply cleanly on top of the target
 * state, plus explicit conflict records awaiting resolution. Zero
 * conflicts + green checks means the merge can complete unattended
 * (subject to ref policy).
 */
export interface MergePlan {
  autoOps: MergeOp[];
  conflicts: MergeConflict[];
  stats: MergePlanStats;
}

/** A reviewer's (or policy's) decision for one conflict. */
export interface ResolutionInput {
  path: string;
  componentKey?: ComponentKey;
  choice: 'ours' | 'theirs' | 'edited';
  /** Replacement component value; required when `choice === 'edited'`. */
  attributes?: ComponentAttributes;
}
