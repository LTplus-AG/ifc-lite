/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `bim.store.addCost*` / `nestCostItems` / `assignCostItemsToSchedule` /
 * `assignToCostItem` / `setCostItemValues` / `removeCostEntity` stubs for the
 * MCP v0.1 headless backend (#4857 PR A) — the same convention
 * `headless-backend.ts`'s `addColumn`/`addWall`/etc. already use: agent flows
 * go through `entity_create` with raw attributes, not the high-level
 * builders, so these throw loudly rather than silently no-op. `bim.cost`
 * READS already observe whatever `entity_create` authors, once the model's
 * `MutablePropertyView` is threaded into `createCostBackend` — see
 * `headless-backend.ts`'s `this.cost` construction.
 */

import type { CostStoreBackendMethods } from '@ifc-lite/sdk';

const unsupported = (method: string) => (): never => {
  throw new Error(`${method} not supported in MCP v0.1; use entity_create`);
};

export function costStoreStubs(): CostStoreBackendMethods {
  return {
    addCostSchedule: unsupported('addCostSchedule'),
    addCostItem: unsupported('addCostItem'),
    addCostValue: unsupported('addCostValue'),
    addCostQuantity: unsupported('addCostQuantity'),
    nestCostItems: unsupported('nestCostItems'),
    assignCostItemsToSchedule: unsupported('assignCostItemsToSchedule'),
    assignToCostItem: unsupported('assignToCostItem'),
    setCostItemValues: unsupported('setCostItemValues'),
    removeCostEntity: unsupported('removeCostEntity'),
  };
}
