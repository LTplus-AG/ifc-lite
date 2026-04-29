/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { BimBackend, EntityRef } from '../types.js';

/**
 * `bim.store` — document-level edits on a parsed model.
 *
 * Use this for raw STEP edits that don't fit `bim.mutate.*`:
 *   - `addEntity` to inject a new entity record
 *   - `removeEntity` to drop an existing or newly-added entity
 *   - `setPositionalAttribute` to edit non-IfcRoot attributes by index
 *     (e.g. `IfcRectangleProfileDef.XDim`)
 *
 * For property-set / quantity / named-attribute edits use `bim.mutate.*`.
 * For building a model from scratch use `bim.create.*`.
 *
 * Changes accumulate in a per-model overlay and are flushed to the IFC
 * file on the next `bim.export.ifc({ applyMutations: true })`.
 */
export class StoreNamespace {
  constructor(private backend: BimBackend) {}

  /**
   * Inject a new entity into the active model. Returns an `EntityRef`
   * pointing at the freshly-allocated expressId.
   *
   * Attribute conventions (mirror `EntityExtractor.extractEntity()`):
   *   - numbers → STEP integer / REAL literal
   *   - `"#42"` → entity reference
   *   - `".AREA."` → enum
   *   - `null` → `$`
   *   - arrays → STEP list `(a,b,c)` (recursed)
   *   - any other string → quoted STEP string
   *
   * @example
   *   const profile = bim.store.addEntity('arch', {
   *     type: 'IFCRECTANGLEPROFILEDEF',
   *     attributes: ['.AREA.', null, '#34', 0.6, 0.4],
   *   });
   */
  addEntity(modelId: string, def: { type: string; attributes: unknown[] }): EntityRef {
    return this.backend.store.addEntity(modelId, def);
  }

  /**
   * Remove an entity. Tombstones existing source entities so they're
   * skipped on export; forgets overlay-only entities entirely. Returns
   * false if the id is unknown to the store.
   */
  removeEntity(ref: EntityRef): boolean {
    return this.backend.store.removeEntity(ref);
  }

  /**
   * Edit a positional STEP argument on any entity by zero-based index.
   * Use this for non-IfcRoot edits like `IfcRectangleProfileDef.XDim`
   * (index 3) where the attribute has no symbolic name.
   *
   * @example
   *   // Bump the rectangle profile width from 0.3 to 0.6
   *   bim.store.setPositionalAttribute(profileRef, 3, 0.6);
   */
  setPositionalAttribute(ref: EntityRef, index: number, value: unknown): void {
    this.backend.store.setPositionalAttribute(ref, index, value);
  }
}
