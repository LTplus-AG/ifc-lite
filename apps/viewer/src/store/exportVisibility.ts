/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Single resolver for "what does visible-only export mean for this model".
 *
 * Before this existed, `ExportDialog.tsx` (STEP / IFCX) and
 * `GLBExportDialog.tsx` (GLB) each hand-assembled their own idea of "hidden"
 * / "isolated" from a subset of the store — `hiddenEntities` /
 * `hiddenEntitiesByModel` and `isolatedEntities` / `isolatedEntitiesByModel`
 * only. Neither read `classFilter` (the hierarchy panel's Class tab),
 * `selectedStoreys` (storey isolation), or `typeVisibility` for STEP/IFCX at
 * all. Result (#4328): filter the Class tab to `IfcWallStandardCase`, export
 * "Visible Only", and the whole model comes out — the class filter is
 * invisible to every exporter.
 *
 * `getVisibleGlobalIds` in `basketVisibleSet.ts` already resolves the FULL
 * combination correctly for the basket/pinboard feature, and
 * `computeIsolationFilterSet` (also there) is already the shared derivation
 * `view-pdf-export-source.ts` routes through for the to-scale PDF export
 * (#2042/#2558 — the same "export disagrees with the viewport" defect
 * class). This resolver reuses `computeIsolationFilterSet` rather than
 * restating the storey/class/isolate intersection a third time, and adds the
 * two channels neither of those covers for an entity-id-based exporter:
 * `typeVisibility` (class-level toggles — Spaces/Openings/Site/…) and the
 * per-model `hiddenEntitiesByModel`/`isolatedEntitiesByModel` channels.
 *
 * ## Composition ruling
 * Hidden and isolated compose as denylist-minus / allowlist-and: an entity
 * exports only if it is NOT in the hidden (denylist) set AND — when an
 * isolation allowlist is active — IS in that allowlist. Within the allowlist
 * side, storey selection, the class filter and manual "Isolate" all
 * INTERSECT, matching `computeIsolationFilterSet` (the viewport's own
 * isolation rule): a user who isolates a storey and then filters to a class
 * expects the overlap ("just the walls on this storey"), not the union
 * ("this storey, plus every wall anywhere"). The store's own doc comment
 * ("combinable") does not say which operator; the viewport's existing
 * behavior is the tie-breaker, since an export that disagreed with the
 * on-screen result would just be a different flavor of #4328.
 *
 * `hiddenEntitiesByModel` / `isolatedEntitiesByModel` are a SEPARATE,
 * per-model-scoped channel (used by e.g. "Isolate in 3D" scoped to a single
 * federated model) and combine as an additional AND on top of the global
 * result, exactly as `getVisibleGlobalIds` already treats them.
 *
 * ## Structural entities
 * This resolver does not — and must not — decide whether `IfcProject`,
 * `IfcSite`, storeys, or relationships survive a visible-only export. The
 * STEP/IFCX exporters already retain infrastructure (`INFRASTRUCTURE_TYPES`)
 * and spatial structure (`SPATIAL_STRUCTURE_TYPES`) as unconditional roots
 * regardless of `hiddenEntityIds`/`isolatedEntityIds`
 * (`packages/export/src/entity-type-sets.ts`, `reference-collector.ts`) —
 * only `PRODUCT_TYPES` are filtered. This resolver only has to get the
 * product-level hidden/isolated sets right; the exporters' own root
 * classification takes it from there.
 *
 * ## `ghostExceptEntities` is deliberately excluded
 * It drives the renderer's X-Ray mode — every entity NOT in the set renders
 * TRANSLUCENT, not hidden (`VisibilitySlice.ghostExceptEntities` doc). A
 * ghosted-but-not-hidden entity is still on screen and must still export;
 * folding it in here would make "Export Visible Only" drop entities the user
 * can currently see.
 *
 * ## Every export path routes through this — with one deliberate exception
 * STEP, IFCX, merged STEP and GLB (`ExportDialog.tsx`, `GLBExportDialog.tsx`)
 * call this resolver directly. The SDK/scripting surface
 * (`sdk.export.ifc()`, `export-adapter.ts`'s `resolveVisibilityFilterSets`)
 * routes through it too, but ONLY when the caller's `refs` cover the whole
 * model — that is the same "visible only" question this resolver answers
 * for the dialogs. When a caller instead passes an explicit SUBSET of refs
 * (`sdk.export.ifc([wallA, wallB], ...)`), that adapter deliberately does
 * NOT consult this resolver: an explicit selection is a different question
 * ("export exactly these entities") than "what does visible-only mean for
 * the whole model", and must not be broadened or narrowed by whatever the
 * Class tab or storey isolation happen to be set to. See
 * `resolveVisibilityFilterSets`'s own doc in `export-adapter.ts` for that
 * composition.
 */

import { buildHiddenIfcTypes } from './typeVisibilityFilter.js';
import { computeIsolationFilterSet } from './basketVisibleSet.js';
import type { useViewerStore } from './index.js';

type ViewerStateSnapshot = ReturnType<typeof useViewerStore.getState>;

/** Sentinel local model id ExportDialog/GLBExportDialog use for the
 *  legacy (pre-federation) single-model slot. */
const LEGACY_MODEL_ID = '__legacy__';

export interface ExportVisibilityResolution {
  /** Local (per-model) expressIds to exclude from a visible-only export. */
  hiddenLocalIds: Set<number>;
  /** Local expressIds allowed by isolation, or `null` when no storey
   *  selection / class filter / manual isolation is active for this model. */
  isolatedLocalIds: Set<number> | null;
  /** Same information in GLOBAL (renderer) id space, scoped to this model's
   *  id range — for the GLB exporter's global-id assemblers. */
  hiddenGlobalIds: Set<number>;
  isolatedGlobalIds: Set<number> | null;
}

function isLegacyModel(state: ViewerStateSnapshot, modelId: string): boolean {
  return modelId === LEGACY_MODEL_ID || modelId === 'legacy' || state.models.size === 0;
}

function getDataStoreForModel(state: ViewerStateSnapshot, modelId: string) {
  if (isLegacyModel(state, modelId)) return state.ifcDataStore;
  return state.models.get(modelId)?.ifcDataStore ?? null;
}

/** Expand the IFC class names hidden by `typeVisibility` into this model's
 *  local expressIds, via the data store's byType index. */
function collectHiddenIdsByType(
  dataStore: ReturnType<typeof getDataStoreForModel>,
  hiddenTypes: ReadonlySet<string>,
): number[] {
  if (!dataStore || hiddenTypes.size === 0) return [];
  const byType = dataStore.entityIndex?.byType;
  if (!byType) return [];
  const out: number[] = [];
  for (const typeName of hiddenTypes) {
    const ids = byType.get(typeName.toUpperCase());
    if (!ids) continue;
    for (const id of ids) out.push(id);
  }
  return out;
}

/**
 * Resolve the effective visible/hidden entity set for `modelId` from EVERY
 * visibility channel the store carries, in both local (STEP/IFCX) and
 * global (GLB) id space. STEP, IFCX, merged STEP and GLB (the dialog export
 * paths) route through this unconditionally; the SDK/scripting path
 * (`sdk.export.ifc()`) routes through it whenever the caller's refs cover
 * the whole model, but takes a deliberately different path for an explicit
 * ref subset — see module doc's "Every export path routes through this"
 * section for why, and the composition/structural-entity rulings.
 */
export function resolveExportVisibility(
  state: ViewerStateSnapshot,
  modelId: string,
): ExportVisibilityResolution {
  const legacy = isLegacyModel(state, modelId);
  const model = legacy ? undefined : state.models.get(modelId);
  const offset = model?.idOffset ?? 0;
  const maxExpressId = model?.maxExpressId;
  const dataStore = getDataStoreForModel(state, modelId);

  const toGlobal = (localId: number): number => (legacy ? localId : localId + offset);
  const scopeToModel = (globalId: number): number | null => {
    if (legacy) return globalId;
    const localId = globalId - offset;
    if (localId <= 0) return null;
    if (maxExpressId !== undefined && localId > maxExpressId) return null;
    return localId;
  };

  // ---- hidden (denylist): union of every hide channel, GLOBAL space ----
  const hiddenGlobal = new Set<number>();
  for (const g of state.hiddenEntities) hiddenGlobal.add(g);
  for (const g of state.lensHiddenIds) hiddenGlobal.add(g);
  if (!legacy) {
    const modelHidden = state.hiddenEntitiesByModel.get(modelId);
    if (modelHidden) {
      for (const localId of modelHidden) hiddenGlobal.add(toGlobal(localId));
    }
  }
  const hiddenTypes = buildHiddenIfcTypes(state.typeVisibility);
  for (const localId of collectHiddenIdsByType(dataStore, hiddenTypes)) {
    hiddenGlobal.add(toGlobal(localId));
  }

  // ---- isolation allowlist: storey ∩ classFilter ∩ manual global isolate,
  //      further ∩ the per-model isolatedEntitiesByModel channel ----
  let isolatedGlobal = computeIsolationFilterSet(state);
  if (!legacy) {
    const modelIsolated = state.isolatedEntitiesByModel.get(modelId);
    if (modelIsolated && modelIsolated.size > 0) {
      const modelIsolatedGlobal = new Set<number>();
      for (const localId of modelIsolated) modelIsolatedGlobal.add(toGlobal(localId));
      if (isolatedGlobal === null) {
        isolatedGlobal = modelIsolatedGlobal;
      } else {
        const intersected = new Set<number>();
        for (const g of isolatedGlobal) {
          if (modelIsolatedGlobal.has(g)) intersected.add(g);
        }
        isolatedGlobal = intersected;
      }
    }
  }

  // ---- scope to this model's id range, and derive the local variants ----
  const hiddenGlobalIds = new Set<number>();
  const hiddenLocalIds = new Set<number>();
  for (const g of hiddenGlobal) {
    const localId = scopeToModel(g);
    if (localId === null) continue;
    hiddenGlobalIds.add(g);
    hiddenLocalIds.add(localId);
  }

  let isolatedGlobalIds: Set<number> | null = null;
  let isolatedLocalIds: Set<number> | null = null;
  if (isolatedGlobal !== null) {
    isolatedGlobalIds = new Set<number>();
    isolatedLocalIds = new Set<number>();
    for (const g of isolatedGlobal) {
      const localId = scopeToModel(g);
      if (localId === null) continue;
      isolatedGlobalIds.add(g);
      isolatedLocalIds.add(localId);
    }
  }

  return { hiddenLocalIds, isolatedLocalIds, hiddenGlobalIds, isolatedGlobalIds };
}
