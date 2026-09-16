/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Schema-aware, read-only IFC cost graph types. */

import type { CollectedQuantity } from './quantity-collect.js';

export type { CollectedQuantity };

export type CostSchemaVersion = 'IFC2X3' | 'IFC4' | 'IFC4X3' | 'IFC5';

export type CostDiagnosticCode =
  | 'IFC2X3_PARTIAL_READ'
  | 'UNSUPPORTED_SCHEMA'
  | 'MISSING_REFERENCE'
  | 'INVALID_LIST'
  | 'MULTIPLE_NESTING_PARENTS'
  | 'NESTING_CYCLE'
  | 'QUANTITY_CYCLE'
  | 'VALUE_CYCLE'
  | 'MISSING_VALUE'
  | 'INVALID_NUMBER'
  | 'UNSUPPORTED_APPLIED_VALUE'
  | 'UNSUPPORTED_CONDITION'
  | 'UNSUPPORTED_UNIT'
  | 'INCOMPATIBLE_UNIT'
  | 'MISSING_CURRENCY'
  | 'MIXED_CURRENCY'
  | 'DIVISION_BY_ZERO';

export interface CostDiagnostic {
  Code: CostDiagnosticCode;
  Message: string;
  Severity: 'warning' | 'error';
  expressId?: number;
  RelatedExpressId?: number;
}

export interface CostScheduleInfo {
  expressId: number;
  GlobalId?: string;
  Name?: string;
  Description?: string;
  ObjectType?: string;
  Identification?: string;
  PredefinedType?: string;
  Status?: string;
  SubmittedOn?: string;
  UpdateDate?: string;
  /** IFC2X3-only identifier. */
  ID?: string;
  /** @deprecated Use the exact IFC-cased field. */
  globalId: string;
  /** @deprecated Use the exact IFC-cased field. */
  name: string;
  /** @deprecated Use PredefinedType. */
  predefinedType?: string;
  /** @deprecated Use Status. */
  status?: string;
  /** @deprecated Use SubmittedOn. */
  submittedOn?: string;
  /** @deprecated Use UpdateDate. */
  updateDate?: string;
  /** Existing normalized schedule-root convenience view. */
  costItemGlobalIds: string[];
}

export interface CostItemInfo {
  expressId: number;
  GlobalId?: string;
  Name?: string;
  Description?: string;
  ObjectType?: string;
  Identification?: string;
  PredefinedType?: string;
  /** Ordered IFC4/IFC4X3 attribute references. Undefined means absent. */
  CostValues?: number[];
  /** Ordered IFC4/IFC4X3 attribute references. Undefined means absent. */
  CostQuantities?: number[];
  /** @deprecated Use the exact IFC-cased field. */
  globalId: string;
  /** @deprecated Use the exact IFC-cased field. */
  name: string;
  /** @deprecated Use PredefinedType. */
  predefinedType?: string;
  /** Existing normalized quantity view; never falls back to product Qto. */
  costQuantities?: CollectedQuantity[];
  /** Existing nested value view retained for compatibility. */
  costValues?: CostValueInfo[];
  parentGlobalId?: string;
  childGlobalIds: string[];
  productExpressIds: number[];
  productGlobalIds: string[];
  controllingScheduleGlobalIds: string[];
}

export interface CostValueUnitBasis {
  valueComponent?: number;
  unitSymbol?: string;
  unitSiScale?: number;
}

export type CostAppliedValue =
  | { Kind: 'Typed'; Type: string; Value: string }
  | { Kind: 'Reference'; expressId: number }
  | { Kind: 'Unsupported'; Raw: unknown; InvalidNumber?: boolean };

export interface CostValueInfo {
  /** Present on values returned by the schema-aware extractor. Optional for source compatibility. */
  expressId?: number;
  /** Present on values returned by the schema-aware extractor. Optional for source compatibility. */
  Type?: 'IfcCostValue' | 'IfcAppliedValue';
  Name?: string;
  Description?: string;
  AppliedValue?: CostAppliedValue;
  UnitBasis?: number;
  /** The source supplied UnitBasis but it was not an entity reference. */
  InvalidUnitBasis?: boolean;
  ApplicableDate?: string;
  FixedUntilDate?: string;
  Category?: string;
  Condition?: string;
  /** The source supplied Condition with a non-string representation. */
  InvalidCondition?: boolean;
  ArithmeticOperator?: string;
  /** Ordered references; shared references retain their original expressId. */
  Components?: number[];
  /** IFC2X3-only equivalent of Category. */
  CostType?: string;
  /** @deprecated Use the exact IFC-cased field. */
  name?: string;
  /** @deprecated Use the exact IFC-cased field. */
  description?: string;
  /** @deprecated Use AppliedValue. */
  appliedValue?: number;
  /** Existing resolved rate basis view. */
  unitBasis?: CostValueUnitBasis;
  applicableDate?: string;
  fixedUntilDate?: string;
  category?: string;
  condition?: string;
  arithmeticOperator?: string;
  /** Existing nested component view. Shared identity is available in Components. */
  components?: CostValueInfo[];
}

export type CostQuantityDimension =
  | 'length'
  | 'area'
  | 'volume'
  | 'mass'
  | 'time'
  | 'count'
  | 'number';

export interface CostQuantityInfo {
  expressId: number;
  Type: string;
  Name?: string;
  Description?: string;
  Unit?: number;
  /** The source supplied Unit but it was not an entity reference. */
  InvalidUnit?: boolean;
  LengthValue?: string;
  AreaValue?: string;
  VolumeValue?: string;
  CountValue?: string;
  WeightValue?: string;
  TimeValue?: string;
  NumberValue?: string;
  Formula?: string;
  Dimension?: CostQuantityDimension;
  /** IfcPhysicalComplexQuantity children, in source order. */
  HasQuantities?: number[];
  /** The source aggregate contained a non-reference member. */
  InvalidHasQuantities?: boolean;
}

export interface CostUnitInfo {
  expressId: number;
  Type: string;
  UnitType?: string;
  Prefix?: string;
  Name?: string;
  Symbol?: string;
  Currency?: string;
  Dimension?: CostQuantityDimension;
  /** Decimal multiplier into the dimension's canonical SI unit. */
  Scale?: string;
}

export interface CostMeasureWithUnitInfo {
  expressId: number;
  ValueComponent: string;
  UnitComponent: number;
  ValueType?: string;
  ValueDimension?: CostQuantityDimension;
}

export type CostRelationshipType =
  | 'IfcRelAssignsToControl'
  | 'IfcRelAssignsToProduct'
  | 'IfcRelAssignsToProcess'
  | 'IfcRelNests'
  | 'IfcRelDeclares'
  | 'IfcRelAssociatesAppliedValue'
  | 'IfcRelSchedulesCostItems'
  | 'IfcAppliedValueRelationship';

/**
 * Exact relationship endpoints are retained instead of flattened ID arrays.
 * Only attributes present on a relationship kind are populated.
 */
export interface CostRelationshipInfo {
  expressId: number;
  Type: CostRelationshipType;
  GlobalId?: string;
  Name?: string;
  Description?: string;
  RelatedObjects?: number[];
  /** The source RelatedObjects aggregate contained a non-reference member. */
  InvalidRelatedObjects?: boolean;
  /** One or more source endpoints were present but not STEP references. */
  InvalidReferences?: boolean;
  RelatedDefinitions?: number[];
  RelatingControl?: number;
  RelatingObject?: number;
  RelatingProduct?: number;
  RelatingProcess?: number;
  RelatingContext?: number;
  RelatingAppliedValue?: number;
  ComponentOfTotal?: number;
  Components?: number[];
  ArithmeticOperator?: string;
}

/** Backward-compatible normalized extraction shape. */
export interface CostExtraction {
  costSchedules: CostScheduleInfo[];
  costItems: CostItemInfo[];
  hasCost: boolean;
  SchemaVersion?: CostSchemaVersion;
  CostSchedules?: CostScheduleInfo[];
  CostItems?: CostItemInfo[];
  CostValues?: CostValueInfo[];
  CostQuantities?: CostQuantityInfo[];
  Units?: CostUnitInfo[];
  MeasuresWithUnit?: CostMeasureWithUnitInfo[];
  ProjectUnits?: Partial<Record<CostQuantityDimension, number>>;
  Relationships?: CostRelationshipInfo[];
  Diagnostics?: CostDiagnostic[];
  HasCostData?: boolean;
  Currency?: string;
}

/** Complete schema-aware graph returned by {@link extractCostOnDemand}. */
export interface CostGraphExtraction extends CostExtraction {
  SchemaVersion: CostSchemaVersion;
  CostSchedules: CostScheduleInfo[];
  CostItems: CostItemInfo[];
  CostValues: CostValueInfo[];
  CostQuantities: CostQuantityInfo[];
  Units: CostUnitInfo[];
  MeasuresWithUnit: CostMeasureWithUnitInfo[];
  ProjectUnits: Partial<Record<CostQuantityDimension, number>>;
  Relationships: CostRelationshipInfo[];
  Diagnostics: CostDiagnostic[];
  HasCostData: boolean;
  /** Project currency, when supplied by IfcUnitAssignment. */
  Currency?: string;
}

export interface CostEvaluationResult {
  expressId: number;
  Amount?: string;
  Currency?: string;
  Dimension?: CostQuantityDimension | 'ratio';
  QuantityApplied?: string;
  Diagnostics: CostDiagnostic[];
}

export interface CostEvaluationOptions {
  /** Decimal significant-digit precision from 1 through 10,000. Defaults to 34 (decimal128). */
  Precision?: number;
}
