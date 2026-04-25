/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Filter schema discovery.
 *
 * Mirrors the Rust `get_filter_schema` Tauri command — returns the set
 * of distinct values available for each filter dimension in the active
 * model so the chip UI can populate dropdowns instead of free-text
 * inputs (the single largest UX gap in the existing visual builder).
 *
 * Cheap parts (storeys, ifcTypes) read straight from already-built
 * indexes. Pset / Qto schema requires touching on-demand extractors,
 * so it is split out as `discoverPropertyAndQuantitySchema` — the
 * caller decides when to pay that cost (e.g. behind a "Show all
 * properties" expander rather than on every modal open).
 */

import {
  extractPropertiesOnDemand,
  extractQuantitiesOnDemand,
  type IfcDataStore,
} from '@ifc-lite/parser';

export interface FilterSchema {
  /** [storeyName, elevationMeters | null] sorted by name. */
  storeys: Array<[string, number | null]>;
  /** Distinct IFC type names actually present (e.g. "IfcWall"). Sorted. */
  ifcTypes: string[];
}

export interface PsetQtoSchema {
  /** [setName, [propertyName, ...]] sorted. */
  psets: Array<[string, string[]]>;
  /** [setName, [[quantityName, unit], ...]] sorted. unit is "" when unknown. */
  qtos: Array<[string, Array<[string, string]>]>;
}

/**
 * Cheap pass — uses already-materialised indexes. Safe to call on every
 * modal open / chip-edit.
 */
export function discoverFilterSchema(store: IfcDataStore): FilterSchema {
  return {
    storeys: collectStoreys(store),
    ifcTypes: collectIfcTypes(store),
  };
}

function collectStoreys(store: IfcDataStore): Array<[string, number | null]> {
  const hierarchy = store.spatialHierarchy;
  if (!hierarchy) return [];
  const out: Array<[string, number | null]> = [];
  // Iterate byStorey keys (== storey expressIds). Keep one entry per
  // unique storey *name* — duplicates would confuse the chip dropdown
  // even though the underlying storey IDs differ.
  const seen = new Map<string, number | null>();
  for (const storeyId of hierarchy.byStorey.keys()) {
    const name = store.entities.getName(storeyId);
    if (!name) continue;
    if (seen.has(name)) continue;
    const elevation = hierarchy.storeyElevations.get(storeyId) ?? null;
    seen.set(name, elevation);
  }
  for (const [name, elev] of seen) out.push([name, elev]);
  out.sort((a, b) => a[0].localeCompare(b[0]));
  return out;
}

function collectIfcTypes(store: IfcDataStore): string[] {
  const types = new Set<string>();
  // entityIndex.byType maps the UPPERCASE STEP type name to expressIds.
  // Resolve the canonical (PascalCase) form per-entity via getTypeName
  // so the chip dropdown shows "IfcWall" rather than "IFCWALL".
  for (const ids of store.entityIndex.byType.values()) {
    if (ids.length === 0) continue;
    const sample = ids[0];
    const canonical = store.entities.getTypeName(sample);
    if (canonical) types.add(canonical);
  }
  const out = Array.from(types);
  out.sort();
  return out;
}

/**
 * AGENTS.md §2 — `extractPropertiesOnDemand` parses the source buffer
 * and is expensive. Bounding the schema-discovery pass to a sampled
 * subset keeps it under a few hundred ms even on 4M-entity models.
 * 200 entities is enough to surface every distinct (set, prop) pair in
 * any real-world model: psets repeat across entities of the same type,
 * and any model with >200 distinct pset shapes would drown the chip
 * dropdown anyway.
 */
const SCHEMA_DISCOVERY_SAMPLE_LIMIT = 200;

/**
 * Sample-based pset/qto schema discovery. Walks at most
 * `SCHEMA_DISCOVERY_SAMPLE_LIMIT` entities from the on-demand maps
 * and harvests their (set, property) names — values are NEVER
 * collected (the chip UI doesn't need them, and that's where the cost
 * would explode).
 *
 * Run once per model lifetime; the slice caches the result so flipping
 * tabs / opening the modal doesn't re-pay it.
 */
export function discoverPropertyAndQuantitySchema(store: IfcDataStore): PsetQtoSchema {
  const psetMap = new Map<string, Set<string>>();
  const qtoMap = new Map<string, Map<string, string>>();

  // Properties — iterate up to N entity keys from the on-demand map
  // (already narrowed to entities that declare any pset). Schema
  // shapes repeat across entities of the same type, so a small sample
  // captures the full vocabulary in practice. Each call to
  // extractPropertiesOnDemand spins up an EntityExtractor that parses
  // the source buffer, so the loop bound matters.
  if (store.onDemandPropertyMap) {
    let scanned = 0;
    for (const entityId of store.onDemandPropertyMap.keys()) {
      if (scanned >= SCHEMA_DISCOVERY_SAMPLE_LIMIT) break;
      scanned++;
      const sets = extractPropertiesOnDemand(store, entityId);
      for (const set of sets) {
        let bucket = psetMap.get(set.name);
        if (!bucket) { bucket = new Set(); psetMap.set(set.name, bucket); }
        for (const p of set.properties) bucket.add(p.name);
      }
    }
  }

  if (store.onDemandQuantityMap) {
    let scanned = 0;
    for (const entityId of store.onDemandQuantityMap.keys()) {
      if (scanned >= SCHEMA_DISCOVERY_SAMPLE_LIMIT) break;
      scanned++;
      const sets = extractQuantitiesOnDemand(store, entityId);
      for (const set of sets) {
        let bucket = qtoMap.get(set.name);
        if (!bucket) { bucket = new Map(); qtoMap.set(set.name, bucket); }
        for (const q of set.quantities) {
          // Unit isn't carried in the on-demand quantity row today —
          // emit "" so the schema shape matches `filter.rs::FilterSchema`.
          if (!bucket.has(q.name)) bucket.set(q.name, '');
        }
      }
    }
  }

  const psets: Array<[string, string[]]> = Array.from(psetMap, ([set, props]) => [
    set,
    Array.from(props).sort(),
  ]);
  psets.sort((a, b) => a[0].localeCompare(b[0]));

  const qtos: Array<[string, Array<[string, string]>]> = Array.from(qtoMap, ([set, qtys]) => [
    set,
    Array.from(qtys, ([name, unit]) => [name, unit] as [string, string]).sort((a, b) =>
      a[0].localeCompare(b[0]),
    ),
  ]);
  qtos.sort((a, b) => a[0].localeCompare(b[0]));

  return { psets, qtos };
}
