/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Storey authoring methods of bim.store (#9013). Lengths are metres. */
import type {
  AddStoreyParams, StoreyDeleteMode, StoreyDeletePlan, StoreyLevelEdit, StoreyLevelPlan, StoreySummary,
} from '@ifc-lite/create';
import type { EntityRef } from '../types.js';
import { StoreModellingNamespace } from './store-modelling.js';

export class StoreStoreyNamespace extends StoreModellingNamespace {
  private storeyMethod<K extends 'listStoreyLevels' | 'addStorey' | 'renameStorey' | 'planStoreyEdit' | 'editStorey' | 'planStoreyDelete' | 'deleteStorey'>(name: K) {
    const method = this.backend.store[name];
    if (!method) throw new Error(`bim.store.${name}: storey authoring is not available on this backend`);
    return method.bind(this.backend.store) as NonNullable<typeof method>;
  }

  /** Live storeys, highest first, with floor-to-floor height and element count. */
  listStoreyLevels(modelId: string): StoreySummary[] {
    return this.storeyMethod('listStoreyLevels')(modelId);
  }

  /** Add an IfcBuildingStorey aggregated under the building, placed like its neighbours. */
  addStorey(modelId: string, params: AddStoreyParams): EntityRef {
    return this.storeyMethod('addStorey')(modelId, params);
  }

  renameStorey(ref: EntityRef, Name: string): EntityRef {
    return this.storeyMethod('renameStorey')(ref, Name);
  }

  /** What an elevation or floor-to-floor edit would move, and any refusal. Writes nothing. */
  planStoreyEdit(modelId: string, edit: StoreyLevelEdit): StoreyLevelPlan {
    return this.storeyMethod('planStoreyEdit')(modelId, edit);
  }

  /** Move a storey (`elevation`) or the storeys above it (`floorHeight`) with their contents. */
  editStorey(modelId: string, edit: StoreyLevelEdit): EntityRef[] {
    return this.storeyMethod('editStorey')(modelId, edit);
  }

  planStoreyDelete(ref: EntityRef, mode: StoreyDeleteMode): StoreyDeletePlan {
    return this.storeyMethod('planStoreyDelete')(ref, mode);
  }

  /** Delete a storey; one that holds elements needs `{ kind: 'move', targetStoreyId }` or `{ kind: 'deleteContents' }`. */
  deleteStorey(ref: EntityRef, mode: StoreyDeleteMode): EntityRef[] {
    return this.storeyMethod('deleteStorey')(ref, mode);
  }
}
