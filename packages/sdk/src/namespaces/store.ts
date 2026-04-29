/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { normalizeIfcTypeName } from '@ifc-lite/parser';
import type {
  AddBeamInStoreParams,
  AddColumnInStoreParams,
  AddSlabInStoreParams,
  AddWallInStoreParams,
  BimBackend,
  EntityRef,
} from '../types.js';

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
   * Pass `def.type` as the canonical IFC EXPRESS PascalCase name
   * (e.g. `'IfcRectangleProfileDef'`). UPPERCASE STEP tokens are also
   * accepted and silently normalized to PascalCase against the schema
   * registry, so the returned `entity.type` always reflects the
   * canonical form regardless of how the caller spelled it.
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
   *     type: 'IfcRectangleProfileDef',
   *     attributes: ['.AREA.', null, '#34', 0.6, 0.4],
   *   });
   */
  addEntity(modelId: string, def: { type: string; attributes: unknown[] }): EntityRef {
    return this.backend.store.addEntity(modelId, {
      type: normalizeIfcTypeName(def.type),
      attributes: def.attributes,
    });
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

  /**
   * Add an IfcColumn to a parsed model, anchored to an existing storey.
   * Emits the full STEP sub-graph (placement, profile, extruded solid,
   * representation, IfcRelContainedInSpatialStructure) into the overlay
   * so the column appears next to the existing model on export.
   *
   * `Position` is the base centre in storey-local coordinates (metres),
   * `Width`×`Depth` is the centred rectangular cross-section, and
   * `Height` is the +Z extrusion length.
   *
   * @example
   *   const storeyId = bim.query.byType('IfcBuildingStorey')[0].ref.expressId;
   *   const col = bim.store.addColumn('arch', storeyId, {
   *     Position: [1, 1, 0],
   *     Width: 0.3, Depth: 0.4, Height: 3,
   *     Name: 'Column 1',
   *   });
   */
  addColumn(modelId: string, storeyExpressId: number, params: AddColumnInStoreParams): EntityRef {
    return this.backend.store.addColumn(modelId, storeyExpressId, params);
  }

  /**
   * Add an IfcWall from `Start` to `End` (storey-local metres). Profile
   * spans the full length along the wall axis, centred on `Thickness`,
   * and is extruded upward by `Height`.
   *
   * @example
   *   bim.store.addWall('arch', storeyId, {
   *     Start: [0, 0, 0], End: [5, 0, 0],
   *     Thickness: 0.2, Height: 3, Name: 'North Wall',
   *   });
   */
  addWall(modelId: string, storeyExpressId: number, params: AddWallInStoreParams): EntityRef {
    return this.backend.store.addWall(modelId, storeyExpressId, params);
  }

  /**
   * Add an IfcSlab. `Position` is the minimum corner; the slab extends
   * `Width` along +X, `Depth` along +Y, and is extruded `Thickness`
   * upward.
   */
  addSlab(modelId: string, storeyExpressId: number, params: AddSlabInStoreParams): EntityRef {
    return this.backend.store.addSlab(modelId, storeyExpressId, params);
  }

  /**
   * Add an IfcBeam between `Start` and `End` with a centred rectangular
   * cross-section (`Width` × `Height`). Local Z is the beam axis so the
   * extrusion runs along the beam.
   */
  addBeam(modelId: string, storeyExpressId: number, params: AddBeamInStoreParams): EntityRef {
    return this.backend.store.addBeam(modelId, storeyExpressId, params);
  }
}
