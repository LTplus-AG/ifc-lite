/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Storey authoring methods of bim.store (#9013). Lengths are metres. */
import type {
  AddStoreyParams, StoreyAddPlan, StoreyDeleteMode, StoreyDeletePlan, StoreyLevelEdit, StoreyLevelPlan, StoreySuggestion, StoreySummary, TopConstraint,
} from '@ifc-lite/create';
import type { EntityRef } from '../types.js';
import { StoreModellingNamespace } from './store-modelling.js';

export class StoreStoreyNamespace extends StoreModellingNamespace {
  private storeyMethod<K extends 'listStoreyLevels' | 'suggestStorey' | 'addStorey' | 'planAddStorey' | 'renameStorey' | 'planStoreyEdit' | 'editStorey' | 'planStoreyDelete' | 'deleteStorey' | 'setTopConstraint'>(name: K) {
    const method = this.backend.store[name];
    if (!method) throw new Error(`bim.store.${name}: storey authoring is not available on this backend`);
    return method.bind(this.backend.store) as NonNullable<typeof method>;
  }

  /** Live storeys, highest first, with floor-to-floor height and element count. */
  listStoreyLevels(modelId: string): StoreySummary[] {
    return this.storeyMethod('listStoreyLevels')(modelId);
  }

  /** The neighbours' naming and spacing for a new storey above or below `referenceStoreyId`. Writes nothing. */
  suggestStorey(modelId: string, referenceStoreyId: number, side: 'above' | 'below'): StoreySuggestion {
    return this.storeyMethod('suggestStorey')(modelId, referenceStoreyId, side);
  }

  /**
   * Add an IfcBuildingStorey aggregated under the building, placed like its neighbours. Elements on the
   * storey below that are attached to the storey above theirs re-bind to the new one (#9296).
   */
  addStorey(modelId: string, params: AddStoreyParams): EntityRef {
    return this.storeyMethod('addStorey')(modelId, params);
  }

  /** What `addStorey` would do: its refusal and the elements it would bind or re-bind. Writes nothing. */
  planAddStorey(modelId: string, params: AddStoreyParams): StoreyAddPlan {
    return this.storeyMethod('planAddStorey')(modelId, params);
  }

  /**
   * Attach a wall's, column's, beam's, member's or curtain wall's top to the storey above its own
   * (`storeyAbove`, relative), a named storey (`storey`, explicit) or a slab's underside (`slab`), or make it
   * `fixed`; the top is fitted there now and follows later storey edits. Returns what re-meshes.
   */
  setTopConstraint(ref: EntityRef, constraint: TopConstraint): EntityRef[] {
    return this.storeyMethod('setTopConstraint')(ref, constraint);
  }

  renameStorey(ref: EntityRef, Name: string): EntityRef {
    return this.storeyMethod('renameStorey')(ref, Name);
  }

  /** What an elevation or floor-to-floor edit would move, and any refusal. Writes nothing. */
  planStoreyEdit(modelId: string, edit: StoreyLevelEdit): StoreyLevelPlan {
    return this.storeyMethod('planStoreyEdit')(modelId, edit);
  }

  /**
   * Move a storey (`elevation`) or the storeys above it (`floorHeight`) with their contents. Pass the
   * reviewed `planStoreyEdit` result as `expected` to refuse the edit if the model changed since.
   */
  editStorey(modelId: string, edit: StoreyLevelEdit, expected?: StoreyLevelPlan): EntityRef[] {
    return this.storeyMethod('editStorey')(modelId, edit, expected);
  }

  planStoreyDelete(ref: EntityRef, mode: StoreyDeleteMode): StoreyDeletePlan {
    return this.storeyMethod('planStoreyDelete')(ref, mode);
  }

  /**
   * Delete a storey; one that holds elements needs `{ kind: 'move', targetStoreyId }` or `{ kind: 'deleteContents' }`.
   * Pass the reviewed `planStoreyDelete` result as `expected` so contents added since are never deleted unseen.
   */
  deleteStorey(ref: EntityRef, mode: StoreyDeleteMode, expected?: StoreyDeletePlan): EntityRef[] {
    return this.storeyMethod('deleteStorey')(ref, mode, expected);
  }
}
