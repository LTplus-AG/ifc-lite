/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { MutablePropertyView } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { TypeVisibility, StructuralViewMode } from '@/store/types';
import type { FederatedModel, ViewerState } from '@/store';
import { isAnalyticalProduct } from './analytical-classes.mjs';
import { isProductClass } from '../compare/compareScope';
// Class after the view's edits, null once deleted.
import { effectiveTreeType, overlayViewFor } from '@/components/viewer/hierarchy/treeOverlay';

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
/** modelId is null for the legacy single store, whose ids are already global. */
interface Source { store: IfcDataStore | null | undefined; view: MutablePropertyView | undefined; modelId: string | null }

/** Each loaded store with the view its edits live under, resolved like the tree does. */
function sources(models: ReadonlyMap<string, FederatedModel>, fallback: IfcDataStore | null, views: Views): Source[] {
  if (models.size) return [...models].map(([id, m]) => ({ store: m.ifcDataStore, view: views.get(id), modelId: id }));
  return [{ store: fallback, view: overlayViewFor((key) => views.get(key), 'legacy') ?? undefined, modelId: null }];
}

/** A stored row's class after the view's edits; null when deleted or not in the table. */
function storedClass(store: IfcDataStore, view: MutablePropertyView | undefined, id: number): string | null {
  const parsed = store.entities.getExactTypeName?.(id) || store.entities.getTypeName(id);
  return parsed === 'Unknown' ? null : effectiveTreeType(view, id, parsed);
}
const analytical = (type: string | null) => type !== null && isAnalyticalProduct(type);

/** Whether any product the mask would treat as analytical exists. Scans only
 *  candidates (analytical index entries, retyped ids, authored entities), each
 *  classified by the mask's own rule, so the command and the mode agree. */
export function hasStructuralData(state: { models: ReadonlyMap<string, FederatedModel>; ifcDataStore: IfcDataStore | null; mutationViews: Views }): boolean {
  return sources(state.models, state.ifcDataStore, state.mutationViews).some(({ store, view }) => {
    if (store) {
      // @raw-entity-enumeration-ok structural product presence; no attribute decoding
      for (const [type, ids] of store.entityIndex?.byType ?? []) {
        if (isAnalyticalProduct(type) && ids.some((id) => analytical(storedClass(store, view, id)))) return true;
      }
      for (const id of view?.getTypeMutations().keys() ?? []) if (analytical(storedClass(store, view, id))) return true;
    }
    for (const e of view?.readNewEntityKinds() ?? []) if (analytical(effectiveTreeType(view, e.expressId, e.type))) return true;
    return false;
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
  for (const { store, view, modelId } of sources(models, fallback, views)) {
    const global = modelId === null ? (id: number) => id : (id: number) => toGlobalId(modelId, id);
    if (store) {
      for (const id of store.entities.expressId) {
        // A deleted row's mesh can outlive the edit until the rebuild; keep it hidden in either mode.
        if (view?.isDeleted(id)) result.add(global(id));
        else mask(id, storedClass(store, view, id), global);
      }
    }
    if (view) for (const e of view.readNewEntityKinds()) mask(e.expressId, effectiveTreeType(view, e.expressId, e.type), global);
  }
  return result;
}
