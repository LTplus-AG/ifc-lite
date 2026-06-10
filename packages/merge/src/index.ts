/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `@ifc-lite/merge` — three-way merge engine for IFCX layers.
 *
 * Built on two runs of the two-way comparison joined on entity identity:
 * emits a {@link MergePlan} (auto-merged ops + explicit conflict records),
 * applies reviewer resolutions, publishes content-addressed merge layers
 * with `manifest.merge` filled, and derives revert and rebase from the
 * same state-based op model.
 *
 * Spec: docs/architecture/layer-prs/05-merge.md.
 */

export type {
  ComponentAttributes,
  ComponentKey,
  ComponentSnapshot,
  MergeConflict,
  MergeConflictKind,
  MergeOp,
  MergePlan,
  MergePlanStats,
  ResolutionInput,
} from './types.js';
export {
  componentKeyForAttribute,
  componentEntries,
  extractStackState,
  snapshotOf,
  type EntityState,
  type StackState,
} from './component-state.js';
export {
  planThreeWayMerge,
  planFromStates,
  opsForComponentChange,
  type ThreeWayInputs,
} from './three-way.js';
export {
  applyResolutions,
  buildMergeLayer,
  opsToNodes,
  type AppliedResolutions,
  type MergeLayerInit,
  type PublishedMergeLayer,
} from './merge-layer.js';
export {
  buildInverseOps,
  buildRevertLayer,
  type RevertLayerInit,
  type RevertLayerResult,
} from './inverse.js';
export { planRebase, type RebaseInputs, type RebaseResult } from './rebase.js';
export {
  diffLayerStacks,
  diffStackStates,
  type ModifiedEntity,
  type StackDiff,
} from './state-diff.js';
export {
  checkRefPolicy,
  mergeIntoRef,
  resolveAncestor,
  type AncestorResolution,
  type LayerRefStore,
  type MergeInit,
  type MergeOutcome,
  type RefEntry,
  type RefPolicy,
  type Waiver,
} from './ref-flow.js';
