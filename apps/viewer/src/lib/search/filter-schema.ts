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
  extractClassificationsOnDemand,
  extractAllMaterialsOnDemand,
  type IfcDataStore,
} from '@ifc-lite/parser';
import { stringifyValue, materialMatchCandidates } from '@ifc-lite/rules';
import { resolveEntityPredefinedType } from '@ifc-lite/rules';

export interface FilterSchema {
  /** [storeyName, elevationMeters | null] sorted by name. */
  storeys: Array<[string, number | null]>;
  /** Distinct IFC type names actually present (e.g. "IfcWall"). Sorted. */
  ifcTypes: string[];
}

/**
 * Distinct VALUES present in the model for the free-text filter dimensions
 * (material / classification / property value), so the chip editors can
 * suggest real values instead of blind free-text. Sampled + capped so the
 * pass stays bounded on huge models. Strings are produced with the SAME
 * `stringifyValue` the evaluator matches against, so picking a suggestion
 * always matches.
 */
export interface FilterValueSchema {
  /** Distinct material names. */
  materials: string[];
  /** Distinct classification system names. */
  classificationSystems: string[];
  /** Distinct classification codes + names. */
  classifications: string[];
  /** Distinct PredefinedType tokens present in the model (e.g. FLOOR, ROOF). (#1462) */
  predefinedTypes: string[];
  /** `propValueKey(set, prop)` → distinct stringified values. */
  propertyValues: Map<string, string[]>;
}

/** Stable key for a (pset, property) pair in `FilterValueSchema.propertyValues`. */
export function propValueKey(setName: string, propertyName: string): string {
  return `${setName}\u0000${propertyName}`;
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
 * Expensive pass — walks every entity that has an on-demand pset/qto
 * map entry and extracts the set/property names. Run once per model
 * lifetime (cache the result in the slice). For a 100K-entity model
 * this is still ~milliseconds because we read the map keys, not values.
 *
 * For the value-extraction path (turning each property into a chip
 * value dropdown) the caller should sample a bounded subset of
 * entities — full enumeration is O(entities × props) and would defeat
 * the on-demand laziness.
 */
export function discoverPropertyAndQuantitySchema(
  store: IfcDataStore,
  /** Restrict discovery to entities of these IFC types (canonical PascalCase,
   *  e.g. "IfcCovering"). When set, only psets/qtos that actually occur on the
   *  selected elements are returned, and they are read directly from those
   *  entities - so a pset attached to an entity missing from the on-demand map
   *  is still found. Empty/omitted = whole-model discovery. (#1462) */
  typeFilter?: readonly string[],
): PsetQtoSchema {
  const psetMap = new Map<string, Set<string>>();
  const qtoMap = new Map<string, Map<string, string>>();

  const addPsets = (entityId: number) => {
    for (const set of extractPropertiesOnDemand(store, entityId)) {
      let bucket = psetMap.get(set.name);
      if (!bucket) { bucket = new Set(); psetMap.set(set.name, bucket); }
      for (const p of set.properties) bucket.add(p.name);
    }
  };
  const addQtos = (entityId: number) => {
    for (const set of extractQuantitiesOnDemand(store, entityId)) {
      let bucket = qtoMap.get(set.name);
      if (!bucket) { bucket = new Map(); qtoMap.set(set.name, bucket); }
      // Unit isn't carried in the on-demand quantity row today - emit "" so the
      // schema shape matches `filter.rs::FilterSchema`.
      for (const q of set.quantities) if (!bucket.has(q.name)) bucket.set(q.name, '');
    }
  };

  // Type-scoped pass: read each selected type's entities directly. Bounded so a
  // huge type can't stall - psets are uniform across instances, so a sample
  // captures the full set.
  const scopedIds = typeFilter && typeFilter.length > 0
    ? collectTypeScopedIds(store, typeFilter, TYPE_SCOPED_CAP)
    : null;
  if (scopedIds) {
    for (const id of scopedIds) { addPsets(id); addQtos(id); }
    return finalizePsetQto(psetMap, qtoMap);
  }

  // Properties — iterate the on-demand map's element keys (already
  // narrowed to entities that declare any pset). For each, extract
  // names only; values are intentionally not collected here.
  if (store.onDemandPropertyMap) {
    for (const entityId of store.onDemandPropertyMap.keys()) addPsets(entityId);
  }

  if (store.onDemandQuantityMap) {
    for (const entityId of store.onDemandQuantityMap.keys()) addQtos(entityId);
  }

  // Fallback for stores without on-demand maps (e.g. server-loaded models):
  // scan the entity column using the pre-built property / quantity tables so
  // discovery stays complete on every load path. Capped to stay bounded.
  if ((!store.onDemandPropertyMap && store.properties) || (!store.onDemandQuantityMap && store.quantities)) {
    const col = store.entities.expressId;
    const CAP = 100_000;
    for (let i = 0, seen = 0; i < col.length && seen < CAP; i++) {
      const entityId = col[i];
      if (!entityId) continue;
      seen++;
      if (!store.onDemandPropertyMap && store.properties) {
        for (const set of store.properties.getForEntity(entityId) ?? []) {
          let bucket = psetMap.get(set.name);
          if (!bucket) { bucket = new Set(); psetMap.set(set.name, bucket); }
          for (const p of set.properties) bucket.add(p.name);
        }
      }
      if (!store.onDemandQuantityMap && store.quantities) {
        for (const set of store.quantities.getForEntity(entityId) ?? []) {
          let bucket = qtoMap.get(set.name);
          if (!bucket) { bucket = new Map(); qtoMap.set(set.name, bucket); }
          for (const q of set.quantities) {
            if (!bucket.has(q.name)) bucket.set(q.name, '');
          }
        }
      }
    }
  }

  return finalizePsetQto(psetMap, qtoMap);
}

/** Entities scanned per type-scoped discovery pass. Psets are uniform across a
 *  type's instances, so a bounded sample captures the full set cheaply. */
const TYPE_SCOPED_CAP = 5_000;

/** Up to `cap` express ids drawn from the `byType` buckets of the requested
 *  canonical type names. `byType` is keyed UPPERCASE (STEP), so uppercase at
 *  the boundary. */
function collectTypeScopedIds(
  store: IfcDataStore,
  typeNames: readonly string[],
  cap: number,
): number[] {
  const byType = store.entityIndex.byType;
  if (!byType || byType.size === 0) return [];
  const out: number[] = [];
  for (const name of typeNames) {
    const bucket = byType.get(name.toUpperCase());
    if (!bucket) continue;
    for (const id of bucket) {
      out.push(id);
      if (out.length >= cap) return out;
    }
  }
  return out;
}

/** Sort the accumulated pset/qto maps into the stable schema shape. */
function finalizePsetQto(
  psetMap: ReadonlyMap<string, Set<string>>,
  qtoMap: ReadonlyMap<string, Map<string, string>>,
): PsetQtoSchema {
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

// ── Value discovery (material / classification / property values) ─────────────

/** Entities scanned per dimension. Bounded so the pass stays cheap on huge
 *  models — value suggestions don't need to be exhaustive to be useful. */
const VALUE_SAMPLE_CAP = 5000;
/** Distinct values kept per property key / dimension. */
const MAX_VALUES_PER_KEY = 200;

/**
 * Expensive pass — samples entities that actually carry materials /
 * classifications / properties (via the on-demand maps, falling back to a
 * stride over the entity column) and collects distinct values. Run lazily
 * and cache the result in the slice, like {@link discoverPropertyAndQuantitySchema}.
 */
export function discoverFilterValues(store: IfcDataStore): FilterValueSchema {
  const materials = new Set<string>();
  const systems = new Set<string>();
  const classifications = new Set<string>();
  const predefinedTypes = new Set<string>();
  const propertyValues = new Map<string, Set<string>>();

  // Same candidate set the `material=` selector matcher uses (`matNamesFor`
  // in filter-evaluate.ts): every association (extractAllMaterialsOnDemand),
  // not just the primary one, each expanded to Name + Category
  // (materialMatchCandidates) — so a value this dropdown offers is always
  // one the matcher actually matches, and vice versa. An entity whose
  // second IfcRelAssociatesMaterial carries the value would otherwise be
  // invisible here even though `material=` already matched it (#4780 gap,
  // one level deeper).
  for (const id of cappedKeys(store.onDemandMaterialMap, store, VALUE_SAMPLE_CAP)) {
    for (const info of extractAllMaterialsOnDemand(store, id)) {
      for (const name of materialMatchCandidates(info)) {
        materials.add(name);
      }
    }
  }

  // PredefinedType has no on-demand map, so stride the entity column. Each read
  // re-parses the entity's attributes (bounded by VALUE_SAMPLE_CAP). (#1462)
  for (const id of cappedKeys(undefined, store, VALUE_SAMPLE_CAP)) {
    const pt = resolveEntityPredefinedType(store, id);
    // USERDEFINED/NOTDEFINED carry no discriminating value - skip the noise.
    if (pt && pt !== 'USERDEFINED' && pt !== 'NOTDEFINED') predefinedTypes.add(pt);
  }

  for (const id of cappedKeys(store.onDemandClassificationMap, store, VALUE_SAMPLE_CAP)) {
    for (const ref of extractClassificationsOnDemand(store, id)) {
      if (ref.system) systems.add(ref.system);
      if (ref.identification) classifications.add(ref.identification);
      if (ref.name) classifications.add(ref.name);
    }
  }

  for (const id of cappedKeys(store.onDemandPropertyMap, store, VALUE_SAMPLE_CAP)) {
    for (const set of extractPropertiesOnDemand(store, id)) {
      for (const p of set.properties) {
        const v = stringifyValue(p.value).trim();
        if (!v) continue;
        const key = propValueKey(set.name, p.name);
        let bucket = propertyValues.get(key);
        if (!bucket) { bucket = new Set(); propertyValues.set(key, bucket); }
        if (bucket.size < MAX_VALUES_PER_KEY) bucket.add(v);
      }
    }
  }

  const sortStrings = (s: Set<string>) => Array.from(s).sort((a, b) => a.localeCompare(b));
  return {
    materials: sortStrings(materials),
    classificationSystems: sortStrings(systems),
    classifications: sortStrings(classifications),
    predefinedTypes: sortStrings(predefinedTypes),
    propertyValues: new Map(Array.from(propertyValues, ([k, s]) => [k, sortStrings(s)])),
  };
}

/**
 * Up to `cap` entity ids to sample. Prefers the keys of the supplied
 * on-demand map (entities that actually have that data), else strides over
 * the full entity column so the sample is spread across the model.
 */
function cappedKeys(
  map: ReadonlyMap<number, unknown> | undefined,
  store: IfcDataStore,
  cap: number,
): number[] {
  const out: number[] = [];
  if (map && map.size > 0) {
    for (const id of map.keys()) {
      out.push(id);
      if (out.length >= cap) break;
    }
    return out;
  }
  const col = store.entities.expressId;
  const stride = Math.max(1, Math.floor(col.length / cap));
  for (let i = 0; i < col.length && out.length < cap; i += stride) {
    if (col[i]) out.push(col[i]);
  }
  return out;
}
