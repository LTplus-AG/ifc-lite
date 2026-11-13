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
import { LEGACY_MUTATION_MODEL_ID } from '@/sdk/adapters/model-compat';

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

type Views = ReadonlyMap<string, MutablePropertyView>;
interface Source { store: IfcDataStore | null | undefined; view: MutablePropertyView | undefined; global: (id: number) => number }

/** Each loaded store with the view its edits live under. Legacy single-store
 *  edits are keyed `__legacy__` (see `normalizeMutationModelId`). */
function sources(models: ReadonlyMap<string, FederatedModel>, fallback: IfcDataStore | null, views: Views,
  toGlobalId: (modelId: string, id: number) => number): Source[] {
  if (models.size) {
    return [...models].map(([id, m]) => ({ store: m.ifcDataStore, view: views.get(id), global: (e: number) => toGlobalId(id, e) }));
  }
  const view = views.get(LEGACY_MUTATION_MODEL_ID) ?? views.get('legacy') ?? views.get('default');
  return [{ store: fallback, view, global: (e) => e }];
}

/** The class the mask gives a stored row after the view's edits; null when deleted or not in the table. */
function storedClass(store: IfcDataStore, view: MutablePropertyView | undefined, id: number): string | null {
  const parsed = store.entities.getExactTypeName?.(id) || store.entities.getTypeName(id);
  return parsed === 'Unknown' ? null : effectiveType(view, id, parsed);
}

const authoredClass = (view: MutablePropertyView, e: { expressId: number; type: string }) => effectiveType(view, e.expressId, e.type);
const analytical = (type: string | null) => type !== null && isAnalyticalProduct(type);

/** Whether any product the mask would treat as analytical exists. Scans only
 *  candidates (analytical index entries, retyped ids, authored entities), each
 *  classified by the mask's own rule, so the command and the mode agree. */
export function hasStructuralData(state: Pick<ViewerState, 'models' | 'ifcDataStore' | 'mutationViews'>): boolean {
  return sources(state.models, state.ifcDataStore, state.mutationViews, (_, id) => id).some(({ store, view }) => {
    if (store) {
      // @raw-entity-enumeration-ok structural product presence; no attribute decoding
      for (const [type, ids] of store.entityIndex?.byType ?? []) {
        if (isAnalyticalProduct(type) && ids.some((id) => analytical(storedClass(store, view, id)))) return true;
      }
      if (view && [...view.getTypeMutations().keys()].some((id) => analytical(storedClass(store, view, id)))) return true;
    }
    return view?.getNewEntities().some((e) => analytical(authoredClass(view, e))) ?? false;
  });
}

/** A separate mask, so switching modes never overwrites manual hides/isolation.
 * Includes instanced products as well as flat meshes.
 */
export function structuralViewHidden(
  mode: 'both' | 'physical' | 'analytical',
  models: ReadonlyMap<string, FederatedModel>,
  fallback: IfcDataStore | null,
  views: Views,
  hidden: Set<number>,
  toGlobalId: (modelId: string, expressId: number) => number,
): Set<number> {
  if (mode === 'both') return hidden;
  const result = new Set(hidden);
  const mask = (id: number, type: string | null, global: (id: number) => number) => {
    if (type === null) return;
    const isAnalytical = isAnalyticalProduct(type);
    if ((mode === 'physical' && isAnalytical) || (mode === 'analytical' && !isAnalytical && isProductClass(type))) result.add(global(id));
  };
  for (const { store, view, global } of sources(models, fallback, views, toGlobalId)) {
    if (store) for (const id of store.entities.expressId) mask(id, storedClass(store, view, id), global);
    if (view) for (const e of view.getNewEntities()) mask(e.expressId, authoredClass(view, e), global);
  }
  return result;
}
