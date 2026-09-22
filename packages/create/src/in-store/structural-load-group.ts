/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Anchored builder for `IfcStructuralLoadGroup` / `IfcStructuralLoadCase`
 * (#5167 task S.1).
 *
 * `IfcStructuralLoadGroup` is `IfcGroup` → `IfcObject`, never `IfcProduct` —
 * no `ObjectPlacement`/`Representation` — so, like
 * `structural-analysis-model.ts`, this builder emits no geometry.
 *
 * Schema targeted: IFC4 (IFC4_ADD2_TC1.exp), verified against the generated
 * IFC4 registry's `allAttributes`:
 *   `IfcStructuralLoadGroup`: `GlobalId, OwnerHistory?, Name?, Description?,
 *    ObjectType?, PredefinedType, ActionType, ActionSource, Coefficient?,
 *    Purpose?`
 *   `IfcStructuralLoadCase` adds exactly one attribute after its parent's:
 *    `SelfWeightCoefficients?` (a `LIST [3:3] OF IfcRatioMeasure`).
 *   The EXPRESS `IsLoadCasePredefinedType` WHERE rule on
 *   `IfcStructuralLoadCase` requires `PredefinedType = LOAD_CASE`
 *   whenever `SelfWeightCoefficients` is present — enforced below rather
 *   than left for export/import to discover as a malformed file.
 *
 * A load group's members (the activities assigned to it) are established
 * separately via `IfcRelAssignsToGroup`
 * (`assignToStructuralGroupInStore` in `structural-relationships.ts`) —
 * this mirrors `extractStructuralOnDemand`'s read side
 * (`StructuralLoadGroupInfo.activityGlobalIds`).
 *
 * Pure: no I/O, no parser access — operates entirely through the editor.
 */

import type { StoreEditor } from '@ifc-lite/mutations';
import type { SpatialAnchor } from './anchor.js';
import { ownerHistoryRef, productGuid } from './_emit-helpers.js';

export type StructuralLoadGroupType = 'LOAD_GROUP' | 'LOAD_CASE' | 'LOAD_COMBINATION' | 'USERDEFINED' | 'NOTDEFINED';
export type StructuralActionType = 'PERMANENT_G' | 'VARIABLE_Q' | 'EXTRAORDINARY_A' | 'USERDEFINED' | 'NOTDEFINED';
export type StructuralActionSourceType =
  | 'DEAD_LOAD_G' | 'COMPLETION_G1' | 'LIVE_LOAD_Q' | 'SNOW_S' | 'WIND_W' | 'PRESTRESSING_P'
  | 'SETTLEMENT_U' | 'TEMPERATURE_T' | 'EARTHQUAKE_E' | 'FIRE' | 'IMPULSE' | 'IMPACT' | 'TRANSPORT'
  | 'ERECTION' | 'PROPPING' | 'SYSTEM_IMPERFECTION' | 'SHRINKAGE' | 'CREEP' | 'LACK_OF_FIT' | 'BUOYANCY'
  | 'ICE' | 'CURRENT' | 'WAVE' | 'RAIN' | 'BRAKES' | 'USERDEFINED' | 'NOTDEFINED';

export interface StructuralLoadGroupInStoreParams {
  Name?: string;
  Description?: string;
  /** Required by the combined `HasObjectType` WHERE rule when `PredefinedType`/`ActionType`/`ActionSource` is `'USERDEFINED'`. */
  ObjectType?: string;
  PredefinedType?: StructuralLoadGroupType;
  ActionType: StructuralActionType;
  ActionSource: StructuralActionSourceType;
  Coefficient?: number;
  Purpose?: string;
  /**
   * Exactly 3 ratios `[x, y, z]`. Presence emits `IfcStructuralLoadCase`
   * instead of `IfcStructuralLoadGroup` and forces `PredefinedType` to
   * `'LOAD_CASE'` (see the EXPRESS WHERE rule in the module doc) — passing
   * both this AND a conflicting `PredefinedType` is refused rather than
   * silently overridden.
   */
  SelfWeightCoefficients?: [number, number, number];
  /** Explicit GlobalId (22-char IFC GUID); generated when omitted. */
  GlobalId?: string;
}

export interface StructuralLoadGroupBuildResult {
  loadGroupId: number;
  /** `'IfcStructuralLoadCase'` when `SelfWeightCoefficients` was supplied, else `'IfcStructuralLoadGroup'`. */
  type: 'IfcStructuralLoadGroup' | 'IfcStructuralLoadCase';
}

export function addStructuralLoadGroupToStore(
  editor: StoreEditor,
  anchor: Pick<SpatialAnchor, 'ownerHistoryId' | 'guidRandom' | 'schema'>,
  params: StructuralLoadGroupInStoreParams,
): StructuralLoadGroupBuildResult {
  if (anchor.schema === 'IFC2X3') {
    throw new Error('addStructuralLoadGroupToStore: IFC2X3 has no IfcStructuralLoadGroup — target IFC4 or later');
  }
  const isLoadCase = params.SelfWeightCoefficients !== undefined;
  if (isLoadCase && params.PredefinedType !== undefined && params.PredefinedType !== 'LOAD_CASE') {
    throw new Error(
      `addStructuralLoadGroupToStore: SelfWeightCoefficients requires PredefinedType 'LOAD_CASE' `
      + `(EXPRESS IsLoadCasePredefinedType), got '${params.PredefinedType}'`,
    );
  }
  const predefinedType = params.PredefinedType ?? (isLoadCase ? 'LOAD_CASE' : 'LOAD_GROUP');
  if (
    (predefinedType === 'USERDEFINED' || params.ActionType === 'USERDEFINED' || params.ActionSource === 'USERDEFINED')
    && !params.ObjectType
  ) {
    throw new Error(
      'addStructuralLoadGroupToStore: ObjectType is required when PredefinedType, ActionType, or ActionSource is USERDEFINED',
    );
  }

  const baseAttrs: unknown[] = [
    productGuid(params, anchor.guidRandom),
    ownerHistoryRef(anchor.ownerHistoryId),
    params.Name ?? (isLoadCase ? 'Load Case' : 'Load Group'),
    params.Description ?? null,
    params.ObjectType ?? null,
    `.${predefinedType}.`,
    `.${params.ActionType}.`,
    `.${params.ActionSource}.`,
    params.Coefficient ?? null,
    params.Purpose ?? null,
  ];

  const type = isLoadCase ? 'IfcStructuralLoadCase' : 'IfcStructuralLoadGroup';
  const attrs = isLoadCase
    ? [...baseAttrs, [...(params.SelfWeightCoefficients as [number, number, number])]]
    : baseAttrs;

  const loadGroupId = editor.addEntity(type, attrs as Parameters<StoreEditor['addEntity']>[1]).expressId;
  return { loadGroupId, type };
}
