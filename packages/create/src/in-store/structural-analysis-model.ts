/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Anchored builder for `IfcStructuralAnalysisModel` — the container that
 * turns a bag of structural members/connections/loads into an analytical
 * *model* (#5167 task S.1).
 *
 * `IfcStructuralAnalysisModel` is `IfcSystem` → `IfcGroup` → `IfcObject`,
 * never `IfcProduct` — it has no `ObjectPlacement`/`Representation` at all
 * (confirmed against the generated IFC4 registry's `allAttributes`), so
 * unlike every other in-store builder in this directory it emits no
 * placement or geometry sub-graph. Membership (which members/connections
 * belong to the model) is NOT one of this entity's own attributes; it is
 * established separately via `IfcRelAssignsToGroup`
 * (`assignToStructuralGroupInStore` in `structural-relationships.ts`),
 * matching what `extractStructuralOnDemand` in `@ifc-lite/parser` reads
 * back (`StructuralAnalysisModelInfo.itemGlobalIds`).
 *
 * `LoadedBy` / `HasResults`, by contrast, ARE direct attributes on this
 * entity (`SET OF IfcStructuralLoadGroup` / `SET OF IfcStructuralResultGroup`
 * — no relationship indirection), so a load group's expressId is passed
 * straight through here.
 *
 * Schema targeted: IFC4 (IFC4_ADD2_TC1.exp) — `IfcStructuralAnalysisModel`
 * is unchanged from IFC4 to IFC4X3, so this builder is schema-neutral within
 * ifc-lite's supported IFC4+ range. Not offered for IFC2X3, which has no
 * structural-analysis schema module at all.
 *
 * Pure: no I/O, no parser access — operates entirely through the editor.
 */

import type { StoreEditor } from '@ifc-lite/mutations';
import type { SpatialAnchor } from './anchor.js';
import { ownerHistoryRef, productGuid } from './_emit-helpers.js';

export type StructuralAnalysisModelType =
  | 'IN_PLANE_LOADING_2D' | 'OUT_PLANE_LOADING_2D' | 'LOADING_3D'
  | 'USERDEFINED' | 'NOTDEFINED';

export interface StructuralAnalysisModelInStoreParams {
  Name?: string;
  Description?: string;
  /** Required by the EXPRESS `HasObjectType` WHERE rule when `PredefinedType` is `'USERDEFINED'`. */
  ObjectType?: string;
  PredefinedType?: StructuralAnalysisModelType;
  /** `IfcStructuralAnalysisModel.LoadedBy` — expressIds of existing `IfcStructuralLoadGroup`/`IfcStructuralLoadCase` entities. */
  LoadGroupIds?: readonly number[];
  /** `IfcStructuralAnalysisModel.HasResults` — expressIds of existing `IfcStructuralResultGroup` entities. */
  ResultGroupIds?: readonly number[];
  /** Explicit GlobalId (22-char IFC GUID); generated when omitted. */
  GlobalId?: string;
}

export interface StructuralAnalysisModelBuildResult {
  analysisModelId: number;
}

export function addStructuralAnalysisModelToStore(
  editor: StoreEditor,
  anchor: Pick<SpatialAnchor, 'ownerHistoryId' | 'guidRandom' | 'schema'>,
  params: StructuralAnalysisModelInStoreParams,
): StructuralAnalysisModelBuildResult {
  if (anchor.schema === 'IFC2X3') {
    throw new Error('addStructuralAnalysisModelToStore: IFC2X3 has no IfcStructuralAnalysisModel — target IFC4 or later');
  }
  const predefinedType = params.PredefinedType ?? 'NOTDEFINED';
  if (predefinedType === 'USERDEFINED' && !params.ObjectType) {
    throw new Error('addStructuralAnalysisModelToStore: ObjectType is required when PredefinedType is USERDEFINED');
  }

  const loadGroupIds = params.LoadGroupIds ?? [];
  const resultGroupIds = params.ResultGroupIds ?? [];

  const analysisModelId = editor.addEntity('IfcStructuralAnalysisModel', [
    productGuid(params, anchor.guidRandom),
    ownerHistoryRef(anchor.ownerHistoryId),
    params.Name ?? 'Structural Analysis Model',
    params.Description ?? null,
    params.ObjectType ?? null,
    `.${predefinedType}.`,
    null, // OrientationOf2DPlane
    loadGroupIds.length > 0 ? loadGroupIds.map((id) => `#${id}`) : null, // LoadedBy
    resultGroupIds.length > 0 ? resultGroupIds.map((id) => `#${id}`) : null, // HasResults
    null, // SharedPlacement
  ]).expressId;

  return { analysisModelId };
}
