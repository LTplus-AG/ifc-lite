/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type {
  AddStoreyParams, StoreyDeleteMode, StoreyDeletePlan, StoreyLevelEdit, StoreyLevelPlan, StoreySummary,
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
  addStorey?(modelId: string, params: AddStoreyParams): EntityRef;
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
