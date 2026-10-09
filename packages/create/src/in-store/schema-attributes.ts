/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Lay out an entity's STEP attributes from the bundled schema registry of the
 * target schema, by EXPRESS attribute name. The type-object and material
 * builders use it because their layouts differ between IFC2X3, IFC4 and
 * IFC4X3 (`IfcMaterial.Category`, `IfcMaterialLayer.Priority`,
 * `IfcMaterialLayerSetUsage.ReferenceExtent`, `IfcDoorType` only from IFC4 on,
 * ...). Reading the layout from the registry keeps every schema right at once,
 * instead of hand-maintaining one attribute order per schema per class.
 *
 * Values: a string on an ENUMERATION attribute is validated against that
 * enumeration and written as `.VALUE.`; a number on a REAL-based attribute is
 * written as a STEP REAL; a boolean on a BOOLEAN/LOGICAL attribute becomes
 * `.T.`/`.F.`; `undefined`/`null` become `$`, which is refused for a mandatory
 * attribute unless it is an enumeration, which defaults to `NOTDEFINED` when
 * the enumeration has that value.
 */

import { getSchemaRegistryForVersion, getCanonicalEntityName, type SchemaRegistry } from '@ifc-lite/parser';
import type { SpatialAnchorSchema } from './anchor.js';

type Schema = Exclude<SpatialAnchorSchema, 'IFC5'>;

const AUTHORING_SCHEMAS: readonly string[] = ['IFC2X3', 'IFC4', 'IFC4X3'];

/**
 * The registry for an authoring schema (default IFC4). Refuses IFC5 / IFCX and
 * anything else that is not IFC2X3, IFC4 or IFC4X3: the in-store builders write
 * STEP entities, which those models do not have.
 */
export function schemaRegistry(schema: SpatialAnchorSchema | undefined, op: string): SchemaRegistry {
  const version: string = schema ?? 'IFC4';
  if (!AUTHORING_SCHEMAS.includes(version)) {
    throw new Error(`${op}: authoring ${version} models is not supported; use IFC2X3, IFC4 or IFC4X3`);
  }
  return getSchemaRegistryForVersion(version as Schema);
}

/** The schema's canonical spelling of `type`, or null when the class does not exist in it. */
export function canonicalEntity(registry: SchemaRegistry, type: string): string | null {
  return getCanonicalEntityName(registry, type) ?? null;
}

/**
 * Whether `type` is an `expected` in the schema: the class itself or one of its
 * subtypes, or (transitively) a member of the `expected` SELECT.
 */
export function conformsTo(registry: SchemaRegistry, type: string, expected: string): boolean {
  const name = canonicalEntity(registry, type);
  if (!name) return false;
  const chain = registry.entities[name].inheritanceChain ?? [name];
  const matches = (target: string, depth: number): boolean =>
    chain.includes(target) || (depth < 8 && (registry.selects[target] ?? []).some((member) => matches(member, depth + 1)));
  return matches(expected, 0);
}

/** Follow defined types down to the underlying primitive (`IfcLengthMeasure` -> `REAL`). */
function underlying(registry: SchemaRegistry, type: string): string {
  let current = type;
  for (let hops = 0; hops < 8 && registry.types[current]; hops++) current = registry.types[current];
  return current.toUpperCase();
}

export function schemaAttributes(
  registry: SchemaRegistry,
  type: string,
  values: Readonly<Record<string, unknown>>,
  op: string,
): unknown[] {
  const entity = registry.entities[type];
  if (!entity) throw new Error(`${op}: ${type} does not exist in ${registry.name}`);
  const known = new Set((entity.allAttributes ?? []).map((a) => a.name));
  for (const name of Object.keys(values)) {
    if (values[name] !== undefined && !known.has(name)) {
      throw new Error(`${op}: ${type} has no attribute ${name} in ${registry.name}`);
    }
  }
  return (entity.allAttributes ?? []).map((attribute) => {
    const value = values[attribute.name];
    const enumValues = registry.enums[attribute.type];
    if (enumValues) {
      const token = value ?? (attribute.optional || !enumValues.includes('NOTDEFINED') ? null : 'NOTDEFINED');
      if (token === null) {
        if (!attribute.optional) throw new Error(`${op}: ${type}.${attribute.name} is mandatory`);
        return null;
      }
      if (typeof token !== 'string' || !enumValues.includes(token)) {
        throw new Error(`${op}: ${type}.${attribute.name} must be one of ${enumValues.join(', ')}; got ${String(token)}`);
      }
      return `.${token}.`;
    }
    if (value === undefined || value === null) {
      if (!attribute.optional) throw new Error(`${op}: ${type}.${attribute.name} is mandatory`);
      return null;
    }
    const primitive = underlying(registry, attribute.type);
    if (typeof value === 'boolean') {
      if (primitive !== 'BOOLEAN' && primitive !== 'LOGICAL') throw new Error(`${op}: ${type}.${attribute.name} is not a boolean`);
      return value ? '.T.' : '.F.';
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new Error(`${op}: ${type}.${attribute.name} must be finite`);
      return primitive === 'REAL' || primitive === 'NUMBER' ? { real: value } : value;
    }
    return value;
  });
}
