/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { MutablePropertyView } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { TypeVisibility, StructuralViewMode } from '@/store/types';
import { classFilterActive, isTypeVisible, type RetypedClasses, type TypeVisibilityGate } from '@/store/typeVisibilityFilter';
import type { FederatedModel, ViewerState } from '@/store';
import { isAnalyticalProduct } from './analytical-classes.mjs';
import { isProductClass } from '../compare/compareScope';
// Class after the view's edits, null once deleted.
import { effectiveTreeType, overlayViewFor } from '@/components/viewer/hierarchy/treeOverlay';

export { isAnalyticalProduct };

export function structuralGlyphsVisible(visibility: Pick<TypeVisibility, 'structuralGlyphs'>, mode: StructuralViewMode = 'both'): boolean {
  return visibility.structuralGlyphs && mode !== 'physical';
}

/** Flip the drawn supports & loads layer, not just the preference: Physical
 *  masks the glyphs, so turning them on there also leaves Physical (#10604). */
export function toggleStructuralGlyphs(state: Pick<ViewerState, 'typeVisibility' | 'structuralViewMode' | 'toggleTypeVisibility' | 'setStructuralViewMode'>): void {
  const mode = state.structuralViewMode ?? 'both';
  if (structuralGlyphsVisible(state.typeVisibility, mode)) { state.toggleTypeVisibility('structuralGlyphs'); return; }
  if (!state.typeVisibility.structuralGlyphs) state.toggleTypeVisibility('structuralGlyphs');
  if (mode === 'physical') state.setStructuralViewMode('both');
}

/** Whether `mode` hides a product of this class (null: deleted or unknown, never masked). */
function maskedByMode(mode: StructuralViewMode, type: string | null): boolean {
  if (type === null || mode === 'both') return false;
  const isAnalytical = isAnalyticalProduct(type);
  return (mode === 'physical' && isAnalytical) || (mode === 'analytical' && !isAnalytical && isProductClass(type));
}

/** A jump to an entity the structural view mode hides (a counterpart link,
 *  #10604) switches the view to Both first, so framing lands on something drawn. */
export function revealUnderStructuralMode(
  state: Pick<ViewerState, 'models' | 'ifcDataStore' | 'mutationViews' | 'structuralViewMode' | 'setStructuralViewMode'>,
  modelId: string,
  expressId: number,
): boolean {
  const mode = state.structuralViewMode ?? 'both';
  if (mode === 'both') return false;
  const store = state.models.get(modelId)?.ifcDataStore ?? (state.models.size ? null : state.ifcDataStore);
  const view = overlayViewFor((key) => state.mutationViews.get(key), modelId) ?? undefined;
  if (!maskedByMode(mode, entityClass(store, view, expressId))) return false;
  state.setStructuralViewMode('both');
  return true;
}

export type StructuralVisibilityState = Pick<ViewerState,
  'models' | 'ifcDataStore' | 'mutationViews' | 'hiddenEntities' | 'toGlobalId' | 'structuralViewMode'>;

/** Add only the structural mask; both preserves each caller's existing hidden set. */
export function resolveViewHiddenEntities(state: StructuralVisibilityState): Set<number> {
  return structuralViewHidden(state.structuralViewMode ?? 'both', state.models,
    state.ifcDataStore, state.mutationViews,
    state.hiddenEntities, state.toGlobalId);
}

/** `hidden` plus the retyped entities a class toggle hides. Flat meshes are filtered by
 *  effective class already; an instanced shard carries no class, so the 3D viewport
 *  needs these in its ID mask (#10245). Returns `hidden` itself when nothing is added. */
export function withClassHiddenRetypes(
  state: Pick<ViewerState, 'models' | 'ifcDataStore' | 'mutationViews' | 'toGlobalId'>,
  hidden: Set<number>,
  typeVisibility: TypeVisibilityGate,
): Set<number> {
  if (!classFilterActive(typeVisibility)) return hidden;
  let result = hidden;
  for (const [id, type] of retypedClasses(state)) {
    if (isTypeVisible(type, typeVisibility) || result.has(id)) continue;
    if (result === hidden) result = new Set(hidden);
    result.add(id);
  }
  return result;
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

/** The analytical/physical command is disabled once no structural data is left, so
 *  a latched mode could never be switched off and would mask the next physical-only
 *  model. Called after a model removal; `clearAllModels` resets it the same way (#9957). */
export function resetStructuralModeWithoutData(state: Pick<ViewerState, 'models' | 'ifcDataStore' | 'mutationViews' | 'structuralViewMode' | 'setStructuralViewMode'>): void {
  if ((state.structuralViewMode ?? 'both') !== 'both' && !hasStructuralData(state)) state.setStructuralViewMode('both');
}

/** An entity's class after the view's edits, stored or created this session; null when deleted or unknown. */
export function entityClass(store: IfcDataStore | null | undefined, view: MutablePropertyView | undefined, id: number): string | null {
  const created = view?.getNewEntity(id);
  if (created) return effectiveTreeType(view, id, created.type);
  return store ? storedClass(store, view, id) : null;
}

/** Global id to class after edits, for each id an edit retyped. A mesh keeps the
 *  class it was built with, so mesh filters read this to classify a mesh the
 *  way the mask classifies its entity (#10119). Visits only edited ids. */
export function retypedClasses(state: Pick<ViewerState, 'models' | 'ifcDataStore' | 'mutationViews' | 'toGlobalId'>): RetypedClasses {
  const out = new Map<number, string>();
  for (const { store, view, modelId } of sources(state.models, state.ifcDataStore, state.mutationViews)) {
    if (!view) continue;
    const global = (id: number) => modelId === null ? id : state.toGlobalId(modelId, id);
    // Deleted ids stay out, so their meshes keep the class they were built with.
    for (const id of view.getTypeMutations().keys()) {
      const type = entityClass(store, view, id);
      if (type !== null) out.set(global(id), type);
    }
  }
  return out;
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
    if (maskedByMode(mode, type)) result.add(global(id));
  };
  for (const { store, view, modelId } of sources(models, fallback, views)) {
    const global = modelId === null ? (id: number) => id : (id: number) => toGlobalId(modelId, id);
    // Deleted rows are skipped: their meshes belong to the deletion path, as they do in 'both'.
    if (store) for (const id of store.entities.expressId) mask(id, storedClass(store, view, id), global);
    if (view) for (const e of view.readNewEntityKinds()) mask(e.expressId, effectiveTreeType(view, e.expressId, e.type), global);
  }
  return result;
}
