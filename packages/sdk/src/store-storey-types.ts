/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type {
  AddStoreyParams, StoreyAddPlan, StoreyDeleteMode, StoreyDeletePlan, StoreyLevelEdit, StoreyLevelPlan, StoreySuggestion, StoreySummary, TopConstraint,
} from '@ifc-lite/create';
import type { EntityRef } from './types.js';

/**
 * Storey authoring in a loaded model (#9013). Every host runs the same
 * `@ifc-lite/create` plan/apply functions; the viewer adds Undo batching and
 * re-meshing at its edge. Lengths are metres.
 */
export interface StoreyStoreBackendMethods {
  /** Live storeys, highest first, with floor-to-floor height and element count. */
  listStoreyLevels?(modelId: string): StoreySummary[];
  /** The default Name, Elevation and height for a storey above or below `referenceStoreyId`, from its neighbours. Reads only. */
  suggestStorey?(modelId: string, referenceStoreyId: number, side: 'above' | 'below'): StoreySuggestion;
  /**
   * Add a storey. Elements on the storey below it that are attached relatively to the storey above
   * theirs ("home storey + 1") re-bind to it and keep their offset from it; explicit bindings stay.
   */
  addStorey?(modelId: string, params: AddStoreyParams): EntityRef;
  /** Dry run of `addStorey`: its refusal, and the elements it would bind or re-bind (#9296). Writes nothing. */
  planAddStorey?(modelId: string, params: AddStoreyParams): StoreyAddPlan;
  /**
   * Attach an element's top to the storey above its own (relative), a named storey (explicit) or a
   * slab's underside, or make it fixed, and fit it there now. One atomic edit; returns what re-meshes.
   */
  setTopConstraint?(ref: EntityRef, constraint: TopConstraint): EntityRef[];
  renameStorey?(ref: EntityRef, Name: string): EntityRef;
  /** Dry run: what an elevation or floor-to-floor edit would move, and any refusal. Writes nothing. */
  planStoreyEdit?(modelId: string, edit: StoreyLevelEdit): StoreyLevelPlan;
  /**
   * Apply an elevation or floor-to-floor edit atomically; returns every moved product. Throws on a refusal,
   * or when `expected` (the reviewed `planStoreyEdit` result) no longer matches the model.
   */
  editStorey?(modelId: string, edit: StoreyLevelEdit, expected?: StoreyLevelPlan): EntityRef[];
  /** Dry run of a deletion. Writes nothing. */
  planStoreyDelete?(ref: EntityRef, mode: StoreyDeleteMode): StoreyDeletePlan;
  /**
   * Delete a storey atomically; a storey holding elements needs `move` or `deleteContents`. With `expected`
   * (the reviewed `planStoreyDelete` result), a storey whose contents changed since is refused, not re-planned.
   */
  deleteStorey?(ref: EntityRef, mode: StoreyDeleteMode, expected?: StoreyDeletePlan): EntityRef[];
}
