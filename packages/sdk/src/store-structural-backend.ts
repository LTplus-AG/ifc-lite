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
  addStructuralAnalysisModelToStore,
  addStructuralCurveMemberToStore,
  addStructuralLinearActionToStore,
  addStructuralLoadGroupToStore,
  addStructuralPointActionToStore,
  addStructuralPointConnectionToStore,
  assignToStructuralGroupInStore,
  connectStructuralActivityToItemInStore,
  connectStructuralMemberToConnectionInStore,
  resolveSpatialAnchor,
  type StructuralAnalysisModelInStoreParams,
  type StructuralCurveMemberInStoreParams,
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
 * `IfcStructuralAnalysisModel` and friends do not exist before IFC4, and the
 * builders each refuse IFC2X3 individually. Refusing here as well keeps the
 * message at the call the caller actually made, and refuses IFC5 — which no
 * builder checks, and which `extractStructuralOnDemand` cannot read back.
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
): StructuralStoreBackendMethods {
  const resolved = (modelId: string): CostStoreModelResolution => {
    const model = resolve(modelId);
    assertStructuralSchema(model);
    return model;
  };

  return {
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
