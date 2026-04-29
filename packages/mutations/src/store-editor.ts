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

/**
 * Schema-aware normaliser injected from outside the package.
 *
 * `@ifc-lite/mutations` cannot import `@ifc-lite/parser` (cycle), so
 * the canonical-name registry isn't reachable here. The SDK / viewer
 * boundary calls `setEntityTypeNormalizer` once at startup with the
 * parser's `normalizeIfcTypeName` helper, and from then on every
 * `addEntity()` call resolves to canonical PascalCase before forwarding
 * to the overlay. Direct callers that don't wire a normalizer fall
 * back to the lightweight regex check below — typos still surface,
 * just without registry-grade rejection.
 */
export type EntityTypeNormalizer = (type: string) => string;

let configuredNormalizer: EntityTypeNormalizer | null = null;

/**
 * Register the canonical-name resolver. Pass `null` to clear it (used
 * by tests). Calling repeatedly is fine — last write wins.
 */
export function setEntityTypeNormalizer(fn: EntityTypeNormalizer | null): void {
  configuredNormalizer = fn;
}

export class StoreEditor {
  private store: IfcDataStore;
  private view: MutablePropertyView;
  private maxExistingId: number;

  constructor(store: IfcDataStore, view: MutablePropertyView) {
    this.store = store;
    this.view = view;
    this.maxExistingId = this.computeMaxExistingId();
    this.view.setExpressIdWatermark(this.maxExistingId);
  }

  /**
   * Add a new entity to the store overlay. Returns a synthetic `EntityRef`
   * with a freshly-allocated expressId; pass it back to other APIs (other
   * `addEntity` calls, `setPositionalAttribute`, exporters) to reference
   * the new record.
   *
   * Pass `type` as the canonical IFC EXPRESS PascalCase name
   * (e.g. `'IfcRectangleProfileDef'`). UPPERCASE STEP tokens are also
   * accepted — both are normalized to the same internal form.
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
    // Defense in depth: reject obviously-invalid `type` at the editor
    // boundary so a typo doesn't end up as an invalid STEP record on
    // export. The SDK normalizes via the parser registry; this guard
    // catches direct-editor callers (CLI scripts, sandbox bridge,
    // unit tests) that don't go through that path.
    if (typeof type !== 'string') {
      throw new TypeError(`StoreEditor.addEntity: type must be a string, got ${typeof type}`);
    }
    const trimmed = type.trim();
    if (trimmed.length === 0) {
      throw new Error('StoreEditor.addEntity: type cannot be empty');
    }
    // STEP entity tokens always start with "IFC" / "Ifc". Accept either
    // PascalCase (`IfcWall`) or the all-caps STEP form (`IFCWALL`); the
    // exporter handles the case conversion at the file-format boundary.
    if (!/^[Ii][Ff][Cc][A-Za-z][A-Za-z0-9]*$/.test(trimmed)) {
      throw new Error(
        `StoreEditor.addEntity: type "${type}" is not a recognizable IFC entity name (expected e.g. "IfcWall")`,
      );
    }

    // When a schema-aware normaliser is configured, resolve the
    // canonical PascalCase name (e.g. "IFCWALL" → "IfcWall") and
    // reject typos that aren't in the registry. The `Ifc${string}`
    // shape passes the regex above but `IfcWal` would slip through;
    // the normaliser is what catches that.
    let canonical = trimmed;
    if (configuredNormalizer) {
      const resolved = configuredNormalizer(trimmed);
      if (!resolved) {
        throw new Error(
          `StoreEditor.addEntity: type "${type}" is not in the IFC schema registry (typo? vendor extension?)`,
        );
      }
      canonical = resolved;
    }

    // Re-seed every call: cheap (one comparison + at most one write inside the
    // view), and recovers from `view.clear()`, which resets the allocator to 0
    // and would otherwise hand out colliding ids on the next addEntity().
    this.view.setExpressIdWatermark(this.maxExistingId);
    const created = this.view.createEntity(canonical, attributes);
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

  private computeMaxExistingId(): number {
    let max = 0;
    for (const id of this.store.entityIndex.byId.keys()) {
      if (id > max) max = id;
    }
    return max;
  }
}
