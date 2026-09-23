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
 * Cheap parts (storeys, ifcTypes) read the effective entity index. Pset /
 * Qto schema requires touching on-demand extractors,
 * so it is split out as `discoverPropertyAndQuantitySchema` — the
 * caller decides when to pay that cost (e.g. behind a "Show all
 * properties" expander rather than on every modal open).
 */

import {
  extractClassificationsOnDemand,
  extractAllMaterialsOnDemand,
  type IfcDataStore,
} from '@ifc-lite/parser';
import { iterateEffectiveEntityIds, type MutablePropertyView } from '@ifc-lite/mutations';
import {
  stringifyValue, materialMatchCandidates, ownPropertySetsFor, quantitySetsFor,
  attributesFor, mutatedAttributeValue,
} from '@ifc-lite/rules';
import { resolveEntityPredefinedType } from '@ifc-lite/rules';
import { canonicalEffectiveType, effectiveCandidateIds, effectiveStoreyOption } from './filter-schema-effective.js';

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
 * Cheap pass over one model's current entity set. Safe to call when the
 * model or its mutation version changes.
 */
export function discoverFilterSchema(
  store: IfcDataStore,
  view?: MutablePropertyView | null,
): FilterSchema {
  return {
    storeys: discoverFilterStoreys(store, view),
    ifcTypes: collectIfcTypes(store, view),
  };
}

export function discoverFilterStoreys(store: IfcDataStore, view?: MutablePropertyView | null): Array<[string, number | null]> {
  const out: Array<[string, number | null]> = [];
  // Keep one entry per unique storey name, even when several live storeys
  // share it. Source deletions/retypes and overlay creations are all folded.
  const seen = new Map<string, number | null>();
  for (const { expressId } of iterateEffectiveEntityIds(store, view, ['IFCBUILDINGSTOREY'])) {
    const option = effectiveStoreyOption(store, view, expressId);
    if (!option) continue;
    const [name, elevation] = option;
    if (seen.has(name)) continue;
    seen.set(name, elevation);
  }
  for (const [name, elev] of seen) out.push([name, elev]);
  out.sort((a, b) => a[0].localeCompare(b[0]));
  return out;
}

function collectIfcTypes(store: IfcDataStore, view: MutablePropertyView | null | undefined): string[] {
  const rawTypes = new Set<string>();
  for (const { type } of iterateEffectiveEntityIds(store, view)) {
    rawTypes.add(type);
  }
  const out = Array.from(new Set(Array.from(rawTypes, canonicalEffectiveType)));
  out.sort();
  return out;
}

/**
 * Expensive pass — walks every entity that has an on-demand pset/qto
 * map entry and extracts the set/property names. Cache per model and
 * mutation version in the slice. For a 100K-entity model
 * this is still ~milliseconds because we read the map keys, not values.
 *
 * For the value-extraction path (turning each property into a chip
 * value dropdown) the caller should sample a bounded subset of
 * entities — extracting every value is O(entities × props) and would defeat
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
  view?: MutablePropertyView | null,
): PsetQtoSchema {
  const psetMap = new Map<string, Set<string>>();
  const qtoMap = new Map<string, Map<string, string>>();

  const addPsets = (entityId: number) => {
    for (const set of ownPropertySetsFor(store, entityId, view ?? undefined)) {
      let bucket = psetMap.get(set.name);
      if (!bucket) { bucket = new Set(); psetMap.set(set.name, bucket); }
      for (const p of set.properties) bucket.add(p.name);
    }
  };
  const addQtos = (entityId: number) => {
    for (const set of quantitySetsFor(store, entityId, view ?? undefined)) {
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
    ? collectTypeScopedIds(store, typeFilter, TYPE_SCOPED_CAP, view)
    : null;
  if (scopedIds) {
    for (const id of scopedIds) { addPsets(id); addQtos(id); }
    return finalizePsetQto(psetMap, qtoMap);
  }

  // Properties — iterate the on-demand map's element keys (already
  // narrowed to entities that declare any pset). For each, extract
  // names only; values are intentionally not collected here.
  if (store.onDemandPropertyMap) {
    for (const entityId of effectiveCandidateIds(store, view, store.onDemandPropertyMap.keys(), 100_000)) addPsets(entityId);
  }

  if (store.onDemandQuantityMap) {
    for (const entityId of effectiveCandidateIds(store, view, store.onDemandQuantityMap.keys(), 100_000)) addQtos(entityId);
  }

  // Fallback for stores without on-demand maps (e.g. server-loaded models):
  // scan the effective entity set using the pre-built property / quantity tables so
  // discovery stays complete on every load path. Capped to stay bounded.
  if ((!store.onDemandPropertyMap && store.properties) || (!store.onDemandQuantityMap && store.quantities)) {
    let seen = 0;
    for (const { expressId } of iterateEffectiveEntityIds(store, view)) {
      if (!store.onDemandPropertyMap && store.properties) addPsets(expressId);
      if (!store.onDemandQuantityMap && store.quantities) addQtos(expressId);
      if (++seen >= 100_000) break;
    }
  }

  // An existing entity can receive a new set without gaining an on-demand
  // map key. Read current overlay changes rather than append-only history so
  // undo and delete do not leave stale suggestions behind.
  if (view) {
    const propertyIds = new Set<number>();
    const quantityIds = new Set<number>();
    for (const change of view.getEffectiveChanges()) {
      if (change.kind === 'property' || change.kind === 'pset-added' || change.kind === 'pset-deleted') propertyIds.add(change.entityId);
      if (change.kind === 'quantity' || change.kind === 'qset-added' || change.kind === 'qset-deleted') quantityIds.add(change.entityId);
    }
    if (propertyIds.size || quantityIds.size) {
      for (const { expressId } of iterateEffectiveEntityIds(store, view)) {
        if (propertyIds.has(expressId)) addPsets(expressId);
        if (quantityIds.has(expressId)) addQtos(expressId);
      }
    }
  }

  return finalizePsetQto(psetMap, qtoMap);
}

/** Entities scanned per type-scoped discovery pass. Psets are uniform across a
 *  type's instances, so a bounded sample captures the full set cheaply. */
const TYPE_SCOPED_CAP = 5_000;

/** Up to `cap` live express ids for the requested canonical type names. */
function collectTypeScopedIds(
  store: IfcDataStore,
  typeNames: readonly string[],
  cap: number,
  view: MutablePropertyView | null | undefined,
): number[] {
  const out: number[] = [];
  for (const { expressId } of iterateEffectiveEntityIds(store, view, typeNames)) {
    out.push(expressId);
    if (out.length >= cap) break;
  }
  if (view) {
    const edited = new Set(view.getEffectiveChanges().map((change) => change.entityId));
    const seen = new Set(out);
    for (const { expressId } of iterateEffectiveEntityIds(store, view, typeNames)) {
      if (edited.has(expressId) && !seen.has(expressId)) {
        out.push(expressId);
        seen.add(expressId);
      }
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
export function discoverFilterValues(
  store: IfcDataStore,
  view?: MutablePropertyView | null,
): FilterValueSchema {
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
  for (const id of cappedKeys(store.onDemandMaterialMap, store, view, VALUE_SAMPLE_CAP)) {
    for (const info of extractAllMaterialsOnDemand(store, id)) {
      for (const name of materialMatchCandidates(info)) {
        materials.add(name);
      }
    }
  }

  // PredefinedType has no on-demand map, so stride the entity column. Each read
  // re-parses the entity's attributes (bounded by VALUE_SAMPLE_CAP). (#1462)
  for (const id of cappedKeys(undefined, store, view, VALUE_SAMPLE_CAP)) {
    const authored = view?.getNewEntity(id)
      ? attributesFor(store, id, view).find((a) => a.name === 'PredefinedType')?.value
      : mutatedAttributeValue(view ?? undefined, id, 'PredefinedType');
    const pt = typeof authored === 'string' ? authored : resolveEntityPredefinedType(store, id);
    // USERDEFINED/NOTDEFINED carry no discriminating value - skip the noise.
    if (pt && pt !== 'USERDEFINED' && pt !== 'NOTDEFINED') predefinedTypes.add(pt);
  }

  for (const id of cappedKeys(store.onDemandClassificationMap, store, view, VALUE_SAMPLE_CAP)) {
    for (const ref of extractClassificationsOnDemand(store, id)) {
      if (ref.system) systems.add(ref.system);
      if (ref.identification) classifications.add(ref.identification);
      if (ref.name) classifications.add(ref.name);
    }
  }

  for (const id of cappedKeys(store.onDemandPropertyMap, store, view, VALUE_SAMPLE_CAP)) {
    for (const set of ownPropertySetsFor(store, id, view ?? undefined)) {
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
 * Up to `cap` live entity ids to sample. Prefers the supplied on-demand map
 * keys, then spreads the sample over the effective model when that map is
 * absent. Creations remain candidates in either case.
 */
function cappedKeys(
  map: ReadonlyMap<number, unknown> | undefined,
  store: IfcDataStore,
  view: MutablePropertyView | null | undefined,
  cap: number,
): number[] {
  return effectiveCandidateIds(store, view, map && map.size > 0 ? map.keys() : undefined, cap);
}
