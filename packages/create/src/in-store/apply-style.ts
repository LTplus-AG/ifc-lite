/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Colour products by authoring real presentation-style entities into the store,
 * so the colour survives export instead of living in a viewer overlay.
 *
 * `bim.viewer.colorize` paints the current view and is gone the moment the
 * model is written out. Persisting the same colour meant hand-building the
 * style chain and walking `IfcProductDefinitionShape -> IfcShapeRepresentation
 * -> Items`, including the `IfcMappedItem` indirection, at every call site.
 *
 * Lives beside the other in-store builders so the backend layer can reach it
 * without parser internals, the same arrangement as `resolve-source.ts`.
 */

import { EntityExtractor, getAttributeNamesAcrossSchemas, type IfcDataStore } from '@ifc-lite/parser';
import type { IfcAttributeValue, StoreEditor } from '@ifc-lite/mutations';
import { emitSurfaceStyle, type SurfaceStyleColor } from './_emit-helpers.js';

export type { SurfaceStyleColor };

export interface StyleBatch {
  /** Products to colour, by expressId. */
  products: readonly number[];
  /** Channels in 0..1. */
  color: SurfaceStyleColor;
  /** `IfcSurfaceStyle.Name`. Omitted writes `$`. */
  name?: string;
}

export interface ApplyStyleOptions {
  /**
   * Replace a style the geometry already carries (default `true`). IFC allows
   * at most one `IfcStyledItem` per representation item, so adding a second
   * where one exists writes a schema-invalid file; the existing one is
   * tombstoned instead. Pass `false` to leave already-styled geometry alone.
   */
  replaceExisting?: boolean;
}

export interface ApplyStyleResult {
  /** The `IfcSurfaceStyle` every item styled by this batch now points at. */
  surfaceStyleId: number;
  /** One `IfcStyledItem` per representation item that was styled. */
  styledItemIds: number[];
  /** Products that reached no geometry: no representation, or an empty one. */
  productsWithoutGeometry: number[];
  /**
   * Pre-existing `IfcStyledItem` entities tombstoned to make room.
   *
   * Only the styled item is removed. The `IfcSurfaceStyle` it pointed at stays
   * in the file, detached: a style can be shared with styled items this call
   * never touched, so removing it is not safe in general, and an unreferenced
   * style definition is valid IFC.
   *
   * Empty whenever `replaceExisting` is `false`, which is when
   * `keptExistingItemIds` is the field carrying the answer.
   */
  replacedStyledItemIds: number[];
  /**
   * Representation items left alone because they already carried a style and
   * `replaceExisting` was `false`. Empty otherwise.
   */
  keptExistingItemIds: number[];
}

interface RawEntity {
  type: string;
  attributes: IfcAttributeValue[];
}

/**
 * A STEP reference as an expressId.
 *
 * Source-parsed entities carry refs as numbers; overlay-created ones carry the
 * `'#123'` strings `StoreEditor.addEntity` takes. Both reach this module, so
 * both forms have to resolve.
 */
function asRef(value: IfcAttributeValue | undefined): number | null {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.startsWith('#')) {
    const id = Number(value.slice(1));
    return Number.isInteger(id) ? id : null;
  }
  return null;
}

function refList(value: IfcAttributeValue | undefined): number[] {
  if (!Array.isArray(value)) return [];
  const out: number[] = [];
  for (const item of value) {
    const id = asRef(item);
    if (id !== null) out.push(id);
  }
  return out;
}

/**
 * Depth limit for the representation walk. Real nesting is three levels (shape
 * -> representation -> item, plus one hop through a mapped representation);
 * this only has to stop a malformed file from looping.
 */
const MAX_REPRESENTATION_DEPTH = 8;

/** Attribute indices that are fixed across every schema for these classes. */
const SHAPE_REPRESENTATIONS_INDEX = 2;    // IfcProductDefinitionShape.Representations
const REPRESENTATION_ITEMS_INDEX = 3;     // IfcShapeRepresentation.Items
const MAPPED_ITEM_SOURCE_INDEX = 0;       // IfcMappedItem.MappingSource
const MAPPED_REPRESENTATION_INDEX = 1;    // IfcRepresentationMap.MappedRepresentation
const STYLED_ITEM_TARGET_INDEX = 0;       // IfcStyledItem.Item

/**
 * Index of a named attribute on a class, resolved against the bundled schema
 * union rather than hardcoded.
 *
 * `Representation` is index 6 on `IfcProduct` but the same slot is
 * `RepresentationMaps` on `IfcTypeProduct` — a list, not a single ref. Reading
 * a constant 6 turns a type object handed in by a caller into a silent no-op
 * instead of an honest "no geometry". Same reasoning as `findAttrIndex` in
 * `@ifc-lite/export`'s demesh writer (#2032).
 */
function attributeIndex(typeName: string, attrName: string): number | null {
  const names = getAttributeNamesAcrossSchemas(typeName);
  const idx = names.indexOf(attrName);
  return idx >= 0 ? idx : null;
}

/**
 * The geometry a product is drawn from.
 *
 * An `IfcMappedItem` is followed through to the `IfcRepresentationMap` and the
 * mapped representation's items are styled rather than the mapped item. That is
 * what makes one style cover every occurrence of a type, and it is safe: a
 * representation map belongs to exactly one `IfcTypeProduct`, so it cannot
 * straddle two classes.
 *
 * Exported because three private copies of this walk already exist in
 * `extract-walls.ts` and one in `@ifc-lite/export`'s LOD generator, and none of
 * them follows mapped items. This is the complete one.
 */
export function collectLeafRepresentationItems(
  read: (id: number) => RawEntity | null,
  representationId: number,
  out: Set<number> = new Set(),
  depth = 0,
): Set<number> {
  if (depth > MAX_REPRESENTATION_DEPTH) return out;
  const entity = read(representationId);
  if (!entity) return out;

  const type = entity.type.toUpperCase();
  if (type === 'IFCPRODUCTDEFINITIONSHAPE') {
    for (const rep of refList(entity.attributes[SHAPE_REPRESENTATIONS_INDEX])) {
      collectLeafRepresentationItems(read, rep, out, depth + 1);
    }
    return out;
  }
  if (type === 'IFCSHAPEREPRESENTATION') {
    for (const item of refList(entity.attributes[REPRESENTATION_ITEMS_INDEX])) {
      collectLeafRepresentationItems(read, item, out, depth + 1);
    }
    return out;
  }
  if (type === 'IFCMAPPEDITEM') {
    const source = asRef(entity.attributes[MAPPED_ITEM_SOURCE_INDEX]);
    if (source === null) return out;
    const mapped = asRef(read(source)?.attributes[MAPPED_REPRESENTATION_INDEX]);
    if (mapped !== null) collectLeafRepresentationItems(read, mapped, out, depth + 1);
    return out;
  }
  out.add(representationId);
  return out;
}

/**
 * Read an entity by expressId, source buffer first and overlay second.
 *
 * `StoreEditor.addEntity` does not insert into `store.entityIndex`, so a
 * source-only reader cannot see anything created in the same session: styling a
 * wall from `bim.store.addWall` reported it as geometry-less and wrote an
 * orphan style. Mirrors `readEntity` in `extract-walls.ts`.
 */
function createReader(store: IfcDataStore, editor: StoreEditor): (id: number) => RawEntity | null {
  const extractor = new EntityExtractor(store.source);
  return (id: number): RawEntity | null => {
    const ref = store.entityIndex.byId.get(id) as
      { byteOffset: number; byteLength: number } | undefined;
    if (ref && ref.byteLength > 0 && ref.byteOffset >= 0) {
      const entity = extractor.extractEntity(
        ref as Parameters<EntityExtractor['extractEntity']>[0],
      );
      if (entity) return { type: entity.type, attributes: entity.attributes ?? [] };
    }
    const created = editor.getNewEntity(id);
    return created ? { type: created.type, attributes: created.attributes ?? [] } : null;
  };
}

/**
 * Every representation item that already carries an `IfcStyledItem`, keyed by
 * the item it styles.
 *
 * Built once per call and then maintained as styled items are added and
 * removed. Rebuilding it per batch was both the dominant cost of a
 * colour-by-class pass (87 ms per batch on a 92k-styled-item model) and a
 * correctness gap: a second batch could not see the first batch's styled items,
 * so overlapping geometry ended up with two of them.
 */
function indexExistingStyles(
  store: IfcDataStore,
  editor: StoreEditor,
  read: (id: number) => RawEntity | null,
): Map<number, number> {
  const styledBy = new Map<number, number>();
  for (const id of store.entityIndex.byType.get('IFCSTYLEDITEM') ?? []) {
    const target = asRef(read(id)?.attributes[STYLED_ITEM_TARGET_INDEX]);
    if (target !== null) styledBy.set(target, id);
  }
  for (const created of editor.getNewEntities()) {
    if (created.type.toUpperCase() !== 'IFCSTYLEDITEM') continue;
    const target = asRef(created.attributes?.[STYLED_ITEM_TARGET_INDEX]);
    if (target !== null) styledBy.set(target, created.expressId);
  }
  return styledBy;
}

/**
 * Give every representation item behind each batch's products one
 * `IfcSurfaceStyle`.
 *
 * Batches are applied in order, and a later batch wins where two of them reach
 * the same geometry. Writes through the `StoreEditor` overlay, so nothing
 * touches the source buffer and `StepExporter` picks the new entities up on
 * export.
 */
export function applyStylesInStore(
  editor: StoreEditor,
  store: IfcDataStore,
  batches: readonly StyleBatch[],
  options: ApplyStyleOptions = {},
): ApplyStyleResult[] {
  const replaceExisting = options.replaceExisting ?? true;
  const read = createReader(store, editor);
  const styledBy = indexExistingStyles(store, editor, read);

  return batches.map(batch => {
    const items = new Set<number>();
    const productsWithoutGeometry: number[] = [];

    for (const product of batch.products) {
      // Per product, then merged. Asking whether the shared set grew would call
      // every occurrence after the first "geometry-less" whenever a type's
      // occurrences share one mapped representation — which is most of them.
      const entity = read(product);
      const repIndex = entity ? attributeIndex(entity.type, 'Representation') : null;
      const representation = repIndex === null
        ? null
        : asRef(entity?.attributes[repIndex]);
      const reached = representation === null
        ? new Set<number>()
        : collectLeafRepresentationItems(read, representation);

      if (reached.size === 0) {
        productsWithoutGeometry.push(product);
        continue;
      }
      for (const item of reached) items.add(item);
    }

    const surfaceStyleId = emitSurfaceStyle(editor, store.schemaVersion, batch.color, batch.name);
    const styleRef = `#${surfaceStyleId.styleRefId}`;

    const styledItemIds: number[] = [];
    const replacedStyledItemIds: number[] = [];
    const keptExistingItemIds: number[] = [];

    for (const item of [...items].sort((a, b) => a - b)) {
      const existing = styledBy.get(item);
      if (existing !== undefined) {
        if (!replaceExisting) {
          keptExistingItemIds.push(item);
          continue;
        }
        editor.removeEntity(existing);
        styledBy.delete(item);
        replacedStyledItemIds.push(existing);
      }
      const styled = editor.addEntity('IfcStyledItem', [`#${item}`, [styleRef], null]);
      styledBy.set(item, styled.expressId);
      styledItemIds.push(styled.expressId);
    }

    return {
      surfaceStyleId: surfaceStyleId.surfaceStyleId,
      styledItemIds,
      productsWithoutGeometry,
      replacedStyledItemIds,
      keptExistingItemIds,
    };
  });
}
