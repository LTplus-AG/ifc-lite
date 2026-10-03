/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Builds `bim.store`'s wall-join, hosted element, type and material methods
 * (#6232), for the
 * same reason `createStructuralStoreBackend` exists: every host implementing
 * `StoreBackendMethods` (CLI headless backend, viewer store adapter) spreads
 * this in instead of re-deriving the host anchor and re-wiring the builders.
 *
 * The host is resolved per call through `resolveHostAnchor` against the host's
 * live mutation view, so a wall authored earlier in the same session can take
 * an opening exactly like one read from the file.
 */

import {
  copyBatchInStore, arrayCopyTransforms,
  editHostedElementInStore,
  addCurtainWallToStore,
  addGridToStore,
  addColumnOnGridToStore,
  addElementTypeToStore,
  addMaterialLayerSetToStore,
  addMaterialLayerSetUsageToStore,
  addMaterialToStore,
  assignMaterialInStore,
  assignTypeInStore,
  joinWallsInStore,
  resolveWallJoinAnchor,
  liveEntityConforms,
  liveEntityType,
  readRelatedLists,
  resolveAuthoringAnchor,
  type ElementTypeInStoreParams,
  type MaterialInStoreParams,
  type MaterialLayerSetInStoreParams,
  type MaterialLayerSetUsageInStoreParams,
  addHostedElementInStore,
  type HostedDoorInStoreParams,
  type HostedWindowInStoreParams,
  type OpeningInStoreParams,
  type WallJoinApplyOptions,
  addStairToStore,
  addRailingToStore,
  resolveSpatialAnchor,
  type StairInStoreParams,
  type RailingInStoreParams,
  removeStairInStore,
  replaceElementInStore,
} from '@ifc-lite/create';
import type { CostStoreModelResolution } from './cost-store-backend.js';
import type { ModellingStoreBackendMethods } from './store-modelling-types.js';
import type { EntityRef } from './types.js';
import { createPhysicalStoreBackend } from './store-physical-backend.js';

/** Same per-call resolution the cost and structural factories take. */
export type ModellingStoreModelResolver = (modelId?: string) => CostStoreModelResolution;

export function createModellingStoreBackend(resolve: ModellingStoreModelResolver): ModellingStoreBackendMethods {
  const ref = (modelId: string, expressId: number): EntityRef => ({ modelId, expressId });
  const authoring = (modelId: string) => {
    const model = resolve(modelId);
    return { model, anchor: { ...resolveAuthoringAnchor(model.store, model.mutationView), ownerHistoryId: model.ownerHistoryId } };
  };
  /**
   * Refuse, before anything is written, a relating entity or an object that is
   * not live or is not of a class the relationship slot takes in the model's
   * schema (`IfcRelDefinesByType.RelatingType` is an IfcTypeObject, and so on).
   */
  const requireKinds = (model: CostStoreModelResolution, op: string, checks: Array<[ids: number[], kinds: string[]]>) => {
    for (const [ids, kinds] of checks) {
      for (const id of ids) {
        if (kinds.some((kind) => liveEntityConforms(model.store, id, kind, model.mutationView))) continue;
        const type = liveEntityType(model.store, id, model.mutationView);
        throw new Error(`bim.store.${op}: #${id} is ${type ? `an ${type}, not an ${kinds.join(' or ')}` : 'not a live entity'}`);
      }
    }
  };

  return {
    ...createPhysicalStoreBackend(resolve),
    copyElements(modelId, expressIds, transforms) {
      const model = resolve(modelId);
      return copyBatchInStore(model.store, model.editor, expressIds, transforms)
        .map(result => ref(model.modelId, result.copyId));
    },
    duplicateElement(entity, options) {
      const model = resolve(entity.modelId);
      const [result] = copyBatchInStore(model.store, model.editor, [entity.expressId], [{ offset: options.offset }],
        { duplicate: { name: options.Name } });
      return ref(model.modelId, result.copyId);
    },
    arrayElements(modelId, expressIds, params) {
      const transforms = arrayCopyTransforms(params);
      if (!transforms) throw new Error('Array requires an anchor and a nonzero linear direction');
      const model = resolve(modelId);
      return copyBatchInStore(model.store, model.editor, expressIds, transforms)
        .map(result => ref(model.modelId, result.copyId));
    },
    editHostedElement(entity, patch) {
      const model = resolve(entity.modelId);
      editHostedElementInStore(model.store, model.editor, entity.expressId, patch);
      return ref(model.modelId, entity.expressId);
    },
    addCurtainWall(modelId, storeyExpressId, params) {
      const model = resolve(modelId);
      const built = model.editor.runAtomic(draft => addCurtainWallToStore(
        draft, resolveSpatialAnchor(model.store, storeyExpressId, draft.getMutationView()), params,
      ));
      return ref(model.modelId, built.curtainWallId);
    },
    addGrid(modelId, storeyExpressId, params) {
      const model = resolve(modelId);
      const built = model.editor.runAtomic(draft => addGridToStore(
        draft, resolveSpatialAnchor(model.store, storeyExpressId, draft.getMutationView()), params,
      ));
      return ref(model.modelId, built.gridId);
    },
    addColumnOnGrid(modelId, storeyExpressId, params, binding) {
      const model = resolve(modelId);
      const built = model.editor.runAtomic(draft => addColumnOnGridToStore(
        draft, model.store, resolveSpatialAnchor(model.store, storeyExpressId, draft.getMutationView()), params, binding,
      ));
      return ref(model.modelId, built.columnId);
    },
    replaceElement(entity, storeyExpressId, element) {
      const model = resolve(entity.modelId);
      const built = replaceElementInStore(model.store, model.editor, entity.expressId,
        draft => resolveSpatialAnchor(model.store, storeyExpressId, draft.getMutationView()), element);
      return ref(model.modelId, built.expressId);
    },
    removeStair(entity: EntityRef): boolean {
      const model = resolve(entity.modelId);
      removeStairInStore(model.store, model.editor, entity.expressId);
      return true;
    },
    addStair(modelId: string, storeyExpressId: number, params: StairInStoreParams): EntityRef {
      const model = resolve(modelId);
      const built = model.editor.runAtomic(draft => addStairToStore(
        draft, resolveSpatialAnchor(model.store, storeyExpressId, draft.getMutationView()), params,
      ));
      return ref(model.modelId, built.stairId);
    },
    addRailing(modelId: string, storeyExpressId: number, params: RailingInStoreParams): EntityRef {
      const model = resolve(modelId);
      const built = model.editor.runAtomic(draft => addRailingToStore(
        draft, resolveSpatialAnchor(model.store, storeyExpressId, draft.getMutationView()), params,
      ));
      return ref(model.modelId, built.railingId);
    },
    joinWalls(modelId: string, aExpressId: number, bExpressId: number, options: WallJoinApplyOptions = {}): EntityRef {
      const model = resolve(modelId);
      const joined = model.editor.runAtomic(draft => joinWallsInStore(
        draft, model.store, resolveWallJoinAnchor(model.store, draft.getMutationView()), aExpressId, bExpressId, options,
      ));
      return ref(model.modelId, joined.relId);
    },
    addOpening(modelId: string, hostExpressId: number, params: OpeningInStoreParams): EntityRef {
      const model = resolve(modelId);
      return ref(model.modelId, addHostedElementInStore(model.store, model.editor, hostExpressId, { kind: 'opening', params }).expressId);
    },
    addHostedDoor(modelId: string, hostExpressId: number, params: HostedDoorInStoreParams): EntityRef {
      const model = resolve(modelId);
      return ref(model.modelId, addHostedElementInStore(model.store, model.editor, hostExpressId, { kind: 'door', params }).expressId);
    },
    addHostedWindow(modelId: string, hostExpressId: number, params: HostedWindowInStoreParams): EntityRef {
      const model = resolve(modelId);
      return ref(model.modelId, addHostedElementInStore(model.store, model.editor, hostExpressId, { kind: 'window', params }).expressId);
    },
    addElementType(modelId: string, params: ElementTypeInStoreParams): EntityRef {
      const { model, anchor } = authoring(modelId);
      return ref(model.modelId, addElementTypeToStore(model.editor, anchor, params).typeId);
    },
    assignType(modelId: string, typeExpressId: number, objectExpressIds: number[]): EntityRef {
      const { model, anchor } = authoring(modelId);
      requireKinds(model, 'assignType', [[[typeExpressId], ['IfcTypeObject']], [objectExpressIds, ['IfcObject']]]);
      const existing = readRelatedLists(model.store, 'IfcRelDefinesByType', model.mutationView);
      return ref(model.modelId, assignTypeInStore(model.editor, anchor, typeExpressId, objectExpressIds, existing).relId);
    },
    addMaterial(modelId: string, params: MaterialInStoreParams): EntityRef {
      const { model, anchor } = authoring(modelId);
      return ref(model.modelId, addMaterialToStore(model.editor, anchor, params).materialId);
    },
    addMaterialLayerSet(modelId: string, params: MaterialLayerSetInStoreParams): EntityRef {
      const { model, anchor } = authoring(modelId);
      return ref(model.modelId, addMaterialLayerSetToStore(model.editor, anchor, params).layerSetId);
    },
    addMaterialLayerSetUsage(modelId: string, params: MaterialLayerSetUsageInStoreParams): EntityRef {
      const { model, anchor } = authoring(modelId);
      requireKinds(model, 'addMaterialLayerSetUsage', [[[params.ForLayerSet], ['IfcMaterialLayerSet']]]);
      return ref(model.modelId, addMaterialLayerSetUsageToStore(model.editor, anchor, params).usageId);
    },
    assignMaterial(modelId: string, materialExpressId: number, objectExpressIds: number[]): EntityRef {
      const { model, anchor } = authoring(modelId);
      requireKinds(model, 'assignMaterial', [[[materialExpressId], ['IfcMaterialSelect']], [objectExpressIds, ['IfcObjectDefinition', 'IfcPropertyDefinition']]]);
      const existing = readRelatedLists(model.store, 'IfcRelAssociatesMaterial', model.mutationView);
      return ref(model.modelId, assignMaterialInStore(model.editor, anchor, materialExpressId, objectExpressIds, existing).relId);
    },
  };
}
