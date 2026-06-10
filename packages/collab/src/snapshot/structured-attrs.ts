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
 * only PropertyValue-shaped objects inflate into psets, and only
 * numbers under a `Qto_*` set inflate into quantities. Both directions
 * are inverse to each other, so flatten(inflate(x)) == x and a doc
 * holding the same key in both the flat and structured branch
 * serializes deterministically (structured wins).
 */

import { IFCLITE_ATTR } from '@ifc-lite/ifcx';
import type {
  ClassificationRef,
  GeometryRefRecord,
  MaterialAssignment,
  PropertyValue,
} from '../doc/schema.js';

/**
 * IFC5-alpha namespaced property prefix — same literal the
 * IFC4→IFC4x3/5 attribute migration emits.
 */
export const V5A_ATTR_PREFIX = 'bsi::ifc::v5a::';

/** Quantity sets must follow the IFC `Qto_*` naming to round-trip. */
const QTO_SET_RE = /^Qto_/;

const PROPERTY_VALUE_KEYS = new Set(['type', 'value', 'unit', 'source']);

/**
 * Shape test for the typed PropertyValue record. Strict on purpose:
 * legacy migrated attributes carry raw scalars, never `{type, value}`
 * objects, so this is what disambiguates pset inflation from "leave it
 * as a flat attribute".
 */
export function isPropertyValueShaped(value: unknown): value is PropertyValue {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.type !== 'string') return false;
  if (!('value' in record)) return false;
  const v = record.value;
  if (v !== null && typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') {
    return false;
  }
  for (const key of Object.keys(record)) {
    if (!PROPERTY_VALUE_KEYS.has(key)) return false;
  }
  if ('unit' in record && record.unit !== undefined && typeof record.unit !== 'string') return false;
  if ('source' in record && record.source !== undefined && typeof record.source !== 'string') return false;
  return true;
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
    out[IFCLITE_ATTR.GEOMETRY_REF] = json.geometryRef;
  }

  return out;
}

export interface InflatedAttributes extends StructuredBranchesJSON {
  /** Whatever didn't inflate — stays in the flat attributes branch. */
  attributes: Record<string, unknown>;
  geometryRefRecord?: GeometryRefRecord;
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
      flat[key] = value;
      continue;
    }

    if (key.startsWith(V5A_ATTR_PREFIX)) {
      const rest = key.slice(V5A_ATTR_PREFIX.length);
      const sep = rest.indexOf('::');
      if (sep > 0 && sep < rest.length - 2) {
        const setName = rest.slice(0, sep);
        const name = rest.slice(sep + 2);
        if (isPropertyValueShaped(value)) {
          (psets[setName] ??= {})[name] = { ...value };
          continue;
        }
        if (typeof value === 'number' && Number.isFinite(value) && QTO_SET_RE.test(setName)) {
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
  };
}
