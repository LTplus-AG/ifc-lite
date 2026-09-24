/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Property-set properties as IFCX attributes (#5376).
 *
 * The official IFC5 property schema (`prop@v5a.ifcx`) defines a FLAT key per
 * property name, `bsi::ifc::prop::<Name>`, with no pset component, and only
 * for a short list of names ({@link IFC5_KNOWN_PROP_NAMES}). Written as the
 * only key, two psets on one entity that share a property name wrote the same
 * key and the last one silently won. On import, every flat key landed in one
 * catch-all set, so which pset a property came from was never recoverable.
 *
 * Two keys, each where it belongs:
 *  - `bsi::ifc::prop::<Name>` for names the official schema defines, because a
 *    standard IFCX consumer looks the property up there. When two psets
 *    disagree on that one value, the collision is REPORTED
 *    ({@link PropertyCollision}), since the flat key can hold only one.
 *  - `bsi::ifc::v5a::<Pset>::<Name>` with a typed value, for every property
 *    when the caller asked for full fidelity (`onlyKnownProperties: false`).
 *    This is the pset-qualified form the collab snapshots and MCP draft ops
 *    already write and every IFCX reader here already parses, so nothing is
 *    lost and import restores the pset. It has no official schema, which is
 *    why the default (`onlyKnownProperties: true`, official keys only) does
 *    not write it.
 */

import { PropertyValueType } from '@ifc-lite/data';
import { PROPERTY_TYPE_NAMES, V5A_ATTR_PREFIX, type TypedPropertyValue } from '@ifc-lite/ifcx';
import { IFC5_KNOWN_PROP_NAMES, recordIfEmptyPset, type UnrepresentedPropertySet } from './ifc5-export-helpers.js';

/** A flat official-schema key two psets on one entity disagreed on (#5376). */
export interface PropertyCollision {
  entityId: number;
  /** The property name, i.e. the `bsi::ifc::prop::<Name>` suffix. */
  propertyName: string;
  /** The psets that wrote it, in write order; the last one's value is in the flat key. */
  psetNames: string[];
  /**
   * True when a value is missing from the file: only the flat key was written
   * (`onlyKnownProperties: true`). False when every pset's value also went
   * out under its `bsi::ifc::v5a::<Pset>::<Name>` key.
   */
  valueLost: boolean;
}

interface PsetLike {
  name: string;
  properties: ReadonlyArray<{ name: string; value: unknown; type: PropertyValueType }>;
}

/** Sinks this pass reports into, shared across the whole export. */
export interface PsetPropertySinks {
  unrepresentedPropertySets: UnrepresentedPropertySet[];
  propertyCollisions: PropertyCollision[];
}

/** IFCX uses native JSON types rather than IFC wrapped types. */
export function toIfcxValue(value: unknown, type: PropertyValueType): unknown {
  if (value === null || value === undefined) return null;
  switch (type) {
    case PropertyValueType.Real:
      return Number(value);
    case PropertyValueType.Integer:
      return Math.round(Number(value));
    case PropertyValueType.Boolean:
    case PropertyValueType.Logical:
      return Boolean(value);
    default:
      return value;
  }
}

/** A typed record carries a scalar; a list or object value rides as JSON text. */
function typedScalar(value: unknown): string | number | boolean | null {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  return JSON.stringify(value);
}

/**
 * Write one entity's psets into `attributes`. Returns how many property
 * values it wrote (a property written under both keys counts once).
 */
export function writePsetProperties(
  attributes: Record<string, unknown>,
  entityId: number,
  psets: readonly PsetLike[],
  onlyKnownProperties: boolean,
  sinks: PsetPropertySinks,
): number {
  let written = 0;
  const flatWriters = new Map<string, { psets: string[]; value: unknown; conflict: boolean }>();
  for (const pset of psets) {
    if (recordIfEmptyPset(pset, entityId, sinks.unrepresentedPropertySets)) continue;
    for (const prop of pset.properties) {
      const known = IFC5_KNOWN_PROP_NAMES.has(prop.name);
      if (onlyKnownProperties && !known) continue;
      const value = toIfcxValue(prop.value, prop.type);
      if (!onlyKnownProperties) {
        const typed: TypedPropertyValue = { type: PROPERTY_TYPE_NAMES[prop.type] ?? 'IfcLabel', value: typedScalar(value) };
        attributes[`${V5A_ATTR_PREFIX}${pset.name}::${prop.name}`] = typed;
      }
      if (known) {
        const flatKey = `bsi::ifc::prop::${prop.name}`;
        const seen = flatWriters.get(flatKey);
        if (seen) {
          seen.psets.push(pset.name);
          if (JSON.stringify(seen.value) !== JSON.stringify(value)) seen.conflict = true;
          seen.value = value;
        } else {
          flatWriters.set(flatKey, { psets: [pset.name], value, conflict: false });
        }
        attributes[flatKey] = value;
      }
      written++;
    }
  }
  for (const [flatKey, writer] of flatWriters) {
    if (!writer.conflict) continue;
    sinks.propertyCollisions.push({
      entityId,
      propertyName: flatKey.slice('bsi::ifc::prop::'.length),
      psetNames: writer.psets,
      valueLost: onlyKnownProperties,
    });
  }
  return written;
}
