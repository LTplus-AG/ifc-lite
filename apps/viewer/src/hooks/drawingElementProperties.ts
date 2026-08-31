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
 *
 * The engine wants a record keyed by set name; the parser returns a list of
 * sets. Two things about that list survive the flattening on purpose:
 *
 * - An entity can carry several property sets with the SAME name (one from
 *   the type definition, one from the occurrence, each via its own
 *   `IfcRelDefinesByProperties`) — `extractPropertiesOnDemand` returns one
 *   entry per set and does not merge them. Assigning `result[pset.name]`
 *   outright would let the later set erase the earlier one and every
 *   property in it, which is the #3465/#3468 duplicate-pset defect in
 *   another shape; `scripts/check-pset-name-find.mjs` does not catch it
 *   because it looks for a two-step `.find`, not for record-keying. Sets
 *   sharing a name are merged, first match across the sequence winning —
 *   the semantics `findPropertyInSets` (`packages/query/src/pset-lookup.ts`)
 *   settled for the rest of the repo.
 * - `prop.value` is the scalar the property panel shows; `prop.values` is
 *   the parser's raw `string[]` for the multi-valued subtypes
 *   (`IfcPropertyEnumeratedValue`, `…ListValue`, `…BoundedValue`,
 *   `…TableValue`). The engine gets `value`. Every string operator in
 *   `rule-engine.ts` `evaluateOperator` returns false unless
 *   `typeof actual === 'string'`, and `in`/`notIn` compare an array by
 *   identity, so handing over the array would leave those properties able
 *   to satisfy `exists`/`notExists` and nothing else — Fire Safety's
 *   `OccupancyType contains 'CIRCULATION'` would never match an enumerated
 *   OccupancyType.
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
        const props = (result[pset.name] ??= {});
        for (const prop of pset.properties) {
          if (!Object.hasOwn(props, prop.name)) props[prop.name] = prop.value;
        }
      }
    }
    cache.set(globalId, result);
    return result;
  };
}
