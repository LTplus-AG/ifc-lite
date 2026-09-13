/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Why one `Values` slot of a load configuration carries no nested load. */
export type StructuralLoadDropReason =
  | 'depth' | 'cycle' | 'budget' | 'invalid-reference' | 'unresolved' | 'unreadable';

/** One `IfcStructuralLoadOrResult` leaf, reduced to its named numeric components. */
export interface StructuralLoadData {
  expressId: number;
  type: string;
  name?: string;
  components: Record<string, number>;
  /** Present only for `IfcStructuralLoadConfiguration`: its nested loads. */
  configuration?: StructuralLoadConfigurationData;
}

/** One `Values` slot of an `IfcStructuralLoadConfiguration`, paired with its location. */
export interface StructuralLoadConfigurationEntryData {
  value?: StructuralLoadData;
  dropped?: StructuralLoadDropReason;
  location?: number[];
}

/** The recursively nested `Values`/`Locations` pair of a load configuration. */
export interface StructuralLoadConfigurationData {
  entries: StructuralLoadConfigurationEntryData[];
  locations?: number[][];
  truncated: boolean;
}

/** An `IfcBoundaryCondition` leaf, reduced to its named stiffness components. */
export interface BoundaryConditionData {
  expressId: number;
  type: string;
  name?: string;
  components: Record<string, number | boolean>;
}

export interface StructuralMemberData {
  expressId: number;
  globalId: string;
  type: string;
  name?: string;
  description?: string;
  objectType?: string;
  predefinedType?: string;
  thickness?: number;
  connectionGlobalIds: string[];
  activityGlobalIds: string[];
  analysisModelGlobalIds: string[];
}

export interface StructuralConnectionData {
  expressId: number;
  globalId: string;
  type: string;
  name?: string;
  description?: string;
  objectType?: string;
  appliedCondition?: BoundaryConditionData;
  memberGlobalIds: string[];
  activityGlobalIds: string[];
  analysisModelGlobalIds: string[];
}

export interface StructuralActivityData {
  expressId: number;
  globalId: string;
  type: string;
  kind: 'Action' | 'Reaction' | 'Unknown';
  name?: string;
  description?: string;
  objectType?: string;
  predefinedType?: string;
  globalOrLocal?: string;
  destabilizingLoad?: boolean;
  appliedLoad?: StructuralLoadData;
  appliesToGlobalId?: string;
  groupGlobalIds: string[];
}

export interface StructuralLoadGroupData {
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
  selfWeightCoefficients?: number[];
  activityGlobalIds: string[];
}

export interface StructuralResultGroupData {
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

export interface StructuralAnalysisModelData {
  expressId: number;
  globalId: string;
  name?: string;
  description?: string;
  objectType?: string;
  predefinedType?: string;
  loadGroupGlobalIds: string[];
  resultGroupGlobalIds: string[];
  itemGlobalIds: string[];
}

export interface StructuralExtractionData {
  analysisModels: StructuralAnalysisModelData[];
  members: StructuralMemberData[];
  connections: StructuralConnectionData[];
  activities: StructuralActivityData[];
  loadGroups: StructuralLoadGroupData[];
  resultGroups: StructuralResultGroupData[];
  hasStructural: boolean;
  /** True if reading any applied load hit a depth, node-budget, or cycle bound. */
  loadsTruncated: boolean;
}

export interface StructuralBackendMethods {
  data(modelId?: string): StructuralExtractionData;
  analysisModels(modelId?: string): StructuralAnalysisModelData[];
  members(modelId?: string): StructuralMemberData[];
  connections(modelId?: string): StructuralConnectionData[];
  activities(modelId?: string): StructuralActivityData[];
  loadGroups(modelId?: string): StructuralLoadGroupData[];
  resultGroups(modelId?: string): StructuralResultGroupData[];
}
