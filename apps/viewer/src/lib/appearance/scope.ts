/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { ViewerState } from '@/store';
import type { AppearanceCatalog } from './planner-types.js';
import type { AppearanceScope } from '@/components/viewer/appearance/types.js';

/** Resolve rendered owners through the store, including overlay-created products. */
export function appearanceOwners(state: ViewerState, modelId: string) {
  const model = state.models.get(modelId);
  const products = new Set<number>();
  // Instanced owners may have no flat mesh at all. Include them so the planner
  // reports eligibility instead of silently narrowing a model-wide scope.
  for (const globalId of model?.geometryResult?.instancedGeometryAabbs?.keys() ?? []) {
    const ref = state.resolveGlobalIdFromModels(globalId);
    if (ref?.modelId === modelId) products.add(ref.expressId);
  }
  for (const globalId of model?.geometryResult?.instancedGeometryHashes?.keys() ?? []) {
    const ref = state.resolveGlobalIdFromModels(globalId);
    if (ref?.modelId === modelId) products.add(ref.expressId);
  }
  for (const mesh of model?.geometryResult?.meshes ?? []) {
    const ids = mesh.entityIds ? new Set(mesh.entityIds) : [mesh.expressId];
    for (const globalId of ids) {
      const ref = state.resolveGlobalIdFromModels(globalId);
      if (ref?.modelId === modelId) products.add(ref.expressId);
    }
  }
  const selected = new Set<number>();
  const selection = new Set(state.selectedEntityIds);
  if (state.selectedEntityId !== null) selection.add(state.selectedEntityId);
  for (const globalId of selection) {
    const ref = state.resolveGlobalIdFromModels(globalId);
    if (ref?.modelId === modelId && products.has(ref.expressId)) selected.add(ref.expressId);
  }
  for (const id of products) if (state.mutationViews.get(modelId)?.isDeleted(id)) products.delete(id);
  return { productIds: [...products].sort((a, b) => a - b),
    selectedProductIds: [...selected].filter(id => products.has(id)).sort((a, b) => a - b) };
}

/** Class/type semantics come from Rust over the effective IFC snapshot.
 * This only maps the selected UI option to that catalog's model-local IDs. */
export function appearanceScope(catalog: AppearanceCatalog | null, selectedIds: readonly number[], scope: AppearanceScope) {
  const selected = new Set(selectedIds);
  const products = catalog?.products ?? [];
  const productIds = products.filter(product => {
    switch (scope.kind) {
      case 'model': return true;
      case 'selection': return selected.has(product.productId);
      case 'class': return product.ifcClass === scope.ifcClass;
      case 'type': return product.typeIds.includes(scope.typeId);
    }
  }).map(product => product.productId);
  // Do not silently shrink a model/selection scope when a rendered owner is
  // missing or ineligible in the effective IFC. The planner reports exclusion.
  if (scope.kind === 'model' || scope.kind === 'selection') {
    for (const id of catalog?.missingProductIds ?? []) {
      if (scope.kind === 'model' || selected.has(id)) productIds.push(id);
    }
  }
  return {
    productIds: productIds.sort((a, b) => a - b), selectionCount: selectedIds.length,
    classes: [...new Set(products.map(product => product.ifcClass))].sort().map(value => ({ value, label: value })),
    types: (catalog?.types ?? []).map(type => ({ id: type.typeId,
      name: type.Name || `${type.ifcClass} #${type.typeId}` })).sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id),
  };
}
