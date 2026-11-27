/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Classification enumerations (`PredefinedType` and friends) for `IfcCreator`.
 *
 * The allowed values come from the target schema's generated registry, so a
 * value IFC4 lacks (`IfcWallTypeEnum.RETAININGWALL`) is refused under IFC4 and
 * accepted under IFC4X3. The registry does not record deprecation, so the
 * enumerators buildingSMART deprecates are listed here, per schema:
 *
 * - `IfcWallTypeEnum`: STANDARD and POLYGONAL ("IFC4 DEPRECATION"), and
 *   ELEMENTEDWALL in IFC4 only ("IFC4.3.2.0 CHANGE This enumeration value is
 *   no longer deprecated").
 * - `IfcSpaceTypeEnum`: INTERNAL and EXTERNAL ("IFC4.3.2.0 DEPRECATION ... Use
 *   Pset_SpaceCommon.IsExternal instead"). IFC4X3 output declares
 *   `IFC4X3_ADD2`, which is 4.3.2.0.
 *
 * A deprecated value is refused when the caller passes it. A deprecated
 * built-in default falls back to NOTDEFINED, so the creator never writes one
 * that nobody asked for.
 */

import { getSchemaRegistryForVersion } from '@ifc-lite/parser';

export type CreatorSchema = 'IFC2X3' | 'IFC4' | 'IFC4X3';

const DEPRECATED_ENUMERATORS: Readonly<Record<string, Partial<Record<CreatorSchema, readonly string[]>>>> = {
  IfcWallTypeEnum: { IFC4: ['STANDARD', 'POLYGONAL', 'ELEMENTEDWALL'], IFC4X3: ['STANDARD', 'POLYGONAL'] },
  IfcSpaceTypeEnum: { IFC4X3: ['INTERNAL', 'EXTERNAL'] },
};

export interface ClassificationRequest {
  /** EXPRESS entity name, e.g. `IfcWall`. */
  entity: string;
  /** The caller's value, without dots. `undefined` means "use the default". */
  value: string | undefined;
  /** Value written when the caller gives none, unless it is deprecated in the target schema. */
  fallback: string;
  /** The `ObjectType` the caller set; USERDEFINED requires one. */
  objectType: string | undefined;
  /** Method name used to prefix errors. */
  op: string;
  /** The enumeration attribute. Default `PredefinedType`. */
  attribute?: string;
}

/**
 * The STEP token (`.SOLIDWALL.`) for an entity's classification attribute in
 * `schema`, or `null` when the entity has no such attribute in that schema and
 * the caller passed no value (the attribute is then simply not written).
 */
export function classificationToken(schema: CreatorSchema, request: ClassificationRequest): string | null {
  const { entity, value, fallback, objectType, op } = request;
  const attribute = request.attribute ?? 'PredefinedType';
  const registry = getSchemaRegistryForVersion(schema);
  const slot = registry.entities[entity]?.allAttributes?.find((a) => a.name === attribute);
  if (!slot) {
    if (value !== undefined) throw new Error(`${op}: ${entity} has no ${attribute} attribute in ${schema}`);
    return null;
  }
  const allowed = registry.enums[slot.type] ?? [];
  const deprecated = DEPRECATED_ENUMERATORS[slot.type]?.[schema] ?? [];
  const current = allowed.filter((v) => !deprecated.includes(v));
  const token = value ?? (deprecated.includes(fallback) ? 'NOTDEFINED' : fallback);
  if (deprecated.includes(token)) {
    throw new Error(`${op}: ${slot.type}.${token} is deprecated in ${schema}; use one of ${current.join(', ')}`);
  }
  if (!allowed.includes(token)) {
    throw new Error(`${op}: ${entity}.${attribute} must be one of ${current.join(', ')} in ${schema}; got ${token}`);
  }
  if (token === 'USERDEFINED' && !objectType?.trim()) {
    throw new Error(`${op}: ${entity}.ObjectType is required when ${attribute} is USERDEFINED`);
  }
  return `.${token}.`;
}

/** Canonical entity names by upper-case name, built once per schema. */
const ENTITY_BY_UPPER = new Map<CreatorSchema, Map<string, string>>();
function entityNamed(schema: CreatorSchema, ifcTypeUpper: string): string | undefined {
  let index = ENTITY_BY_UPPER.get(schema);
  if (!index) {
    index = new Map(Object.keys(getSchemaRegistryForVersion(schema).entities).map((name) => [name.toUpperCase(), name]));
    ENTITY_BY_UPPER.set(schema, index);
  }
  return index.get(ifcTypeUpper);
}

/**
 * Every attribute after `Representation` for a generic product writer
 * (`addElement`, `addAxisElement`), from the target schema's own attribute
 * list, so each product gets its full record (#11577):
 * - `Tag` gets the caller's tag, and a spatial element's `CompositionType` is ELEMENT
 *   (its enum has no NOTDEFINED; `addIfcSpace` writes the same);
 * - the classification slot (`PredefinedType`, else the first other enum slot) gets
 *   the caller's value, checked against its enum, defaulting to NOTDEFINED where the
 *   enum has it and `$` where it is optional;
 * - every other optional slot is `$`, a required enum slot is NOTDEFINED, and any
 *   other required slot throws; a caller value with no classification slot throws.
 *
 * Only what a storey can hold is written: an `IfcElement` or another product
 * is contained, an `IfcSpace` is aggregated (#11498). A non-product (a group
 * such as `IfcZone`, or a context such as `IfcProject`), an abstract entity,
 * another spatial element, a feature element (`IfcOpeningElement`, which voids a
 * host), a type the target schema does not define, and USERDEFINED without an
 * ObjectType all throw. Callers run this before writing any record, so a refusal
 * leaves nothing behind.
 */
export function genericProductTail(
  schema: CreatorSchema, ifcTypeUpper: string, op: string, tag: string, predefinedType: string | undefined, objectType?: string,
): string {
  const entity = entityNamed(schema, ifcTypeUpper);
  if (!entity) throw new Error(`${op}: ${ifcTypeUpper} is not an entity in ${schema}`);
  const registry = getSchemaRegistryForVersion(schema);
  const chain = registry.entities[entity].inheritanceChain ?? [];
  if (!chain.includes('IfcProduct')) throw new Error(`${op}: ${entity} is not a product and cannot be placed in a storey`);
  const spatial = chain.includes('IfcSpatialElement') || chain.includes('IfcSpatialStructureElement');
  if (spatial && entity !== 'IfcSpace') throw new Error(`${op}: ${entity} is a spatial element and cannot be placed in a storey`);
  if (chain.includes('IfcFeatureElement')) {
    throw new Error(`${op}: ${entity} is a feature element; it voids or projects from a host and is never contained in a storey`);
  }
  if (registry.entities[entity].isAbstract) throw new Error(`${op}: ${entity} is abstract in ${schema} and cannot be instantiated`);
  const rest = (registry.entities[entity].allAttributes ?? []).slice(7);
  const composition = (name: string) => spatial && name === 'CompositionType';
  const target = rest.find((a) => a.name === 'PredefinedType') ?? rest.find((a) => registry.enums[a.type] && !composition(a.name));
  if (predefinedType !== undefined && !target) throw new Error(`${op}: ${entity} has no PredefinedType attribute in ${schema}`);
  return rest.map((attr) => {
    if (attr.name === 'Tag') return `,${tag}`;
    if (composition(attr.name)) return ',.ELEMENT.';
    const allowed = registry.enums[attr.type] ?? [];
    if (attr === target && predefinedType !== undefined && !(predefinedType === 'NOTDEFINED' && !allowed.includes('NOTDEFINED'))) {
      if (!allowed.includes(predefinedType)) {
        throw new Error(`${op}: ${entity}.${attr.name} must be one of ${allowed.join(', ')} in ${schema}; got ${predefinedType}`);
      }
      if (predefinedType === 'USERDEFINED' && !objectType?.trim()) {
        throw new Error(`${op}: ${entity}.ObjectType is required when ${attr.name} is USERDEFINED`);
      }
      return `,.${predefinedType}.`;
    }
    if (attr === target && allowed.includes('NOTDEFINED')) return ',.NOTDEFINED.';
    if (attr.optional) return ',$';
    if (allowed.includes('NOTDEFINED')) return ',.NOTDEFINED.';
    throw new Error(`${op}: ${entity}.${attr.name} is required in ${schema} and cannot be written by the generic writer`);
  }).join('');
}
