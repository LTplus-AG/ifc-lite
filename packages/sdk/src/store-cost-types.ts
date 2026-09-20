/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `bim.store.addCost*` / `nestCostItems` / `assignCostItemsToSchedule` /
 * `assignToCostItem` / `setCostItemValues` / `removeCostEntity` — loaded-model
 * cost authoring (#4857 PR A). Split out of `types.ts` (allowlisted at 847
 * lines, currently 774 — see `scripts/module-size-allowlist.txt`) so that
 * file's growth stays a couple of lines (one `extends`), not a whole surface.
 */

import type {
  CostItemParams, CostQuantityParams, CostScheduleParams, CostValueParams,
} from '@ifc-lite/create';
import type { EntityRef } from './types.js';

export interface CostStoreBackendMethods {
  addCostSchedule(modelId: string, params: CostScheduleParams): EntityRef;
  addCostItem(modelId: string, params: CostItemParams): EntityRef;
  addCostValue(modelId: string, params: CostValueParams): EntityRef;
  addCostQuantity(modelId: string, params: CostQuantityParams): EntityRef;
  /** Nest `childExpressIds` (IfcCostItem) under `parentExpressId` as `IfcRelNests`.
   *  A child already nested elsewhere is reparented. */
  nestCostItems(modelId: string, parentExpressId: number, childExpressIds: number[]): EntityRef;
  /** Assign `itemExpressIds` (IfcCostItem) to `scheduleExpressId` (IfcCostSchedule)'s control. */
  assignCostItemsToSchedule(modelId: string, scheduleExpressId: number, itemExpressIds: number[]): EntityRef;
  /** Assign `objectExpressIds` (products AND/OR tasks) to `costItemExpressId`'s control. */
  assignToCostItem(modelId: string, costItemExpressId: number, objectExpressIds: number[]): EntityRef;
  /** Replace `itemExpressId`'s `CostValues`. Pass `[]` to clear it (written as `$`). */
  setCostItemValues(modelId: string, itemExpressId: number, valueExpressIds: number[]): void;
  /**
   * Safe-delete an `IfcCostSchedule` / `IfcCostItem` / `IfcCostValue`. Throws,
   * naming referrers, if a value is still listed in another item's
   * `CostValues` or another value's `Components` — unless
   * `options.detach` is set, which rewrites those lists first. Deleting an
   * item detaches it from every `IfcRelNests` / `IfcRelAssignsToControl` and
   * cascades to values referenced ONLY by it.
   */
  removeCostEntity(modelId: string, expressId: number, options?: { detach?: boolean }): void;
}
