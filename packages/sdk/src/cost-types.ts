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
  | 'DIVISION_BY_ZERO';

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

export interface CostBackendMethods {
  data(modelId?: string): CostGraphData;
  schedules(modelId?: string): CostScheduleData[];
  items(modelId?: string): CostItemData[];
  values(modelId?: string): CostValueData[];
  evaluateItem(ref: EntityRef, options?: CostEvaluationOptions): CostEvaluationData;
  evaluateValue(ref: EntityRef, options?: CostEvaluationOptions): CostEvaluationData;
}
