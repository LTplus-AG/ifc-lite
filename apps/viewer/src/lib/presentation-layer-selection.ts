/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { iterateEffectiveEntityIds, type MutablePropertyView } from '@ifc-lite/mutations';
import { effectiveMetadataRecord, type IfcDataStore } from '@ifc-lite/parser';
import type { PresentationLayer } from './presentation-layers';
import { LAYER_TYPES, references, presentationOwnership } from './presentation-layer-ownership';

export interface PresentationLayerLookup {
  /** Resolve only this product's shape graph. Results are cached until revision changes. */
  get(productId: number): readonly PresentationLayer[] | undefined;
}
const cache = new WeakMap<IfcDataStore, {
  view: MutablePropertyView | null | undefined;
  revision: number | undefined;
  source: IfcDataStore['source'];
  index: PresentationLayerLookup;
}>();

/** #9273: index declarations, never every product/face in the model on selection. */
export function presentationLayersByProduct(store: IfcDataStore, view?: MutablePropertyView | null): PresentationLayerLookup {
  const revision = view?.getMutationRevision();
  const current = cache.get(store);
  if (current && current.view === view && current.revision === revision && current.source === store.source) return current.index;
  const entries = [...iterateEffectiveEntityIds(store, view, LAYER_TYPES)];
  const index = entries.length ? buildLookup(store, view, entries.map(entry => entry.expressId)) : new Map<number, readonly PresentationLayer[]>();
  cache.set(store, { view, revision, source: store.source, index });
  return index;
}

function buildLookup(store: IfcDataStore, view: MutablePropertyView | null | undefined, layerIds: number[]): PresentationLayerLookup {
  const plan = presentationOwnership(store.schemaVersion);
  const assigned = new Map<number, PresentationLayer[]>();
  const layers: PresentationLayer[] = [];
  const records = new Map<number, ReturnType<typeof effectiveMetadataRecord>>();
  const read = (id: number) => {
    if (!records.has(id)) records.set(id, effectiveMetadataRecord(store, id, view ?? undefined));
    return records.get(id) ?? null;
  };
  for (const id of layerIds) {
    const record = read(id);
    if (!record) continue;
    const attrs = new Map(record.names.map((name, i) => [name, record.attributes[i]]));
    const text = (name: string) => {
      const value = attrs.get(name);
      return typeof value === 'string' && value.length ? value : undefined;
    };
    const type = record.type.toUpperCase() === 'IFCPRESENTATIONLAYERWITHSTYLE'
      ? 'IfcPresentationLayerWithStyle' : 'IfcPresentationLayerAssignment';
    const layer: PresentationLayer = { expressId: id, type, Name: text('Name') ?? `${type} #${id}`,
      Description: text('Description'), Identifier: text('Identifier'), productIds: [] };
    layers.push(layer);
    for (const item of new Set(references(attrs.get('AssignedItems')))) {
      const owners = assigned.get(item) ?? [];
      owners.push(layer);
      assigned.set(item, owners);
    }
  }
  if (!assigned.size) return new Map<number, readonly PresentationLayer[]>();

  // Shape aspects are the only inverse ownership edges: enumerate that small
  // class, rather than decoding every geometric constituent to find parents.
  const aspects = new Map<number, number[]>();
  for (const entry of iterateEffectiveEntityIds(store, view, ['IfcShapeAspect'])) {
    const record = read(entry.expressId);
    if (!record) continue;
    const attrs = new Map(record.names.map((name, i) => [name, record.attributes[i]]));
    const owners = references(attrs.get('PartOfProductDefinitionShape'));
    if (owners.length !== 1) continue;
    const type = read(owners[0])?.type.toUpperCase();
    if (type !== 'IFCPRODUCTDEFINITIONSHAPE' && type !== 'IFCREPRESENTATIONMAP') continue;
    const shapes = references(attrs.get('ShapeRepresentations')).filter(id => {
      const shapeType = read(id)?.type.toUpperCase();
      return shapeType && plan.shapeModelClasses.has(shapeType);
    });
    aspects.set(owners[0], [...(aspects.get(owners[0]) ?? []), ...shapes]);
  }
  const products = new Map<number, readonly PresentationLayer[] | undefined>();
  return { get(productId) {
    if (products.has(productId)) return products.get(productId);
    const product = read(productId);
    if (!product || !plan.productClasses.has(product.type.toUpperCase())) return undefined;
    const found = new Set<number>();
    const pending = [productId];
    // Membership is a pure set union: global visited bounds cycles and DAG fanout.
    // Walking down only ownership edges preserves shared mapped/boolean items.
    const visited = new Set<number>();
    while (pending.length && found.size < layers.length) {
      const id = pending.pop()!;
      if (visited.has(id)) continue;
      visited.add(id);
      const record = read(id);
      if (!record) continue;
      const type = record.type.toUpperCase();
      if (plan.layeredClasses.has(type)) {
        for (const layer of assigned.get(id) ?? []) found.add(layer.expressId);
      }
      const attrs = new Map(record.names.map((name, i) => [name, record.attributes[i]]));
      for (const name of plan.attributesFor(type)) for (const child of references(attrs.get(name))) pending.push(child);
      for (const shape of aspects.get(id) ?? []) pending.push(shape);
    }
    const result = layers.filter(layer => found.has(layer.expressId))
      .map(layer => ({ ...layer, productIds: [productId] }));
    products.set(productId, result.length ? result : undefined);
    return products.get(productId);
  } };
}
