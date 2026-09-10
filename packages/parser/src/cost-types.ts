/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Read-model types for the cost (5D) extractor. See `cost-extractor.ts` for
 * the extraction logic and the relationship-wiring rationale.
 */

import type { CollectedQuantity } from './quantity-collect.js';

export type { CollectedQuantity };

/**
 * One `IfcCostValue` (a subtype of `IfcAppliedValue` that adds no attributes
 * of its own — `packages/codegen/schemas/IFC4_ADD2_TC1.exp` /
 * `IFC4X3.exp`: `ENTITY IfcCostValue SUBTYPE OF (IfcAppliedValue); END_ENTITY;`).
 * Every field below is `IfcAppliedValue`'s own, per its EXPRESS definition.
 */
export interface CostValueInfo {
  name?: string;
  description?: string;
  /**
   * `AppliedValue` is an `IfcAppliedValueSelect` — in practice almost always
   * an `IfcMonetaryMeasure`/`IfcNumericMeasure`/`IfcRatioMeasure` typed
   * numeric wrapper. Resolved to a plain number when the wrapped value reads
   * as one; left `undefined` when it selects a non-numeric member (e.g. an
   * `IfcMeasureWithUnit` reference) this extractor does not resolve.
   */
  appliedValue?: number;
  applicableDate?: string;
  fixedUntilDate?: string;
  category?: string;
  condition?: string;
  arithmeticOperator?: string;
  /** Nested `IfcCostValue` components (`Components : OPTIONAL LIST [1:?] OF IfcAppliedValue`). */
  components?: CostValueInfo[];
}

/**
 * One `IfcCostItem`. Mirrors `ScheduleTaskInfo`'s shape in `schedule-extractor.ts`.
 *
 * `costQuantities` is `undefined` when `CostQuantities` is absent (the
 * schema's `LIST [1:?]` forbids an empty-but-declared list, so `undefined`
 * is the only "nothing here" state) or when every referenced quantity failed
 * to resolve. It is never a fallback to a product's `Qto_` quantities — see
 * `cost-extractor.ts` for why.
 *
 * `productExpressIds`/`productGlobalIds` use an empty array as a genuine
 * "no products assigned" state, distinct from "not resolved".
 */
export interface CostItemInfo {
  expressId: number;
  globalId: string;
  name: string;
  predefinedType?: string;
  costQuantities?: CollectedQuantity[];
  costValues?: CostValueInfo[];
  /** Parent cost item globalId (from IfcRelNests where this item is in RelatedObjects). */
  parentGlobalId?: string;
  /** Child cost item globalIds (from IfcRelNests where this item is RelatingObject). */
  childGlobalIds: string[];
  /** expressIds of objects/products this cost item is assigned to via IfcRelAssignsToControl. */
  productExpressIds: number[];
  /** globalIds of the same products (index-aligned with productExpressIds). */
  productGlobalIds: string[];
  /** CostSchedule globalIds that control this cost item via IfcRelAssignsToControl. */
  controllingScheduleGlobalIds: string[];
}

export interface CostScheduleInfo {
  expressId: number;
  globalId: string;
  name: string;
  predefinedType?: string;
  status?: string;
  submittedOn?: string;
  updateDate?: string;
  /** Top-level cost item globalIds directly assigned via IfcRelAssignsToControl. */
  costItemGlobalIds: string[];
}

export interface CostExtraction {
  costSchedules: CostScheduleInfo[];
  costItems: CostItemInfo[];
  /** True if we encountered any costing entity (useful for empty-state UI). */
  hasCost: boolean;
}
