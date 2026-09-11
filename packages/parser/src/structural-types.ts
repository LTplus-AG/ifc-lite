/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The public read model for structural analysis — the shapes
 * `extractStructuralOnDemand` returns, held in their own module so the
 * extractor stays orchestration and every later layer (query namespace,
 * properties card, serializer) has one place to import the contract from.
 *
 * Every cross-link is a globalId, not an expressId, matching the schedule
 * extraction's contract: a consumer federating two models is never handed an
 * id it cannot place.
 */

import type { BoundaryConditionInfo, StructuralLoadInfo } from './structural-load-extractor.js';

/** An `IfcStructuralMember` subtype occurrence. */
export interface StructuralMemberInfo {
  expressId: number;
  globalId: string;
  /** Canonical EXPRESS type name, e.g. `IfcStructuralCurveMember`. */
  type: string;
  name?: string;
  description?: string;
  objectType?: string;
  predefinedType?: string;
  /** `IfcStructuralSurfaceMember.Thickness`, when the file carries it. */
  thickness?: number;
  /** Connections this member is joined to, via IfcRelConnectsStructuralMember. */
  connectionGlobalIds: string[];
  /** Activities applied to it, via IfcRelConnectsStructuralActivity. */
  activityGlobalIds: string[];
  /** Analysis models it belongs to, via IfcRelAssignsToGroup. */
  analysisModelGlobalIds: string[];
}

/** An `IfcStructuralConnection` subtype occurrence. */
export interface StructuralConnectionInfo {
  expressId: number;
  globalId: string;
  type: string;
  name?: string;
  description?: string;
  objectType?: string;
  /** The support condition, resolved from `AppliedCondition`. */
  appliedCondition?: BoundaryConditionInfo;
  memberGlobalIds: string[];
  activityGlobalIds: string[];
  analysisModelGlobalIds: string[];
}

/** An `IfcStructuralActivity` subtype occurrence — an action or a reaction. */
export interface StructuralActivityInfo {
  expressId: number;
  globalId: string;
  type: string;
  /**
   * Which side of the analysis this is: an applied load (`Action`) or a
   * computed result (`Reaction`). Derived from the inheritance chain, so a
   * subtype outside the two named branches reports `Unknown` rather than being
   * silently filed as a load.
   */
  kind: 'Action' | 'Reaction' | 'Unknown';
  name?: string;
  description?: string;
  objectType?: string;
  predefinedType?: string;
  /** `IfcStructuralActivity.GlobalOrLocal`, e.g. `GLOBAL_COORDS`. */
  globalOrLocal?: string;
  /** `IfcStructuralAction.DestabilizingLoad`; absent on reactions. */
  destabilizingLoad?: boolean;
  /** `IfcStructuralActivity.AppliedLoad`, resolved. */
  appliedLoad?: StructuralLoadInfo;
  /** The member or connection it acts on, via IfcRelConnectsStructuralActivity. */
  appliesToGlobalId?: string;
  /**
   * Every structural group this activity is assigned into via
   * IfcRelAssignsToGroup — load groups, result groups **and** analysis models.
   * Unlike a member's `analysisModelGlobalIds`, this one is not narrowed to a
   * single role, because an activity legitimately belongs to several: a load
   * case that owns it and an analysis model it was assigned straight into.
   * Consumers wanting one role must filter by looking the globalId up in the
   * matching collection.
   */
  groupGlobalIds: string[];
}

/** An `IfcStructuralLoadGroup` or `IfcStructuralLoadCase`. */
export interface StructuralLoadGroupInfo {
  expressId: number;
  globalId: string;
  type: string;
  name?: string;
  description?: string;
  objectType?: string;
  predefinedType?: string;
  actionType?: string;
  actionSource?: string;
  coefficient?: number;
  purpose?: string;
  /** `IfcStructuralLoadCase.SelfWeightCoefficients`, when present. */
  selfWeightCoefficients?: number[];
  activityGlobalIds: string[];
}

/** An `IfcStructuralResultGroup`. */
export interface StructuralResultGroupInfo {
  expressId: number;
  globalId: string;
  name?: string;
  description?: string;
  objectType?: string;
  theoryType?: string;
  isLinear?: boolean;
  resultForLoadGroupGlobalId?: string;
  activityGlobalIds: string[];
}

/** An `IfcStructuralAnalysisModel`. */
export interface StructuralAnalysisModelInfo {
  expressId: number;
  globalId: string;
  name?: string;
  description?: string;
  objectType?: string;
  predefinedType?: string;
  /** `LoadedBy` — load group globalIds. */
  loadGroupGlobalIds: string[];
  /** `HasResults` — result group globalIds. */
  resultGroupGlobalIds: string[];
  /** Members and connections assigned in via IfcRelAssignsToGroup. */
  itemGlobalIds: string[];
}

export interface StructuralExtraction {
  analysisModels: StructuralAnalysisModelInfo[];
  members: StructuralMemberInfo[];
  connections: StructuralConnectionInfo[];
  activities: StructuralActivityInfo[];
  loadGroups: StructuralLoadGroupInfo[];
  resultGroups: StructuralResultGroupInfo[];
  /** True if any structural entity was found (empty-state UI). */
  hasStructural: boolean;
}
