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
  /**
   * Style the geometry a type's occurrences share, rather than each occurrence
   * (default `true`).
   *
   * Following `IfcMappedItem` to the `IfcRepresentationMap` is what makes one
   * style cover every occurrence of a type, which is what you want colouring by
   * IFC class. It is wrong for any other grouping: colouring by system, storey
   * or property value, the shared geometry takes the colour of whichever batch
   * touched it last, and occurrences in other groups change with it. Pass
   * `false` to style the `IfcMappedItem` itself, one per occurrence.
   *
   * Do not mix the two settings over one model. They style different entities
   * — the mapped item and the geometry behind it — so `replaceExisting` cannot
   * see the conflict, and an occurrence ends up carrying both a shared style
   * and its own, with the winner left to the viewer.
   */
  followMappedItems?: boolean;
  /**
   * Schema the style chain is built for. Defaults to the store's own.
   *
   * `IfcStyledItem.Styles` holds `IfcPresentationStyleAssignment` on IFC2X3 and
   * the `IfcSurfaceStyle` directly from IFC4 on, and this is decided when the
   * style is authored, not when the file is written. Exporting to a different
   * schema than the model was parsed from therefore needs the target passed in;
   * otherwise the emitted records are invalid for the file they land in.
   *
   * Typed as the store's own schema union rather than a bare string: the two
   * are halves of one decision, and a near-miss like `'IFC2x3'` would otherwise
   * typecheck and silently emit the IFC4 shape. IFC2X3 is the only member that
   * differs; IFC4, IFC4X3 and IFC5 all take the `IfcSurfaceStyle` directly,
   * which is why the branch tests for IFC2X3 rather than listing the rest.
   */
  schema?: IfcDataStore['schemaVersion'];
}

/**
 * What one batch did.
 *
 * A snapshot taken when the call returns, not a live view. Results from a
 * single `applyStylesInStore` are reconciled against each other before they are
 * handed back, so a batch whose work a later batch replaced reports that. A
 * result from an *earlier* call cannot be: recolouring the same geometry in a
 * second call removes the styled items the first call named, and that first
 * result still names them. The file is correct either way; only the older
 * return value goes stale.
 */
export interface ApplyStyleResult {
  /**
   * The `IfcSurfaceStyle` every item styled by this batch now points at, or
   * `null` when the batch styled nothing.
   *
   * Null rather than an id because the style is only authored once there is
   * something to attach it to. Emitting it up front left an orphan colour chain
   * in the file for every batch that reached no geometry — and a caller
   * colouring by IFC class hands in a batch per class, most of which (types,
   * ports, spatial structure) have none.
   */
  surfaceStyleId: number | null;
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
 * With `followMappedItems` (the default), an `IfcMappedItem` resolves to the
 * items of the `IfcRepresentationMap` behind it, so the geometry every
 * occurrence of a type shares is what comes back. Without it, the mapped item
 * itself is the leaf. See `ApplyStyleOptions.followMappedItems` for which one
 * you want.
 *
 * Exported because three private copies of this walk already exist in
 * `extract-walls.ts` and one in `@ifc-lite/export`'s LOD generator, and none of
 * them follows mapped items. This is the complete one.
 */
export function collectLeafRepresentationItems(
  read: (id: number) => RawEntity | null,
  representationId: number,
  options: { followMappedItems?: boolean } = {},
): Set<number> {
  const followMapped = options.followMappedItems ?? true;
  const out = new Set<number>();

  const walk = (id: number, depth: number): void => {
    if (depth > MAX_REPRESENTATION_DEPTH) return;
    const entity = read(id);
    if (!entity) return;

    const type = entity.type.toUpperCase();
    if (type === 'IFCPRODUCTDEFINITIONSHAPE') {
      for (const rep of refList(entity.attributes[SHAPE_REPRESENTATIONS_INDEX])) walk(rep, depth + 1);
      return;
    }
    if (type === 'IFCSHAPEREPRESENTATION') {
      for (const item of refList(entity.attributes[REPRESENTATION_ITEMS_INDEX])) walk(item, depth + 1);
      return;
    }
    if (type === 'IFCMAPPEDITEM' && followMapped) {
      const source = asRef(entity.attributes[MAPPED_ITEM_SOURCE_INDEX]);
      if (source === null) return;
      const mapped = asRef(read(source)?.attributes[MAPPED_REPRESENTATION_INDEX]);
      if (mapped !== null) walk(mapped, depth + 1);
      return;
    }
    out.add(id);
  };

  walk(representationId, 0);
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
  const followMapped = options.followMappedItems ?? true;
  const schema = options.schema ?? store.schemaVersion;
  const read = createReader(store, editor);
  const styledBy = indexExistingStyles(store, editor, read);

  const results = batches.map(batch => {
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
        : collectLeafRepresentationItems(read, representation, { followMappedItems: followMapped });

      if (reached.size === 0) {
        productsWithoutGeometry.push(product);
        continue;
      }
      for (const item of reached) items.add(item);
    }

    // Split before emitting anything, so a batch that turns out to style
    // nothing does not leave a colour chain behind.
    const keptExistingItemIds: number[] = [];
    const toStyle: number[] = [];
    for (const item of [...items].sort((a, b) => a - b)) {
      if (!replaceExisting && styledBy.has(item)) keptExistingItemIds.push(item);
      else toStyle.push(item);
    }

    if (toStyle.length === 0) {
      return {
        surfaceStyleId: null,
        styledItemIds: [],
        productsWithoutGeometry,
        replacedStyledItemIds: [],
        keptExistingItemIds,
      };
    }

    const style = emitSurfaceStyle(editor, schema, batch.color, batch.name);
    const styleRef = `#${style.styleRefId}`;
    const chain: AuthoredChain = {
      styleId: style.surfaceStyleId, chainIds: style.chainIds, styledItemIds: [],
    };
    authoredChains.set(editor, [...(authoredChains.get(editor) ?? []), chain]);

    const styledItemIds: number[] = [];
    const replacedStyledItemIds: number[] = [];

    for (const item of toStyle) {
      const existing = styledBy.get(item);
      if (existing !== undefined) {
        editor.removeEntity(existing);
        replacedStyledItemIds.push(existing);
      }
      const styled = editor.addEntity('IfcStyledItem', [`#${item}`, [styleRef], null]);
      styledBy.set(item, styled.expressId);
      styledItemIds.push(styled.expressId);
      chain.styledItemIds.push(styled.expressId);
    }

    return {
      surfaceStyleId: style.surfaceStyleId,
      styledItemIds,
      productsWithoutGeometry,
      replacedStyledItemIds,
      keptExistingItemIds,
    };
  });

  sweepAuthoredChains(editor);

  // A styled item can be replaced after its batch returned — by a later batch,
  // or by a later call entirely. Report what is actually still in the file.
  const live = new Set(editor.getNewEntities().map(e => e.expressId));
  return results.map(result => {
    const surviving = result.styledItemIds.filter(id => live.has(id));
    if (surviving.length === result.styledItemIds.length) return result;
    return {
      ...result,
      styledItemIds: surviving,
      surfaceStyleId: surviving.length === 0 ? null : result.surfaceStyleId,
    };
  });
}

/**
 * Style chains this module authored, per editor, and the styled items each was
 * created for.
 *
 * Kept rather than inferred. Deciding "is this style garbage" by reading the
 * overlay was wrong three ways: it could not see `setPositionalAttribute` edits
 * (`getNewEntities` returns creation-time attributes, while the exporter
 * applies positional mutations on top), so it deleted live styles and kept dead
 * ones; it removed a chain's shading and colour without checking whether
 * another style still used them; and it collected any overlay `IfcSurfaceStyle`
 * at all, including chains a caller had authored with `bim.store.addEntity` and
 * not yet attached. All three needed a caller using `bim.store.*` alongside
 * `bim.style`, which is public API.
 *
 * A `WeakMap` because it has to outlive one call — recolouring in a second
 * `apply` is exactly the case per-call bookkeeping could not reach — without
 * keeping a finished editor alive.
 */
const authoredChains = new WeakMap<StoreEditor, AuthoredChain[]>();

interface AuthoredChain {
  /** The `IfcSurfaceStyle`. */
  styleId: number;
  /** Every entity `emitSurfaceStyle` created for it, including the style. */
  chainIds: number[];
  /** The `IfcStyledItem` entities authored against it. */
  styledItemIds: number[];
}

/**
 * Drop the chains whose every styled item is gone.
 *
 * Liveness is membership in the overlay: removing an overlay-created entity
 * deletes it from `newEntities`, so `getNewEntity` answering null is the whole
 * test. Nothing here reads an attribute, which is what makes it immune to a
 * caller repointing one of these styled items — that leaves the chain looking
 * referenced, so it survives. Keeping a chain that turned out to be garbage is
 * the safe direction; removing one still pointed at writes a dangling
 * reference into the file.
 */
function sweepAuthoredChains(editor: StoreEditor): void {
  const chains = authoredChains.get(editor);
  if (!chains || chains.length === 0) return;

  const surviving: AuthoredChain[] = [];
  for (const chain of chains) {
    if (chain.styledItemIds.some(id => editor.getNewEntity(id) !== null)) {
      surviving.push(chain);
      continue;
    }
    for (const id of chain.chainIds) editor.removeEntity(id);
  }
  authoredChains.set(editor, surviving);
}
