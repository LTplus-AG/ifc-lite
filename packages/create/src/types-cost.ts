/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Parameter types for the 5D / cost authoring API (IfcCostSchedule,
 * IfcCostItem, IfcCostValue and the units, quantities and relationships they
 * reference).
 *
 * Kept out of `types.ts` so that file stays under its recorded module-size
 * budget (`scripts/module-size-allowlist.txt`).
 *
 * ABSENT IS NOT EMPTY. Every optional field here means "the source did not
 * supply this", and is written as STEP `$`. A LIST-valued field (`CostValues`,
 * `CostQuantities`, `Components`) is declared `[1:?]` in EXPRESS, so an EMPTY
 * array is not a way of spelling "absent" — it is a malformed list, and the
 * builder rejects it rather than silently degrading it to `$`. The cost read
 * model draws the same distinction (`CostItemInfo.CostValues` is `undefined`
 * when the attribute is absent and `[]` only when it was present and invalid),
 * so conflating the two here would make the round trip lie.
 */

/** IfcCostScheduleTypeEnum (IFC4 / IFC4X3). */
export type CostSchedulePredefinedType =
  | 'BUDGET' | 'COSTPLAN' | 'ESTIMATE' | 'TENDER'
  | 'PRICEDBILLOFQUANTITIES' | 'UNPRICEDBILLOFQUANTITIES' | 'SCHEDULEOFRATES'
  | 'USERDEFINED' | 'NOTDEFINED';

/** IfcCostItemTypeEnum (IFC4 / IFC4X3). */
export type CostItemPredefinedType = 'USERDEFINED' | 'NOTDEFINED';

/** IfcArithmeticOperatorEnum. */
export type CostArithmeticOperator = 'ADD' | 'DIVIDE' | 'MULTIPLY' | 'SUBTRACT';

/**
 * The SELECT branch names this builder will write for a typed IFC value.
 *
 * `IfcCostValue.AppliedValue` is an `IfcAppliedValueSelect` and
 * `IfcMeasureWithUnit.ValueComponent` is an `IfcValue` — both SELECTs, so STEP
 * requires the branch to be named: `IFCMONETARYMEASURE(12.5)`, never a bare
 * `12.5`. A bare number parses but resolves to a different SELECT branch (or
 * to none), which is why the branch is part of the parameter rather than
 * inferred from the number.
 */
export type CostMeasureType =
  | 'IfcMonetaryMeasure'
  | 'IfcAreaMeasure' | 'IfcVolumeMeasure' | 'IfcLengthMeasure'
  | 'IfcMassMeasure' | 'IfcTimeMeasure' | 'IfcCountMeasure'
  | 'IfcNumericMeasure' | 'IfcRatioMeasure' | 'IfcReal' | 'IfcInteger';

/** A typed IFC measure: the SELECT branch plus its numeric value. */
export interface CostTypedValue {
  Type: CostMeasureType;
  Value: number;
}

/** IfcUnitEnum values this builder can write as an IfcSIUnit. */
export type CostSIUnitType =
  | 'LENGTHUNIT' | 'AREAUNIT' | 'VOLUMEUNIT' | 'MASSUNIT' | 'TIMEUNIT';

/** IfcSIUnit — the unit an IfcMeasureWithUnit or an IfcPhysicalQuantity names. */
export interface SIUnitParams {
  UnitType: CostSIUnitType;
  /** IfcSIPrefix (e.g. 'MILLI', 'KILO'). Absent means the unprefixed SI unit. */
  Prefix?: string;
  /** IfcSIUnitName, e.g. 'SQUARE_METRE'. */
  Name: string;
}

/** IfcCostSchedule (IfcControl). */
export interface CostScheduleParams {
  Name: string;
  Description?: string;
  ObjectType?: string;
  Identification?: string;
  PredefinedType?: CostSchedulePredefinedType;
  Status?: string;
  /** IfcDateTime, e.g. '2026-03-01T09:00:00'. */
  SubmittedOn?: string;
  /** IfcDateTime. */
  UpdateDate?: string;
}

/** IfcCostItem. */
export interface CostItemParams {
  Name: string;
  Description?: string;
  ObjectType?: string;
  Identification?: string;
  PredefinedType?: CostItemPredefinedType;
  /**
   * expressIds of IfcCostValue / IfcAppliedValue entities, in the order they
   * must appear. Absent (undefined) writes `$`; an empty array is rejected.
   */
  CostValues?: number[];
  /**
   * expressIds of IfcPhysicalQuantity entities, in order. Absent writes `$`;
   * an empty array is rejected.
   */
  CostQuantities?: number[];
}

/**
 * IfcCostValue.
 *
 * `AppliedValue` and `Components` are NOT interchangeable and this builder
 * never derives one from the other: a value that carried a literal
 * `AppliedValue` in the source is written with that literal and no
 * `Components`, and a value that was the sum of its `Components` is written
 * with `Components` and an absent `AppliedValue`. Normalising either way would
 * change what the file says about where the number came from.
 */
export interface CostValueParams {
  Name?: string;
  Description?: string;
  /** Literal typed value, written as a named SELECT branch. */
  AppliedValue?: CostTypedValue;
  /**
   * expressId of an IfcMeasureWithUnit, the entity branch of
   * IfcAppliedValueSelect. Mutually exclusive with `AppliedValue`.
   */
  AppliedValueRef?: number;
  /**
   * expressId of an IfcMeasureWithUnit giving the basis this rate is quoted
   * per — a rate "per 100 m²" has a UnitBasis of 100 SQUARE_METRE. It is a
   * divisor, not a label: dropping or inventing it moves the amount by whole
   * orders of magnitude.
   */
  UnitBasis?: number;
  /** IfcDate. */
  ApplicableDate?: string;
  /** IfcDate. */
  FixedUntilDate?: string;
  Category?: string;
  Condition?: string;
  ArithmeticOperator?: CostArithmeticOperator;
  /**
   * expressIds of the IfcAppliedValue / IfcCostValue entities this value is
   * computed from, in order. Absent writes `$`; an empty array is rejected.
   * Repeating an expressId shares that entity rather than copying it.
   */
  Components?: number[];
}

/** The IfcPhysicalSimpleQuantity subtypes a cost item can take quantities from. */
export type CostQuantityKind =
  | 'IfcQuantityLength' | 'IfcQuantityArea' | 'IfcQuantityVolume'
  | 'IfcQuantityWeight' | 'IfcQuantityTime' | 'IfcQuantityCount'
  | 'IfcQuantityNumber';

/** IfcPhysicalSimpleQuantity, as referenced from IfcCostItem.CostQuantities. */
export interface CostQuantityParams {
  Kind: CostQuantityKind;
  Name: string;
  Value: number;
  Description?: string;
  /** expressId of the unit entity this quantity is measured in. */
  Unit?: number;
  Formula?: string;
}
