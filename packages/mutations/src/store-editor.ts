/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * StoreEditor — high-level facade for editing a parsed `IfcDataStore` via the
 * `MutablePropertyView` overlay.
 *
 * Implements the `store.addEntity()` / `store.removeEntity()` /
 * `store.setPositionalAttribute()` API requested in louistrue/ifc-lite#592.
 *
 * The underlying store buffer and entity index are never mutated. Changes
 * accumulate in the overlay and materialise during
 * `StepExporter.export({ applyMutations })`. Overlay-created entities are
 * visible via `getNewEntity()` / `getNewEntities()`; they are intentionally
 * NOT inserted into `store.entityIndex.byId`, because that index may be a
 * `CompactEntityIndex` whose backing typed arrays are immutable.
 */

import type { MutablePropertyView } from './mutable-property-view.js';
import type {
  IfcAttributeValue,
  MutationEntityRef as EntityRef,
  MutationStoreShape as IfcDataStore,
  NewEntity,
} from './types.js';

/** Sentinel byteOffset that flags an `EntityRef` as overlay-only (no source bytes). */
export const OVERLAY_BYTE_OFFSET = -1;

export class StoreEditor {
  private store: IfcDataStore;
  private view: MutablePropertyView;
  private seeded = false;

  constructor(store: IfcDataStore, view: MutablePropertyView) {
    this.store = store;
    this.view = view;
    this.seedWatermark();
  }

  /**
   * Add a new entity to the store overlay. Returns a synthetic `EntityRef`
   * with a freshly-allocated expressId; pass it back to other APIs (other
   * `addEntity` calls, `setPositionalAttribute`, exporters) to reference
   * the new record.
   *
   * Attribute conventions (mirrors `EntityExtractor.extractEntity()` output):
   *   - numbers → STEP integer / REAL literal
   *   - `"#42"` → STEP entity reference
   *   - `"'literal'"` or any plain string → quoted STEP string
   *   - `".AREA."` (dot-wrapped) → enum
   *   - `null` / `undefined` → `$`
   *   - arrays → STEP list `(a,b,c)`
   */
  addEntity(type: string, attributes: IfcAttributeValue[]): EntityRef {
    this.seedWatermark();
    const created = this.view.createEntity(type, attributes);
    return {
      expressId: created.expressId,
      type: created.type,
      byteOffset: OVERLAY_BYTE_OFFSET,
      byteLength: 0,
      lineNumber: -1,
    };
  }

  /**
   * Remove an entity. Existing entities are tombstoned and skipped during
   * export; overlay-only entities are forgotten. Returns false if the id is
   * not known to the store or the overlay.
   */
  removeEntity(expressId: number): boolean {
    if (this.view.getNewEntity(expressId) !== null) {
      return this.view.deleteEntity(expressId);
    }
    if (!this.store.entityIndex.byId.has(expressId)) return false;
    return this.view.deleteEntity(expressId);
  }

  /**
   * Edit a positional STEP argument on any entity by zero-based index.
   * Use this for non-IfcRoot edits like `IfcRectangleProfileDef.XDim`
   * where the attribute has no symbolic name.
   */
  setPositionalAttribute(expressId: number, index: number, value: IfcAttributeValue): void {
    this.view.setPositionalAttribute(expressId, index, value);
  }

  /** Edit a named root attribute (Name, Description, ObjectType, …). */
  setAttribute(expressId: number, attrName: string, value: string): void {
    this.view.setAttribute(expressId, attrName, value);
  }

  /** Look up the overlay record for a freshly-added entity. */
  getNewEntity(expressId: number): NewEntity | null {
    return this.view.getNewEntity(expressId);
  }

  /** All overlay-created entities, in insertion order. */
  getNewEntities(): NewEntity[] {
    return this.view.getNewEntities();
  }

  private seedWatermark(): void {
    if (this.seeded) return;
    let max = 0;
    for (const id of this.store.entityIndex.byId.keys()) {
      if (id > max) max = id;
    }
    this.view.setExpressIdWatermark(max);
    this.seeded = true;
  }
}
