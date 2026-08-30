/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ElementData.properties` resolution for the LIVE 2D drawing canvas
 * (`Drawing2DCanvas.tsx`).
 *
 * `ElementData.properties` is read by the graphic-override rule engine's
 * `property`/`propertySet` criteria, which back the built-in "Fire Safety"
 * (`FireRating`) and "Structural Highlight" (`LoadBearing`) presets
 * (`packages/drawing-2d/src/graphic-overrides/presets.ts`). Every
 * `ElementData` built by the canvas historically set only `expressId`/
 * `ifcType`, so those presets silently matched nothing on screen — a
 * FireRating-gated rule never won over its lower-priority base rule, no
 * matter how an element was rated.
 *
 * `Drawing2DCanvas.tsx` redraws inside a `useEffect` keyed on `transform`
 * (so on every pan/zoom, not just on section regeneration), and that draw
 * loop calls `overrideEngine.applyOverrides` per cut polygon. Extracting
 * properties there would mean re-parsing the source buffer for every
 * visible element on every pan frame. Instead, this hook resolves the whole
 * (model set, polygon set) once via `useMemo` — keyed on `drawing` (the
 * polygon set) and `models`/`ifcDataStore` (the model set), NOT on
 * `transform` — and hands the draw loop an O(1) synchronous lookup.
 *
 * When no active, enabled rule uses a `property`/`propertySet` criterion,
 * the memo skips extraction entirely and returns a no-op lookup, so models
 * whose active rules only match on `ifcType`/`expressId`/`modelId` pay
 * nothing.
 *
 * This mirrors the export-side resolution added by (unmerged) PR #3523's
 * `apps/viewer/src/hooks/drawingElementProperties.ts` (`makePropertiesGetter`)
 * — same `fromGlobalIdFromModels` + `extractPropertiesOnDemand` shape, same
 * per-entity cache. That helper does not exist on `main` yet; once #3523
 * lands, the two should be unified into one shared resolver rather than
 * kept as two independent copies of the same logic.
 */

import { useMemo } from 'react';
import { useViewerStore } from '@/store';
import { useIfc } from './useIfc';
import { fromGlobalIdFromModels } from '@/store/globalId';
import { extractPropertiesOnDemand } from '@ifc-lite/parser';
import type { Drawing2D, ElementData, GraphicOverrideEngine, OverrideCriteria, OverrideCriterion } from '@ifc-lite/drawing-2d';

/** A cheap, synchronous `entityId -> properties` lookup, safe to call from
 *  a per-frame draw loop: all extraction already happened in `useMemo`. */
export type ElementPropertiesLookup = (entityId: number) => ElementData['properties'];

const NO_PROPERTIES: ElementPropertiesLookup = () => undefined;

/** Recurses through compound (`and`/`or`) criteria to find a `property` or
 *  `propertySet` leaf — the only criterion types that read `ElementData.properties`. */
function criterionNeedsProperties(criteria: OverrideCriterion | OverrideCriteria): boolean {
  if ('logic' in criteria) return criteria.conditions.some(criterionNeedsProperties);
  return criteria.type === 'property' || criteria.type === 'propertySet';
}

function engineNeedsProperties(engine: GraphicOverrideEngine): boolean {
  return engine.getRules().some((rule) => rule.enabled && criterionNeedsProperties(rule.criteria));
}

/**
 * Returns the live-canvas properties lookup. Resolved once via `useMemo`
 * when `drawing` (polygon set) or the loaded model set changes — never
 * inside `Drawing2DCanvas`'s per-frame draw `useEffect`.
 */
export function useDrawingElementPropertiesLookup(
  drawing: Drawing2D | null,
  overrideEngine: GraphicOverrideEngine,
  overridesEnabled: boolean,
): ElementPropertiesLookup {
  const models = useViewerStore((s) => s.models);
  const { ifcDataStore } = useIfc();

  return useMemo(() => {
    if (!overridesEnabled || !drawing || !engineNeedsProperties(overrideEngine)) return NO_PROPERTIES;

    const cache = new Map<number, ElementData['properties']>();
    for (const polygon of drawing.cutPolygons) {
      if (cache.has(polygon.entityId)) continue;
      const ref = fromGlobalIdFromModels(models, polygon.entityId);
      const store = ref ? (ref.modelId === 'legacy' ? ifcDataStore : (models.get(ref.modelId)?.ifcDataStore ?? null)) : null;
      if (!ref || !store) {
        cache.set(polygon.entityId, undefined);
        continue;
      }
      const properties: NonNullable<ElementData['properties']> = {};
      for (const pset of extractPropertiesOnDemand(store, ref.expressId)) {
        const values: Record<string, unknown> = {};
        for (const prop of pset.properties) values[prop.name] = prop.value;
        properties[pset.name] = values;
      }
      cache.set(polygon.entityId, properties);
    }
    return (entityId: number) => cache.get(entityId);
  }, [drawing, models, ifcDataStore, overrideEngine, overridesEnabled]);
}
