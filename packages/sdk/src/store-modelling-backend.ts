/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Builds `bim.store`'s opening, hosted door/window, type and material methods
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
  addElementTypeToStore,
  addMaterialLayerSetToStore,
  addMaterialLayerSetUsageToStore,
  addMaterialToStore,
  assignMaterialInStore,
  assignTypeInStore,
  liveEntityType,
  readRelatedLists,
  resolveAuthoringAnchor,
  type ElementTypeInStoreParams,
  type MaterialInStoreParams,
  type MaterialLayerSetInStoreParams,
  type MaterialLayerSetUsageInStoreParams,
  addHostedDoorToStore,
  addHostedWindowToStore,
  addOpeningToStore,
  resolveHostAnchor,
  type HostedDoorInStoreParams,
  type HostedWindowInStoreParams,
  type OpeningInStoreParams,
} from '@ifc-lite/create';
import type { CostStoreModelResolution } from './cost-store-backend.js';
import type { ModellingStoreBackendMethods } from './store-modelling-types.js';
import type { EntityRef } from './types.js';

/** Same per-call resolution the cost and structural factories take. */
export type ModellingStoreModelResolver = (modelId?: string) => CostStoreModelResolution;

export function createModellingStoreBackend(resolve: ModellingStoreModelResolver): ModellingStoreBackendMethods {
  const host = (modelId: string, hostExpressId: number) => {
    const model = resolve(modelId);
    return { model, anchor: resolveHostAnchor(model.store, hostExpressId, model.mutationView) };
  };
  const ref = (modelId: string, expressId: number): EntityRef => ({ modelId, expressId });
  const authoring = (modelId: string) => {
    const model = resolve(modelId);
    return { model, anchor: { ...resolveAuthoringAnchor(model.store, model.mutationView), ownerHistoryId: model.ownerHistoryId } };
  };
  /** Refuse ids that are not live entities, and a relating entity of the wrong kind, before anything is written. */
  const requireLive = (model: CostStoreModelResolution, op: string, relating: number, kind: RegExp, objects: number[]) => {
    const relatingType = liveEntityType(model.store, relating, model.mutationView);
    if (!relatingType || !kind.test(relatingType)) {
      throw new Error(`bim.store.${op}: #${relating} is ${relatingType ? `an ${relatingType}` : 'not a live entity'}`);
    }
    const missing = objects.filter((id) => liveEntityType(model.store, id, model.mutationView) === null);
    if (missing.length > 0) throw new Error(`bim.store.${op}: no live entity ${missing.map((id) => `#${id}`).join(', ')}`);
  };

  return {
    addOpening(modelId: string, hostExpressId: number, params: OpeningInStoreParams): EntityRef {
      const { model, anchor } = host(modelId, hostExpressId);
      return ref(model.modelId, addOpeningToStore(model.editor, anchor, params).openingId);
    },
    addHostedDoor(modelId: string, hostExpressId: number, params: HostedDoorInStoreParams): EntityRef {
      const { model, anchor } = host(modelId, hostExpressId);
      return ref(model.modelId, addHostedDoorToStore(model.editor, anchor, params).fillingId);
    },
    addHostedWindow(modelId: string, hostExpressId: number, params: HostedWindowInStoreParams): EntityRef {
      const { model, anchor } = host(modelId, hostExpressId);
      return ref(model.modelId, addHostedWindowToStore(model.editor, anchor, params).fillingId);
    },
    addElementType(modelId: string, params: ElementTypeInStoreParams): EntityRef {
      const { model, anchor } = authoring(modelId);
      return ref(model.modelId, addElementTypeToStore(model.editor, anchor, params).typeId);
    },
    assignType(modelId: string, typeExpressId: number, objectExpressIds: number[]): EntityRef {
      const { model, anchor } = authoring(modelId);
      requireLive(model, 'assignType', typeExpressId, /(TYPE|STYLE)$/, objectExpressIds);
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
      requireLive(model, 'addMaterialLayerSetUsage', params.ForLayerSet, /^IFCMATERIALLAYERSET$/, []);
      return ref(model.modelId, addMaterialLayerSetUsageToStore(model.editor, anchor, params).usageId);
    },
    assignMaterial(modelId: string, materialExpressId: number, objectExpressIds: number[]): EntityRef {
      const { model, anchor } = authoring(modelId);
      requireLive(model, 'assignMaterial', materialExpressId, /^IFCMATERIAL/, objectExpressIds);
      const existing = readRelatedLists(model.store, 'IfcRelAssociatesMaterial', model.mutationView);
      return ref(model.modelId, assignMaterialInStore(model.editor, anchor, materialExpressId, objectExpressIds, existing).relId);
    },
  };
}
