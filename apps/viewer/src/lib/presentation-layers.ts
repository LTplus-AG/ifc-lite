/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { iterateEffectiveEntityIds, type MutablePropertyView } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';
import { presentationLayerReader } from './presentation-layer-reader';

import { LAYER_TYPES, references, presentationOwnership } from './presentation-layer-ownership';

export interface PresentationLayer {
  expressId: number;
  type: 'IfcPresentationLayerAssignment' | 'IfcPresentationLayerWithStyle';
  Name: string;
  Description?: string;
  Identifier?: string;
  /** Model-local product IDs. Actions affect whole products, not individual items. */
  productIds: readonly number[];
}

export { presentationLayersByProduct } from './presentation-layer-selection';

interface LayerIndex {
  revision: number | undefined;
  source: IfcDataStore['source'];
  layers: readonly PresentationLayer[];
}
/** Stands in for "no overlay": the model as parsed. */
const UNEDITED = {};
// Per store, then per overlay: two models may share a store under different
// overlays, and neither may evict the other's index on every build.
const indexes = new WeakMap<IfcDataStore, WeakMap<object, LayerIndex>>();

/**
 * Product-level membership of presentation layers (#7619). This deliberately
 * unions explicit assignments: item styling precedence and LayerOn/LayerFrozen
 * do not change membership or automatically change viewer visibility.
 *
 * One index per model and overlay revision (#9906). The hierarchy asks for it
 * on every tree build, and one click builds several trees: the visible rows,
 * the expanded structure, and both again for a second docked hierarchy. The
 * result is shared and frozen, so a caller sorts or filters a copy.
 */
export function resolvePresentationLayers(
  store: IfcDataStore,
  view?: MutablePropertyView | null,
): readonly PresentationLayer[] {
  const overlay = view ?? undefined;
  const revision = overlay?.getMutationRevision();
  let byOverlay = indexes.get(store);
  if (!byOverlay) { byOverlay = new WeakMap(); indexes.set(store, byOverlay); }
  const current = byOverlay.get(overlay ?? UNEDITED);
  if (current && current.revision === revision && current.source === store.source) return current.layers;
  const layers = Object.freeze(buildPresentationLayers(store, overlay));
  byOverlay.set(overlay ?? UNEDITED, { revision, source: store.source, layers });
  return layers;
}

/**
 * Ownership is walked down from the products, recording each edge in reverse,
 * then up from every assigned item. An item reaches a product only through
 * records that product owns, so nothing outside that closure is decoded; the
 * edges themselves are the ones a scan of every class would record.
 *
 * Geometry constituents (faces, loops, curves, boolean operands) are entered
 * only when a layer is assigned to an item below a shape model. EXPRESS lets a
 * constituent own constituents only, never a shape model or a mapped item, so
 * a model whose layers are assigned to shape representations has no ownership
 * path through its geometry: decoding that geometry was the whole cost of
 * opening the layer tree on a BREP export (#9906).
 *
 * Reverse edges describe shape ownership only. Walking arbitrary references
 * would associate unrelated products through shared contexts or placements.
 * Iterative, visited walks also bound cyclic mapped geometry.
 */
function buildPresentationLayers(store: IfcDataStore, view: MutablePropertyView | undefined): Readonly<PresentationLayer>[] {
  const layerEntries = [...iterateEffectiveEntityIds(store, view, LAYER_TYPES)];
  if (layerEntries.length === 0) return [];
  const plan = presentationOwnership(store.schemaVersion);
  const read = presentationLayerReader(store, view);
  // Only records read outside the downward walk repeat; that walk reads each once.
  const remembered = new Map<number, ReturnType<typeof read>>();
  const recall = (id: number) => {
    if (!remembered.has(id)) remembered.set(id, read(id));
    return remembered.get(id) ?? null;
  };
  const value = (record: NonNullable<ReturnType<typeof read>>, name: string): unknown => record.value(name);

  const layers: Array<Omit<PresentationLayer, 'productIds'> & { assignedItems: number[] }> = [];
  for (const entry of layerEntries) {
    const record = recall(entry.expressId);
    if (!record) continue;
    const type = record.type.toUpperCase();
    if (type !== 'IFCPRESENTATIONLAYERASSIGNMENT' && type !== 'IFCPRESENTATIONLAYERWITHSTYLE') continue;
    const text = (name: string): string | undefined => {
      const found = value(record, name);
      return typeof found === 'string' && found.length > 0 ? found : undefined;
    };
    const layerType = type === 'IFCPRESENTATIONLAYERWITHSTYLE'
      ? 'IfcPresentationLayerWithStyle' : 'IfcPresentationLayerAssignment';
    layers.push({ expressId: entry.expressId, type: layerType,
      Name: text('Name') ?? `${layerType} #${entry.expressId}`,
      Description: text('Description'), Identifier: text('Identifier'),
      assignedItems: references(value(record, 'AssignedItems')) });
  }

  // Shape aspects point back to their owning resource. Their shape models
  // need not also appear in that resource's main representation list.
  const aspects = new Map<number, number[]>();
  for (const entry of iterateEffectiveEntityIds(store, view, ['IfcShapeAspect'])) {
    const record = recall(entry.expressId);
    if (!record || record.type.toUpperCase() !== 'IFCSHAPEASPECT') continue;
    const ownerIds = references(value(record, 'PartOfProductDefinitionShape'));
    if (ownerIds.length !== 1) continue;
    const ownerType = recall(ownerIds[0])?.type.toUpperCase();
    if (ownerType !== 'IFCPRODUCTDEFINITIONSHAPE' && ownerType !== 'IFCREPRESENTATIONMAP') continue;
    const shapes = aspects.get(ownerIds[0]) ?? [];
    for (const shapeId of references(value(record, 'ShapeRepresentations'))) {
      const shapeType = recall(shapeId)?.type.toUpperCase();
      if (shapeType && plan.shapeModelClasses.has(shapeType)) shapes.push(shapeId);
    }
    aspects.set(ownerIds[0], shapes);
  }

  // Ids only, no decode: which records the walk may enter.
  const structural = new Set<number>();
  for (const entry of iterateEffectiveEntityIds(store, view, plan.structuralTypes)) structural.add(entry.expressId);
  const layered = (id: number): boolean => {
    const record = recall(id);
    return !!record && plan.layeredClasses.has(record.type.toUpperCase());
  };
  let constituents: Set<number> | undefined;
  if (layers.some(layer => layer.assignedItems.some(id => !structural.has(id) && layered(id)))) {
    constituents = new Set<number>();
    for (const entry of iterateEffectiveEntityIds(store, view, plan.constituentTypes)) constituents.add(entry.expressId);
  }

  // With no constituent assignments or mapped items, nothing below a shape
  // model can lead to an assigned seed. Its incoming edge is sufficient.
  const terminalShapes = !constituents
    && iterateEffectiveEntityIds(store, view, ['IfcMappedItem']).next().done;
  const parents = new Map<number, number[]>();
  const products = new Set<number>();
  const entered = new Set<number>();
  const enteredLayered = new Set<number>();
  const pending: number[] = [];
  for (const entry of iterateEffectiveEntityIds(store, view, plan.productTypes)) pending.push(entry.expressId);
  while (pending.length > 0) {
    const id = pending.pop()!;
    if (entered.has(id)) continue;
    entered.add(id);
    const record = read(id);
    if (!record) continue;
    const type = record.type.toUpperCase();
    if (plan.productClasses.has(type)) products.add(id);
    if (plan.layeredClasses.has(type)) enteredLayered.add(id);
    const own = (child: number): void => {
      const owners = parents.get(child);
      if (owners) owners.push(id); else parents.set(child, [id]);
      if (!entered.has(child) && (structural.has(child) || constituents?.has(child))) pending.push(child);
    };
    for (const attribute of terminalShapes && plan.shapeModelClasses.has(type) ? [] : plan.attributesFor(type)) for (const child of references(value(record, attribute))) own(child);
    for (const shape of aspects.get(id) ?? []) own(shape);
  }

  return layers.map(({ assignedItems, ...layer }) => {
    const visited = new Set<number>();
    const found = new Set<number>();
    // An item no product owns has no path up; it is not decoded to learn its class.
    const walk = assignedItems.filter(id => parents.has(id)
      && (entered.has(id) ? enteredLayered.has(id) : layered(id)));
    while (walk.length > 0) {
      const id = walk.pop()!;
      if (visited.has(id) || view?.isDeleted(id)) continue;
      visited.add(id);
      if (products.has(id)) found.add(id);
      for (const parent of parents.get(id) ?? []) walk.push(parent);
    }
    return Object.freeze({ ...layer, productIds: Object.freeze([...found].sort((a, b) => a - b)) });
  });
}
