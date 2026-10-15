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

import type { CostStoreBackendMethods } from '../index.js';

import { unsupportedOperation } from './capabilities.js';

export function costStoreStubs(): CostStoreBackendMethods {
  return {
    addCostSchedule: unsupportedOperation('store.addCostSchedule', 'addCostSchedule not supported in MCP v0.1; use entity_create'),
    addCostItem: unsupportedOperation('store.addCostItem', 'addCostItem not supported in MCP v0.1; use entity_create'),
    addCostValue: unsupportedOperation('store.addCostValue', 'addCostValue not supported in MCP v0.1; use entity_create'),
    addCostQuantity: unsupportedOperation('store.addCostQuantity', 'addCostQuantity not supported in MCP v0.1; use entity_create'),
    nestCostItems: unsupportedOperation('store.nestCostItems', 'nestCostItems not supported in MCP v0.1; use entity_create'),
    assignCostItemsToSchedule: unsupportedOperation('store.assignCostItemsToSchedule', 'assignCostItemsToSchedule not supported in MCP v0.1; use entity_create'),
    assignToCostItem: unsupportedOperation('store.assignToCostItem', 'assignToCostItem not supported in MCP v0.1; use entity_create'),
    setCostItemValues: unsupportedOperation('store.setCostItemValues', 'setCostItemValues not supported in MCP v0.1; use entity_create'),
    removeCostEntity: unsupportedOperation('store.removeCostEntity', 'removeCostEntity not supported in MCP v0.1; use entity_create'),
  };
}
