/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Builds `bim.store`'s structural-analysis authoring methods (#5167 task S.1).
 *
 * This exists for the same reason `createCostStoreBackend` does: every host
 * that implements `StoreBackendMethods` — the CLI's `HeadlessBackend` and the
 * viewer's store adapter — would otherwise have to re-derive the anchor and
 * re-wire nine builders identically, and the two copies would drift.
 *
 * Declaring the methods on the interface without a factory would not have made
 * them callable: `StoreBackendMethods` is structural, so the interface alone
 * only breaks every host's typecheck. Spreading this in is what makes
 * `bim.store.addStructural*` actually reach `@ifc-lite/create`.
 */

import {
  addStructuralPlanarActionToStore,
  addStructuralSurfaceActionToStore,
  addStructuralPointReactionToStore,
  addStructuralCurveReactionToStore,
  addStructuralSurfaceReactionToStore,
  addStructuralResultGroupToStore,
  addStructuralAnalysisModelToStore,
  addStructuralCurveMemberToStore,
  addStructuralSurfaceMemberToStore,
  addStructuralCurveConnectionToStore,
  addStructuralSurfaceConnectionToStore,
  addStructuralLinearActionToStore,
  addStructuralLoadGroupToStore,
  addStructuralPointActionToStore,
  addStructuralPointConnectionToStore,
  assignToStructuralGroupInStore,
  connectStructuralActivityToItemInStore,
  connectStructuralMemberToConnectionInStore,
  resolveSpatialAnchor,
  type StructuralSurfaceActionInStoreParams,
  type StructuralPointReactionInStoreParams,
  type StructuralCurveReactionInStoreParams,
  type StructuralSurfaceReactionInStoreParams,
  type StructuralResultGroupInStoreParams,
  type StructuralAnalysisModelInStoreParams,
  type StructuralCurveMemberInStoreParams,
  type StructuralSurfaceMemberInStoreParams,
  type StructuralCurveConnectionInStoreParams,
  type StructuralSurfaceConnectionInStoreParams,
  type StructuralLinearActionInStoreParams,
  type StructuralLoadGroupInStoreParams,
  type StructuralPointActionInStoreParams,
  type StructuralPointConnectionInStoreParams,
} from '@ifc-lite/create';
import type { CostStoreModelResolution } from './cost-store-backend.js';
import type { StructuralStoreBackendMethods } from './store-structural-types.js';
import type { EntityRef } from './types.js';

/**
 * Same per-call resolution the cost backend takes. Aliased rather than
 * redeclared so a host can pass one closure to both factories; named for this
 * surface so the structural call sites do not read as cost ones.
 */
export type StructuralStoreModelResolver = (modelId?: string) => CostStoreModelResolution;

function ref(modelId: string, expressId: number): EntityRef {
  return { modelId, expressId };
}

/**
 * The `bim.store` structural methods are offered for IFC4 and IFC4X3 only.
 * The `@ifc-lite/create` builders also write IFC2X3, but this backend has not
 * been wired or tested for it. IFC5 is refused here because only some builders
 * check it, and `extractStructuralOnDemand` cannot read it back.
 */
const SUPPORTED_STRUCTURAL_SCHEMAS: ReadonlySet<string> = new Set(['IFC4', 'IFC4X3']);

function assertStructuralSchema(resolved: CostStoreModelResolution): void {
  const raw = resolved.store.schemaVersion;
  if (raw !== undefined && !SUPPORTED_STRUCTURAL_SCHEMAS.has(raw)) {
    throw new Error(
      `bim.store structural authoring: schema '${raw}' is not supported; use IFC4 or IFC4X3.`,
    );
  }
}

/**
 * The storey-less anchor the group/action builders take. They are `IfcGroup`
 * and `IfcStructuralActivity` subtypes with no `ObjectPlacement`, so resolving
 * a spatial anchor for them would be inventing a containment they do not have.
 */
function groupAnchor(resolved: CostStoreModelResolution) {
  return {
    ownerHistoryId: resolved.ownerHistoryId,
    guidRandom: undefined,
    schema: resolved.store.schemaVersion as 'IFC4' | 'IFC4X3' | undefined,
  };
}

export function createStructuralStoreBackend(
  resolve: StructuralStoreModelResolver,
): Required<StructuralStoreBackendMethods> {
  const resolved = (modelId: string): CostStoreModelResolution => {
    const model = resolve(modelId);
    assertStructuralSchema(model);
    return model;
  };

  return {
    addStructuralPlanarAction(modelId: string, params: StructuralSurfaceActionInStoreParams): EntityRef {
      const model = resolved(modelId);
      const result = addStructuralPlanarActionToStore(model.editor, groupAnchor(model), params);
      return ref(model.modelId, result.activityId);
    },
    addStructuralSurfaceAction(modelId: string, params: StructuralSurfaceActionInStoreParams): EntityRef {
      const model = resolved(modelId);
      const result = addStructuralSurfaceActionToStore(model.editor, groupAnchor(model), params);
      return ref(model.modelId, result.activityId);
    },
    addStructuralPointReaction(modelId: string, params: StructuralPointReactionInStoreParams): EntityRef {
      const model = resolved(modelId);
      const result = addStructuralPointReactionToStore(model.editor, groupAnchor(model), params);
      return ref(model.modelId, result.activityId);
    },
    addStructuralCurveReaction(modelId: string, params: StructuralCurveReactionInStoreParams): EntityRef {
      const model = resolved(modelId);
      const result = addStructuralCurveReactionToStore(model.editor, groupAnchor(model), params);
      return ref(model.modelId, result.activityId);
    },
    addStructuralSurfaceReaction(modelId: string, params: StructuralSurfaceReactionInStoreParams): EntityRef {
      const model = resolved(modelId);
      const result = addStructuralSurfaceReactionToStore(model.editor, groupAnchor(model), params);
      return ref(model.modelId, result.activityId);
    },
    addStructuralResultGroup(modelId: string, params: StructuralResultGroupInStoreParams): EntityRef {
      const model = resolved(modelId);
      const result = addStructuralResultGroupToStore(model.editor, groupAnchor(model), params);
      return ref(model.modelId, result.resultGroupId);
    },
    addStructuralSurfaceMember(modelId: string, storeyExpressId: number, params: StructuralSurfaceMemberInStoreParams): EntityRef {
      const model = resolved(modelId);
      const result = addStructuralSurfaceMemberToStore(model.editor, resolveSpatialAnchor(model.store, storeyExpressId), params);
      return ref(model.modelId, result.memberId);
    },
    addStructuralCurveConnection(modelId: string, storeyExpressId: number, params: StructuralCurveConnectionInStoreParams): EntityRef {
      const model = resolved(modelId);
      const result = addStructuralCurveConnectionToStore(model.editor, resolveSpatialAnchor(model.store, storeyExpressId), params);
      return ref(model.modelId, result.connectionId);
    },
    addStructuralSurfaceConnection(modelId: string, storeyExpressId: number, params: StructuralSurfaceConnectionInStoreParams): EntityRef {
      const model = resolved(modelId);
      const result = addStructuralSurfaceConnectionToStore(model.editor, resolveSpatialAnchor(model.store, storeyExpressId), params);
      return ref(model.modelId, result.connectionId);
    },
    addStructuralAnalysisModel(modelId: string, params: StructuralAnalysisModelInStoreParams): EntityRef {
      const model = resolved(modelId);
      const result = addStructuralAnalysisModelToStore(model.editor, groupAnchor(model), params);
      return ref(model.modelId, result.analysisModelId);
    },
    addStructuralCurveMember(modelId: string, storeyExpressId: number, params: StructuralCurveMemberInStoreParams): EntityRef {
      const model = resolved(modelId);
      const anchor = resolveSpatialAnchor(model.store, storeyExpressId);
      const result = addStructuralCurveMemberToStore(model.editor, anchor, params);
      return ref(model.modelId, result.memberId);
    },
    addStructuralPointConnection(modelId: string, storeyExpressId: number, params: StructuralPointConnectionInStoreParams): EntityRef {
      const model = resolved(modelId);
      const anchor = resolveSpatialAnchor(model.store, storeyExpressId);
      const result = addStructuralPointConnectionToStore(model.editor, anchor, params);
      return ref(model.modelId, result.connectionId);
    },
    addStructuralLoadGroup(modelId: string, params: StructuralLoadGroupInStoreParams): EntityRef {
      const model = resolved(modelId);
      const result = addStructuralLoadGroupToStore(model.editor, groupAnchor(model), params);
      return ref(model.modelId, result.loadGroupId);
    },
    addStructuralPointAction(modelId: string, params: StructuralPointActionInStoreParams): EntityRef {
      const model = resolved(modelId);
      const result = addStructuralPointActionToStore(model.editor, groupAnchor(model), params);
      return ref(model.modelId, result.activityId);
    },
    addStructuralLinearAction(modelId: string, params: StructuralLinearActionInStoreParams): EntityRef {
      const model = resolved(modelId);
      const result = addStructuralLinearActionToStore(model.editor, groupAnchor(model), params);
      return ref(model.modelId, result.activityId);
    },
    connectStructuralMemberToConnection(modelId: string, memberExpressId: number, connectionExpressId: number): EntityRef {
      const model = resolved(modelId);
      const relId = connectStructuralMemberToConnectionInStore(
        model.editor, model.ownerHistoryId, memberExpressId, connectionExpressId,
      );
      return ref(model.modelId, relId);
    },
    connectStructuralActivityToItem(modelId: string, itemExpressId: number, activityExpressId: number): EntityRef {
      const model = resolved(modelId);
      const relId = connectStructuralActivityToItemInStore(
        model.editor, model.ownerHistoryId, itemExpressId, activityExpressId,
      );
      return ref(model.modelId, relId);
    },
    assignToStructuralGroup(modelId: string, groupExpressId: number, objectExpressIds: number[]): EntityRef {
      const model = resolved(modelId);
      const relId = assignToStructuralGroupInStore(
        model.editor, model.ownerHistoryId, groupExpressId, objectExpressIds,
      );
      return ref(model.modelId, relId);
    },
  };
}
