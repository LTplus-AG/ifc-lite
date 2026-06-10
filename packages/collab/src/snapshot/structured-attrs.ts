/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Structured-branch ↔ namespaced-attribute conversion (#1031).
 *
 * The Y.Doc keeps psets / quantities / classifications / materials /
 * geometryRef as dedicated CRDT branches so concurrent edits to
 * different branches never conflict, but the IFCX wire type only has
 * `attributes` / `children` / `inherits`. At the snapshot boundary the
 * structured branches fold into ordinary attributes; `seedFromIfcx`
 * re-inflates them, so structured edits survive snapshot → seed
 * round-trips.
 *
 * Representation (the convention the MCP draft tools, the merge
 * engine's `pset:`/`qset:` component keys, scope verification, and the
 * IFC4→5 migration already share):
 *   - pset property  → `bsi::ifc::v5a::<Set>::<Prop>` with the full
 *     typed PropertyValue object as the attribute value;
 *   - quantity       → `bsi::ifc::v5a::<Qto_Set>::<Name>` with the raw
 *     number as the attribute value;
 *   - classifications / materials / geometryRef → single attributes
 *     under the `ifclite::` extension namespace (whole-array values:
 *     the Y.Array is the unit users edit, and merge granularity at the
 *     array level matches that).
 *
 * Inflation is shape-gated so legacy flat attributes written by the
 * IFC4→IFC5 migration (raw values under the same v5a keys) stay flat:
 * only PropertyValue-shaped objects inflate into psets, and numbers
 * inflate into quantities unless the set is `Pset_`-named — the
 * migration only ever emits `Pset_*` set names, so that exclusion is
 * exactly the legacy population, and custom quantity-set names still
 * round-trip. Both directions are inverse to each other, so
 * flatten(inflate(x)) == x and a doc holding the same key in both the
 * flat and structured branch serializes deterministically (structured
 * wins).
 */

import { IFCLITE_ATTR, V5A_ATTR_PREFIX, isTypedPropertyValue, parseV5aKey } from '@ifc-lite/ifcx';
import * as Y from 'yjs';
import {
  GEOMETRY_KEY,
  geometryMap,
  type ClassificationRef,
  type GeometryRefRecord,
  type MaterialAssignment,
  type PropertyValue,
} from '../doc/schema.js';

// Re-exported for existing consumers; the canonical definition lives in
// @ifc-lite/ifcx next to the routing rule that shares the dialect.
export { V5A_ATTR_PREFIX };

/**
 * Numbers under `Pset_*` sets never inflate into quantities: the
 * IFC4→IFC5 migration writes raw scalars under `Pset_*` keys only, so
 * this exclusion keeps exactly that legacy population flat while any
 * other set name (Qto_* or custom) round-trips as a quantity.
 */
const PSET_SET_RE = /^Pset_/;

/** `Qto_*` members route to quantities even when wrapped in a typed record. */
const QTO_SET_RE = /^Qto_/;

/**
 * Shape test for the typed PropertyValue record — the canonical wire
 * shape every writer and reader shares (`isTypedPropertyValue` in
 * `@ifc-lite/ifcx`). Strict on purpose: legacy migrated attributes
 * carry raw scalars, never `{type, value}` objects, so this is what
 * disambiguates pset inflation from "leave it as a flat attribute".
 */
export function isPropertyValueShaped(value: unknown): value is PropertyValue {
  return isTypedPropertyValue(value);
}

function isClassificationRefShaped(value: unknown): value is ClassificationRef {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.system === 'string' && typeof record.code === 'string';
}

function isMaterialAssignmentShaped(value: unknown): value is MaterialAssignment {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  return typeof (value as Record<string, unknown>).materialId === 'string';
}

/** The structured branches `entityToJSON` exposes alongside attributes. */
export interface StructuredBranchesJSON {
  psets: Record<string, Record<string, PropertyValue>>;
  quantities: Record<string, Record<string, number>>;
  classifications: ClassificationRef[];
  materials: MaterialAssignment[];
  geometryRef?: string;
}

/**
 * Wire form of a geometry reference whose target record is known at
 * snapshot time: carrying the record (sans CRDT version vector) keeps
 * the round-trip self-contained — a seed can recreate the geometry map
 * entry instead of restoring a dangling ref. A bare `geomId` string is
 * still valid for refs whose geometry hydrates out-of-band (blob sync).
 */
export interface GeometryRefCarrier {
  geomId: string;
  type?: string;
  source?: string;
  blobHash?: string;
  params?: Record<string, unknown>;
  bbox?: number[];
}

export interface FlattenOptions {
  /**
   * Resolve a geometry record for a geomId (typically from the doc's
   * top-level geometry map). When it returns one, the carrier embeds it;
   * otherwise only the id travels.
   */
  geometryRecordFor?: (geomId: string) => Omit<GeometryRefCarrier, 'geomId'> | undefined;
}

/** Attribute key for one pset property / quantity. */
export function structuredAttributeKey(setName: string, name: string): string {
  return `${V5A_ATTR_PREFIX}${setName}::${name}`;
}

/**
 * Fold an entity's structured branches into its flat attribute record.
 * Structured values overwrite same-key flat attributes — the typed
 * branch is the newer write path, so it wins deterministically.
 */
export function flattenStructuredBranches(
  json: { attributes: Record<string, unknown> } & StructuredBranchesJSON,
  options: FlattenOptions = {},
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...json.attributes };

  for (const [setName, props] of Object.entries(json.psets)) {
    for (const [propName, value] of Object.entries(props)) {
      out[structuredAttributeKey(setName, propName)] = { ...value };
    }
  }
  for (const [setName, qtys] of Object.entries(json.quantities)) {
    for (const [qtyName, value] of Object.entries(qtys)) {
      out[structuredAttributeKey(setName, qtyName)] = value;
    }
  }
  if (json.classifications.length > 0) {
    out[IFCLITE_ATTR.CLASSIFICATIONS] = json.classifications.map((ref) => ({ ...ref }));
  }
  if (json.materials.length > 0) {
    out[IFCLITE_ATTR.MATERIALS] = json.materials.map((mat) => ({ ...mat }));
  }
  if (typeof json.geometryRef === 'string') {
    const record = options.geometryRecordFor?.(json.geometryRef);
    out[IFCLITE_ATTR.GEOMETRY_REF] = record
      ? ({ geomId: json.geometryRef, ...record } satisfies GeometryRefCarrier)
      : json.geometryRef;
  }

  return out;
}

export interface InflatedAttributes extends StructuredBranchesJSON {
  /** Whatever didn't inflate — stays in the flat attributes branch. */
  attributes: Record<string, unknown>;
  geometryRefRecord?: GeometryRefRecord;
  /** Embedded geometry record to recreate in the doc's geometry map, if carried. */
  geometryCarrier?: GeometryRefCarrier;
}

/**
 * Inverse of `flattenStructuredBranches`: split an IFCX attribute
 * record into the flat remainder and the structured branches. Keys
 * whose values don't pass the shape gates stay flat (legacy migrated
 * raw values, foreign data under colliding namespaces).
 */
export function inflateStructuredAttributes(
  attributes: Record<string, unknown>,
): InflatedAttributes {
  const flat: Record<string, unknown> = {};
  const psets: Record<string, Record<string, PropertyValue>> = {};
  const quantities: Record<string, Record<string, number>> = {};
  let classifications: ClassificationRef[] = [];
  let materials: MaterialAssignment[] = [];
  let geometryRef: string | undefined;
  let geometryCarrier: GeometryRefCarrier | undefined;

  for (const [key, value] of Object.entries(attributes)) {
    if (key === IFCLITE_ATTR.CLASSIFICATIONS) {
      if (Array.isArray(value) && value.every(isClassificationRefShaped)) {
        classifications = value.map((ref) => ({ ...ref }));
        continue;
      }
      flat[key] = value;
      continue;
    }
    if (key === IFCLITE_ATTR.MATERIALS) {
      if (Array.isArray(value) && value.every(isMaterialAssignmentShaped)) {
        materials = value.map((mat) => ({ ...mat }));
        continue;
      }
      flat[key] = value;
      continue;
    }
    if (key === IFCLITE_ATTR.GEOMETRY_REF) {
      if (typeof value === 'string') {
        geometryRef = value;
        continue;
      }
      if (isGeometryRefCarrierShaped(value)) {
        geometryRef = value.geomId;
        geometryCarrier = { ...value };
        continue;
      }
      flat[key] = value;
      continue;
    }

    {
      const v5a = parseV5aKey(key);
      if (v5a) {
        const { setName, name } = v5a;
        // Qto_* members are quantities before anything else: a typed
        // record under a quantity set (e.g. written by a draft
        // set_property op) unwraps to its number — otherwise the value
        // would land in psets and compete with later quantity edits on
        // the same wire key. The quantities branch stores plain numbers,
        // so the raw number is the canonical re-flattened shape.
        if (QTO_SET_RE.test(setName)) {
          const candidate = isPropertyValueShaped(value) ? value.value : value;
          if (typeof candidate === 'number' && Number.isFinite(candidate)) {
            (quantities[setName] ??= {})[name] = candidate;
            continue;
          }
        }
        if (isPropertyValueShaped(value)) {
          (psets[setName] ??= {})[name] = { ...value };
          continue;
        }
        if (typeof value === 'number' && Number.isFinite(value) && !PSET_SET_RE.test(setName)) {
          (quantities[setName] ??= {})[name] = value;
          continue;
        }
      }
    }

    flat[key] = value;
  }

  return {
    attributes: flat,
    psets,
    quantities,
    classifications,
    materials,
    geometryRef,
    geometryRefRecord: geometryRef !== undefined ? { geomId: geometryRef } : undefined,
    geometryCarrier,
  };
}

function isGeometryRefCarrierShaped(value: unknown): value is GeometryRefCarrier {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  return typeof (value as Record<string, unknown>).geomId === 'string';
}

/**
 * `FlattenOptions.geometryRecordFor` backed by `doc`'s geometry map.
 * The CRDT version vector is replica bookkeeping and never travels.
 */
export function geometryRecordLookup(
  doc: Y.Doc,
): (geomId: string) => Omit<GeometryRefCarrier, 'geomId'> | undefined {
  return (geomId) => {
    const entry = geometryMap(doc).get(geomId) as Y.Map<unknown> | undefined;
    if (!entry) return undefined;
    const record: Omit<GeometryRefCarrier, 'geomId'> = {};
    const type = entry.get(GEOMETRY_KEY.TYPE);
    if (typeof type === 'string') record.type = type;
    const source = entry.get(GEOMETRY_KEY.SOURCE);
    if (typeof source === 'string') record.source = source;
    const blobHash = entry.get(GEOMETRY_KEY.BLOB_HASH);
    if (typeof blobHash === 'string') record.blobHash = blobHash;
    const params = entry.get(GEOMETRY_KEY.PARAMS);
    if (params instanceof Y.Map && params.size > 0) {
      const plain: Record<string, unknown> = {};
      for (const [k, v] of params.entries()) plain[k] = v;
      record.params = plain;
    }
    const bbox = entry.get(GEOMETRY_KEY.BBOX);
    if (Array.isArray(bbox)) record.bbox = bbox as number[];
    return record;
  };
}
