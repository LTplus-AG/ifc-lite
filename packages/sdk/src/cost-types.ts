/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { EntityRef } from './types.js';

export type CostSchemaVersion = 'IFC2X3' | 'IFC4' | 'IFC4X3' | 'IFC5';
export type CostQuantityDimension = 'length' | 'area' | 'volume' | 'mass' | 'time' | 'count' | 'number';
export type CostDiagnosticCode =
  | 'IFC2X3_PARTIAL_READ' | 'UNSUPPORTED_SCHEMA' | 'MISSING_REFERENCE' | 'INVALID_LIST'
  | 'MULTIPLE_NESTING_PARENTS' | 'NESTING_CYCLE' | 'QUANTITY_CYCLE' | 'VALUE_CYCLE'
  | 'MISSING_VALUE' | 'INVALID_NUMBER' | 'UNSUPPORTED_APPLIED_VALUE' | 'UNSUPPORTED_CONDITION'
  | 'UNSUPPORTED_UNIT' | 'INCOMPATIBLE_UNIT' | 'MISSING_CURRENCY' | 'MIXED_CURRENCY'
  | 'DIVISION_BY_ZERO' | 'PENDING_EDIT_NOT_APPLIED';

export interface CostDiagnosticData {
  Code: CostDiagnosticCode;
  Message: string;
  Severity: 'warning' | 'error';
  ref?: EntityRef;
  RelatedRef?: EntityRef;
}

export interface CostScheduleData {
  ref: EntityRef;
  GlobalId?: string; Name?: string; Description?: string; ObjectType?: string;
  Identification?: string; PredefinedType?: string; Status?: string;
  SubmittedOn?: string; UpdateDate?: string; ID?: string;
}

export type CostAppliedValueData =
  | { Kind: 'Typed'; Type: string; Value: string }
  | { Kind: 'Reference'; ref: EntityRef }
  | { Kind: 'Unsupported'; Raw: unknown; InvalidNumber?: boolean };

export interface CostValueData {
  ref: EntityRef;
  Type?: 'IfcCostValue' | 'IfcAppliedValue';
  Name?: string; Description?: string; AppliedValue?: CostAppliedValueData;
  UnitBasis?: EntityRef; InvalidUnitBasis?: boolean; ApplicableDate?: string;
  FixedUntilDate?: string; Category?: string; Condition?: string;
  InvalidCondition?: boolean; ArithmeticOperator?: string; Components?: EntityRef[];
  CostType?: string;
}

export interface CostItemData {
  ref: EntityRef;
  GlobalId?: string; Name?: string; Description?: string; ObjectType?: string;
  Identification?: string; PredefinedType?: string;
  CostValues?: EntityRef[]; CostQuantities?: EntityRef[];
}

export interface CostQuantityData {
  ref: EntityRef; Type: string; Name?: string; Description?: string; Unit?: EntityRef;
  InvalidUnit?: boolean; LengthValue?: string; AreaValue?: string; VolumeValue?: string;
  CountValue?: string; WeightValue?: string; TimeValue?: string; NumberValue?: string;
  Formula?: string; Dimension?: CostQuantityDimension; HasQuantities?: EntityRef[];
  InvalidHasQuantities?: boolean;
}

export interface CostUnitData {
  ref: EntityRef; Type: string; UnitType?: string; Prefix?: string; Name?: string;
  Symbol?: string; Currency?: string; Dimension?: CostQuantityDimension; Scale?: string;
}

export interface CostMeasureWithUnitData {
  ref: EntityRef; ValueComponent: string; UnitComponent: EntityRef;
  ValueType?: string; ValueDimension?: CostQuantityDimension;
}

export type CostRelationshipType =
  | 'IfcRelAssignsToControl' | 'IfcRelAssignsToProduct' | 'IfcRelAssignsToProcess'
  | 'IfcRelNests' | 'IfcRelDeclares' | 'IfcRelAssociatesAppliedValue'
  | 'IfcRelSchedulesCostItems' | 'IfcAppliedValueRelationship';

export interface CostRelationshipData {
  ref: EntityRef; Type: CostRelationshipType; GlobalId?: string; Name?: string;
  Description?: string; RelatedObjects?: EntityRef[]; InvalidRelatedObjects?: boolean;
  InvalidReferences?: boolean; RelatedDefinitions?: EntityRef[]; RelatingControl?: EntityRef;
  RelatingObject?: EntityRef; RelatingProduct?: EntityRef; RelatingProcess?: EntityRef;
  RelatingContext?: EntityRef; RelatingAppliedValue?: EntityRef; ComponentOfTotal?: EntityRef;
  Components?: EntityRef[]; ArithmeticOperator?: string;
}

export interface CostGraphData {
  modelId: string;
  source: 'loaded-source';
  SchemaVersion: CostSchemaVersion;
  CostSchedules: CostScheduleData[];
  CostItems: CostItemData[];
  CostValues: CostValueData[];
  CostQuantities: CostQuantityData[];
  Units: CostUnitData[];
  MeasuresWithUnit: CostMeasureWithUnitData[];
  ProjectUnits: Partial<Record<CostQuantityDimension, EntityRef>>;
  Relationships: CostRelationshipData[];
  Diagnostics: CostDiagnosticData[];
  HasCostData: boolean;
  Currency?: string;
}

export interface CostEvaluationOptions {
  /** Decimal significant-digit precision from 1 through 10,000. Defaults to 34 (decimal128). */
  Precision?: number;
}
export interface CostEvaluationData {
  ref: EntityRef; Amount?: string; Currency?: string;
  Dimension?: CostQuantityDimension | 'ratio'; QuantityApplied?: string;
  Diagnostics: CostDiagnosticData[];
}

/**
 * Whether a cost read observes the loaded model's PENDING edits (#4857).
 *
 * `includeMutations` defaults to `true` and means "the cost graph as this
 * session would export it": renames, retitles and deletions that are staged
 * in the model's edit overlay are already applied, so `bim.cost.*` and
 * `bim.export.ifc()` describe the same file.
 *
 * `includeMutations: false` means "the cost graph as the file on disk states
 * it" — the same answer the read model gave before any edit was made. It does
 * NOT mean an empty cost graph, and it does not mean "cost data is
 * unavailable": a model with cost entities and pending edits still reports
 * every one of those entities, at their on-disk values. The flag is the exact
 * mirror of `bim.export.ifc`'s option of the same name, which likewise
 * exports the unmutated file rather than an empty one.
 */
export interface CostReadOptions {
  includeMutations?: boolean;
}

export interface CostBackendMethods {
  data(modelId?: string, options?: CostReadOptions): CostGraphData;
  schedules(modelId?: string, options?: CostReadOptions): CostScheduleData[];
  items(modelId?: string, options?: CostReadOptions): CostItemData[];
  values(modelId?: string, options?: CostReadOptions): CostValueData[];
  evaluateItem(ref: EntityRef, options?: CostEvaluationOptions & CostReadOptions): CostEvaluationData;
  evaluateValue(ref: EntityRef, options?: CostEvaluationOptions & CostReadOptions): CostEvaluationData;
}
