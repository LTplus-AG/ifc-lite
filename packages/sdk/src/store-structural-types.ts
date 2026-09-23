/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `bim.store.addStructural*` / `connectStructural*` / `assignToStructuralGroup`
 * — loaded-model structural-analysis authoring (#5167 task S.1). Split out
 * of `types.ts` (allowlisted at 743 lines, already at budget) so this
 * surface doesn't grow that file — same reason `store-cost-types.ts` is
 * its own module.
 *
 * Param shapes are imported straight from `@ifc-lite/create` rather than
 * re-declared here, matching `store-cost-types.ts`'s
 * `CostItemParams`/`CostScheduleParams` (not the separately-mirrored
 * `AddColumnInStoreParams`-style physical-element params in `types.ts`) —
 * there is no SDK-specific divergence to justify a second copy.
 */

import type {
  StructuralAnalysisModelInStoreParams,
  StructuralCurveMemberInStoreParams,
  StructuralLinearActionInStoreParams,
  StructuralLoadGroupInStoreParams,
  StructuralPointActionInStoreParams,
  StructuralPointConnectionInStoreParams,
} from '@ifc-lite/create';
import type { EntityRef } from './types.js';

export interface StructuralStoreBackendMethods {
  /** `IfcStructuralAnalysisModel` — no storey anchor (`IfcGroup`, not `IfcProduct`). */
  addStructuralAnalysisModel(modelId: string, params: StructuralAnalysisModelInStoreParams): EntityRef;
  /** `IfcStructuralCurveMember`, anchored to a storey for its `ObjectPlacement`. */
  addStructuralCurveMember(modelId: string, storeyExpressId: number, params: StructuralCurveMemberInStoreParams): EntityRef;
  /** `IfcStructuralPointConnection`, anchored to a storey for its `ObjectPlacement`. */
  addStructuralPointConnection(modelId: string, storeyExpressId: number, params: StructuralPointConnectionInStoreParams): EntityRef;
  /** `IfcStructuralLoadGroup` or `IfcStructuralLoadCase` (picked by `params.SelfWeightCoefficients`) — no storey anchor. */
  addStructuralLoadGroup(modelId: string, params: StructuralLoadGroupInStoreParams): EntityRef;
  /** `IfcStructuralPointAction` + its `IfcStructuralLoadSingleForce` — no storey anchor (see `structural-action.ts`). */
  addStructuralPointAction(modelId: string, params: StructuralPointActionInStoreParams): EntityRef;
  /** `IfcStructuralLinearAction` + its `IfcStructuralLoadLinearForce` — no storey anchor. */
  addStructuralLinearAction(modelId: string, params: StructuralLinearActionInStoreParams): EntityRef;
  /** `IfcRelConnectsStructuralMember` linking a curve member to a point connection. */
  connectStructuralMemberToConnection(modelId: string, memberExpressId: number, connectionExpressId: number): EntityRef;
  /** `IfcRelConnectsStructuralActivity` applying an action/reaction to the member or connection it acts on. */
  connectStructuralActivityToItem(modelId: string, itemExpressId: number, activityExpressId: number): EntityRef;
  /** `IfcRelAssignsToGroup` — members/connections into an analysis model, or activities into a load group. */
  assignToStructuralGroup(modelId: string, groupExpressId: number, objectExpressIds: number[]): EntityRef;
}
