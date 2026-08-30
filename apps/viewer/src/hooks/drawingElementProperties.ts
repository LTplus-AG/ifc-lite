/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ElementData.properties` for `useDrawingExport.ts`'s SVG generators, feeding
 * the graphic-override engine's `property`/`propertySet` criteria — e.g. the
 * built-in Fire Safety preset's `FireRating exists` fire-door rule, and
 * Structural's `LoadBearing` rule
 * (`packages/drawing-2d/src/graphic-overrides/presets.ts`).
 * Every `ElementData` construction site used to omit `properties` entirely,
 * so a property criterion could never match: the same gap #3520 found (and
 * removed) for `ElementData.materials`/`.layers`, except here the data
 * genuinely is reachable — `useDrawingExport.ts` already receives
 * `ifcDataStore`, and its SVG generators run once per export, not per frame.
 *
 * `DrawingPolygon.entityId` is a renderer/global id (idOffset-adjusted for
 * federation — see `FederatedModel.idOffset`'s doc comment), not necessarily
 * a raw per-model expressId, so it is resolved back to its owning model's
 * store via `fromGlobalIdFromModels` — the same resolution `bcfIdLookup.ts`
 * uses — before extracting; `legacyStore` covers the pre-federation path
 * where `storeModels` is empty and the global id already IS the local id.
 */

import { extractPropertiesOnDemand, type IfcDataStore } from '@ifc-lite/parser';
import { fromGlobalIdFromModels } from '@/store/globalId';
import type { FederatedModel } from '@/store';

type ElementProperties = Record<string, Record<string, unknown>>;

/** Returns a cache-backed properties getter, scoped to one export pass. */
export function makePropertiesGetter(
  storeModels: ReadonlyMap<string, FederatedModel>,
  legacyStore: IfcDataStore | null,
): (globalId: number) => ElementProperties | undefined {
  const cache = new Map<number, ElementProperties | undefined>();
  return (globalId) => {
    if (cache.has(globalId)) return cache.get(globalId);
    const ref = fromGlobalIdFromModels(storeModels, globalId);
    const store = !ref || ref.modelId === 'legacy'
      ? legacyStore
      : (storeModels.get(ref.modelId)?.ifcDataStore ?? null);
    const psets = store ? extractPropertiesOnDemand(store, ref ? ref.expressId : globalId) : [];
    let result: ElementProperties | undefined;
    if (psets.length > 0) {
      result = {};
      for (const pset of psets) {
        const props: Record<string, unknown> = {};
        for (const prop of pset.properties) props[prop.name] = prop.values ?? prop.value;
        result[pset.name] = props;
      }
    }
    cache.set(globalId, result);
    return result;
  };
}
