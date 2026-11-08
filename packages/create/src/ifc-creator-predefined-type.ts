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
