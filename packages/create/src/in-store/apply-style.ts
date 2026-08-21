/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Colour products by authoring real presentation-style entities into the store,
 * so the colour survives export instead of living in a viewer overlay.
 *
 * `bim.viewer.colorize` paints the current view and is gone the moment the
 * model is written out. Persisting the same colour meant hand-building the
 * `IfcColourRgb -> IfcSurfaceStyleShading -> IfcSurfaceStyle -> IfcStyledItem`
 * chain and walking `IfcProductDefinitionShape -> IfcShapeRepresentation ->
 * Items`, including the `IfcMappedItem` indirection, at every call site.
 *
 * Lives beside the other in-store builders so the backend layer can reach it
 * without parser internals, the same arrangement as `resolve-source.ts`.
 */

import { EntityExtractor, type IfcDataStore } from '@ifc-lite/parser';
import type { IfcAttributeValue, StoreEditor } from '@ifc-lite/mutations';

/** An RGB colour with channels in 0..1. */
export interface SurfaceStyleColor {
  red: number;
  green: number;
  blue: number;
  /** 1 is opaque. Written as `IfcSurfaceStyleShading.Transparency = 1 - alpha`. */
  alpha?: number;
}

export interface ApplyStyleParams {
  /** Products to colour, by expressId. */
  products: readonly number[];
  /** `#rgb`, `#rrggbb`, or channels in 0..1. */
  color: SurfaceStyleColor | string;
  /** `IfcSurfaceStyle.Name`. Omitted writes `$`. */
  name?: string;
  /**
   * Replace a style the geometry already carries (default `true`). IFC allows
   * at most one `IfcStyledItem` per representation item, so adding a second
   * where one exists writes a schema-invalid file; the existing one is
   * tombstoned instead. Pass `false` to leave already-styled geometry alone.
   */
  replaceExisting?: boolean;
}

export interface ApplyStyleResult {
  /** The `IfcSurfaceStyle` every styled item now points at. */
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
   */
  replacedStyledItemIds: number[];
  /**
   * Representation items left alone because they already carried a style and
   * `replaceExisting` was `false`.
   */
  keptExistingItemIds: number[];
}

/** Guards a caller's 0..255 or out-of-range channel from reaching STEP. */
function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
}

function parseColor(color: SurfaceStyleColor | string): Required<SurfaceStyleColor> {
  if (typeof color !== 'string') {
    return {
      red: clamp01(color.red),
      green: clamp01(color.green),
      blue: clamp01(color.blue),
      alpha: clamp01(color.alpha ?? 1),
    };
  }
  const hex = color.startsWith('#') ? color.slice(1) : color;
  const full = hex.length === 3 ? hex.split('').map(c => c + c).join('') : hex;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) {
    throw new Error(`applyStyleInStore: "${color}" is not a #rgb or #rrggbb colour`);
  }
  const n = parseInt(full, 16);
  return {
    red: ((n >> 16) & 255) / 255,
    green: ((n >> 8) & 255) / 255,
    blue: (n & 255) / 255,
    alpha: 1,
  };
}

interface RawEntity {
  type: string;
  attributes: IfcAttributeValue[];
}

function refList(value: IfcAttributeValue | undefined): number[] {
  if (!Array.isArray(value)) return [];
  const out: number[] = [];
  for (const item of value) if (typeof item === 'number') out.push(item);
  return out;
}

/**
 * Depth limit for the representation walk. Real nesting is three levels (shape
 * -> representation -> item, plus one hop through a mapped representation);
 * this only has to stop a malformed file from looping.
 */
const MAX_REPRESENTATION_DEPTH = 8;

/** Attribute indices on the entities the walk passes through. */
const PRODUCT_REPRESENTATION_INDEX = 6;   // IfcProduct.Representation
const SHAPE_REPRESENTATIONS_INDEX = 2;    // IfcProductDefinitionShape.Representations
const REPRESENTATION_ITEMS_INDEX = 3;     // IfcShapeRepresentation.Items
const MAPPED_ITEM_SOURCE_INDEX = 0;       // IfcMappedItem.MappingSource
const MAPPED_REPRESENTATION_INDEX = 1;    // IfcRepresentationMap.MappedRepresentation
const STYLED_ITEM_TARGET_INDEX = 0;       // IfcStyledItem.Item

/**
 * The geometry a product is drawn from.
 *
 * An `IfcMappedItem` is followed through to the `IfcRepresentationMap` it
 * points at, and the mapped representation's own items are styled rather than
 * the mapped item. That is what makes one style cover every occurrence of a
 * type, and it is safe: a representation map belongs to exactly one
 * `IfcTypeProduct`, so it cannot straddle two classes.
 */
function collectLeafItems(
  read: (id: number) => RawEntity | null,
  id: number,
  out: Set<number>,
  depth = 0,
): void {
  if (depth > MAX_REPRESENTATION_DEPTH) return;
  const entity = read(id);
  if (!entity) return;

  if (entity.type === 'IFCPRODUCTDEFINITIONSHAPE') {
    for (const rep of refList(entity.attributes[SHAPE_REPRESENTATIONS_INDEX])) {
      collectLeafItems(read, rep, out, depth + 1);
    }
    return;
  }
  if (entity.type === 'IFCSHAPEREPRESENTATION') {
    for (const item of refList(entity.attributes[REPRESENTATION_ITEMS_INDEX])) {
      collectLeafItems(read, item, out, depth + 1);
    }
    return;
  }
  if (entity.type === 'IFCMAPPEDITEM') {
    const source = entity.attributes[MAPPED_ITEM_SOURCE_INDEX];
    if (typeof source !== 'number') return;
    const map = read(source);
    const mapped = map?.attributes[MAPPED_REPRESENTATION_INDEX];
    if (typeof mapped === 'number') collectLeafItems(read, mapped, out, depth + 1);
    return;
  }
  out.add(id);
}

/**
 * Give every representation item behind `products` one `IfcSurfaceStyle`.
 *
 * Writes through the `StoreEditor` overlay, so nothing touches the source
 * buffer and `StepExporter` picks the new entities up on export.
 */
export function applyStyleInStore(
  editor: StoreEditor,
  store: IfcDataStore,
  params: ApplyStyleParams,
): ApplyStyleResult {
  const { red, green, blue, alpha } = parseColor(params.color);
  const replaceExisting = params.replaceExisting ?? true;

  const extractor = new EntityExtractor(store.source);
  const read = (id: number): RawEntity | null => {
    const ref = store.entityIndex.byId.get(id);
    if (!ref) return null;
    const entity = extractor.extractEntity(ref as Parameters<EntityExtractor['extractEntity']>[0]);
    return entity ? { type: entity.type, attributes: entity.attributes ?? [] } : null;
  };

  const items = new Set<number>();
  const productsWithoutGeometry: number[] = [];
  for (const product of params.products) {
    // Per product, then merged. Asking whether the shared set grew would call
    // every occurrence after the first "geometry-less" whenever a type's
    // occurrences share one mapped representation — which is most of them.
    const reached = new Set<number>();
    const representation = read(product)?.attributes[PRODUCT_REPRESENTATION_INDEX];
    if (typeof representation === 'number') collectLeafItems(read, representation, reached);
    if (reached.size === 0) {
      productsWithoutGeometry.push(product);
      continue;
    }
    for (const item of reached) items.add(item);
  }

  // Which geometry already carries a style. IfcStyledItem points AT the
  // geometry and nothing points back, so the only way to find it is to read the
  // styled items themselves.
  const styledBy = new Map<number, number>();
  for (const id of store.entityIndex.byType.get('IFCSTYLEDITEM') ?? []) {
    const target = read(id)?.attributes[STYLED_ITEM_TARGET_INDEX];
    if (typeof target === 'number') styledBy.set(target, id);
  }

  const colour = editor.addEntity('IfcColourRgb', [null, { real: red }, { real: green }, { real: blue }]);
  const shading = editor.addEntity('IfcSurfaceStyleShading', [
    `#${colour.expressId}`,
    { real: 1 - alpha },
  ]);
  const surfaceStyle = editor.addEntity('IfcSurfaceStyle', [
    params.name ?? null,
    '.BOTH.',
    [`#${shading.expressId}`],
  ]);

  // IFC2X3 has no IfcStyleAssignmentSelect: IfcStyledItem.Styles there is a set
  // of IfcPresentationStyleAssignment. IFC4 deprecated that wrapper and takes
  // the IfcSurfaceStyle directly.
  const styleRef = store.schemaVersion === 'IFC2X3'
    ? `#${editor.addEntity('IfcPresentationStyleAssignment', [[`#${surfaceStyle.expressId}`]]).expressId}`
    : `#${surfaceStyle.expressId}`;

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
      replacedStyledItemIds.push(existing);
    }
    const styled = editor.addEntity('IfcStyledItem', [`#${item}`, [styleRef], null]);
    styledItemIds.push(styled.expressId);
  }

  return {
    surfaceStyleId: surfaceStyle.expressId,
    styledItemIds,
    productsWithoutGeometry,
    replacedStyledItemIds,
    keptExistingItemIds,
  };
}
