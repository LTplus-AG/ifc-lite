/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { MutablePropertyView } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { TypeVisibility, StructuralViewMode } from '@/store/types';
import type { FederatedModel, ViewerState } from '@/store';
import { isAnalyticalProduct } from './analytical-classes.mjs';
import { isProductClass } from '../compare/compareScope';
// Class after the view's edits, null once deleted; mask and presence both read it.
import { effectiveTreeType as effectiveType } from '@/components/viewer/hierarchy/treeOverlay';

export { isAnalyticalProduct };

export function structuralGlyphsVisible(visibility: Pick<TypeVisibility, 'structuralGlyphs'>, mode: StructuralViewMode = 'both'): boolean {
  return visibility.structuralGlyphs && mode !== 'physical';
}

export type StructuralVisibilityState = Pick<ViewerState,
  'models' | 'ifcDataStore' | 'mutationViews' | 'hiddenEntities' | 'toGlobalId' | 'structuralViewMode'>;

/** Add only the structural mask; both preserves each caller's existing hidden set. */
export function resolveViewHiddenEntities(state: StructuralVisibilityState): Set<number> {
  return structuralViewHidden(state.structuralViewMode ?? 'both', state.models,
    state.ifcDataStore, state.mutationViews,
    state.hiddenEntities, state.toGlobalId);
}

const isEffectivelyAnalytical = (view: MutablePropertyView | undefined, id: number, baseType: string) => {
  const type = effectiveType(view, id, baseType);
  return type !== null && isAnalyticalProduct(type);
};

/** Effective presence: indexed, retyped-in and authored analytical products that are still analytical and not deleted. */
export function hasStructuralData(state: Pick<ViewerState, 'models' | 'ifcDataStore' | 'mutationViews'>): boolean {
  const sources: Array<[IfcDataStore | null | undefined, MutablePropertyView | undefined]> = state.models.size
    ? [...state.models].map(([id, m]) => [m.ifcDataStore, state.mutationViews.get(id)])
    : [[state.ifcDataStore, state.mutationViews.get('default')]];
  // @raw-entity-enumeration-ok structural product presence; no attribute decoding
  return sources.some(([store, view]) => [...(store?.entityIndex?.byType ?? [])]
    .some(([type, ids]) => isAnalyticalProduct(type) && ids.some((id) => isEffectivelyAnalytical(view, id, type))))
    || [...state.mutationViews.values()].some((view) =>
      view.getNewEntities().some((e) => isEffectivelyAnalytical(view, e.expressId, e.type))
      || [...view.getTypeMutations()].some(([id, m]) => !view.isDeleted(id) && isAnalyticalProduct(m.newType)));
}

/** A separate mask, so switching modes never overwrites manual hides/isolation.
 * Includes instanced products as well as flat meshes.
 */
export function structuralViewHidden(
  mode: 'both' | 'physical' | 'analytical',
  models: ReadonlyMap<string, FederatedModel>,
  fallback: IfcDataStore | null,
  views: ReadonlyMap<string, MutablePropertyView>,
  hidden: Set<number>,
  toGlobalId: (modelId: string, expressId: number) => number,
): Set<number> {
  if (mode === 'both') return hidden;
  const result = new Set(hidden);
  const mask = (id: number, type: string, global: (id: number) => number) => {
    const analytical = isAnalyticalProduct(type);
    if ((mode === 'physical' && analytical) || (mode === 'analytical' && !analytical && isProductClass(type))) result.add(global(id));
  };
  const visit = (store: IfcDataStore, view: MutablePropertyView | undefined, global: (id: number) => number) => {
    for (const id of store.entities.expressId) {
      const type = effectiveType(view, id, store.entities.getExactTypeName?.(id) ?? store.entities.getTypeName(id));
      if (type !== null) mask(id, type, global);
    }
  };
  if (models.size) {
    for (const [id, model] of models) {
      if (model.ifcDataStore) visit(model.ifcDataStore, views.get(id), (entity) => toGlobalId(id, entity));
    }
  } else if (fallback) visit(fallback, views.get('default'), (id) => id);
  for (const [modelId, view] of views) {
    for (const e of view.getNewEntities()) {
      const type = effectiveType(view, e.expressId, e.type);
      if (type !== null) mask(e.expressId, type, (id) => toGlobalId(modelId, id));
    }
  }
  return result;
}
