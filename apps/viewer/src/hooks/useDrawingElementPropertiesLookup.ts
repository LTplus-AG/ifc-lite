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
 * Resolving the properties is necessary but not sufficient for all of them:
 * Fire Safety's three rating-band rules use `greaterOrEqual`, and
 * `evaluateOperator` (`rule-engine.ts`) returns false there unless both sides
 * are numbers, so a `FireRating` written as the `IfcLabel` IFC4 specifies
 * (`IFCLABEL('120')`) parses to the string `'120'` and still matches nothing.
 * The `exists`-gated fire-door rule and Structural's `LoadBearing equals true`
 * rule (`IFCBOOLEAN(.T.)` parses to `true`) do match once properties arrive.
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
 * The export and live canvas share the same overlay-aware properties getter.
 */

import { useMemo } from 'react';
import { useViewerStore } from '@/store';
import { useIfc } from './useIfc';
import { makePropertiesGetter } from './drawingElementProperties';
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
  const views = useViewerStore(s => s.mutationViews);
  const revision = useViewerStore(s => s.mutationVersion);
  const { ifcDataStore } = useIfc();

  return useMemo(() => {
    if (!overridesEnabled || !drawing || !engineNeedsProperties(overrideEngine)) return NO_PROPERTIES;

    const getProperties = makePropertiesGetter(models, ifcDataStore, views);
    const cache = new Map<number, ElementData['properties']>();
    for (const polygon of drawing.cutPolygons) cache.set(polygon.entityId, getProperties(polygon.entityId));
    return (entityId: number) => cache.get(entityId);
  }, [drawing, models, views, revision, ifcDataStore, overrideEngine, overridesEnabled]);
}
