/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Public types for the per-IFC-version schema lookup tables.
 *
 * The shape mirrors the data exposed by buildingSMART's IDS-Audit-tool
 * (`ids-lib/IfcSchema/SchemaInfo.*`) — entity hierarchy with predefined
 * types and direct attributes, property sets with applicable entities and
 * per-property data type, partOf relation tables and object→type maps.
 *
 * Generated content lives in `./generated/`; see `scripts/generate-ifc-schema.ts`.
 */

/** All IFC schema versions for which lookup tables can be requested. */
export type IfcSchemaVersion =
  | 'IFC2X3'
  | 'IFC4'
  | 'IFC4X3_ADD2'
  | 'IFC4X3';

/** Description of a single IFC entity. */
export interface IfcEntityInfo {
  /** Canonical PascalCase name, e.g. `IfcWall`. */
  readonly name: string;
  /** Direct EXPRESS parent name, or `undefined` for `IfcRoot`. */
  readonly parent?: string;
  /** True for EXPRESS abstract supertypes (cannot be instantiated directly). */
  readonly abstract: boolean;
  /** Allowed `PredefinedType` enum values, in declaration order. */
  readonly predefinedTypes: readonly string[];
  /**
   * All inherited + direct attributes in declaration order. Concrete IDS
   * checks only need the names; types/optional flags are out of scope for
   * the auditor (and not exposed by the upstream SchemaInfo data).
   */
  readonly attributes: readonly string[];
  /** EXPRESS source schema (e.g., "Ifc4x3.SharedBldgElements"). */
  readonly source?: string;
  /** Companion type entity, e.g., `IfcWall → IfcWallType`. */
  readonly typeEntity?: string;
}

/**
 * Single property inside a pset.
 *
 * The `kind` field captures the upstream property-type taxonomy (see
 * `Pset_Xxx` definitions) so the auditor can apply different rules per
 * shape — e.g., enumerations are matched against `enumeration`, single-
 * value properties against `dataType`.
 */
export interface IfcPropertyInfo {
  readonly name: string;
  readonly kind:
    | 'single'
    | 'enumeration'
    | 'list'
    | 'bounded'
    | 'reference'
    | 'unknown';
  /** Datatype token (e.g. "IfcLabel"). Set for non-enumeration kinds. */
  readonly dataType?: string;
  /** Allowed enumeration values when `kind === 'enumeration'`. */
  readonly enumeration?: readonly string[];
}

/** Description of a property set (Pset_*) or quantity set (Qto_*). */
export interface IfcPropertySetInfo {
  readonly name: string;
  /** Entities the pset is applicable to, as PascalCase names. */
  readonly applicableEntities: readonly string[];
  readonly properties: readonly IfcPropertyInfo[];
}

/**
 * One row of a per-version partOf relation table — `relation` is the
 * IfcRel* name, `owner` is the upstream container entity, `member` is
 * the contained entity.
 */
export interface PartOfRelationInfo {
  readonly relation: string;
  readonly owner: string;
  readonly member: string;
}

/**
 * IFC dataType (e.g. `IFCLABEL`, `IFCREAL`) and its backing XSD type
 * token. Used by the audit module to verify that a property's
 * `dataType` attribute matches what the standard pset declares, and
 * that an `xs:restriction base="..."` is compatible with that backing
 * type.
 */
export interface IfcDataTypeInfo {
  /** Uppercase IFC dataType name, e.g. `IFCLABEL`. */
  readonly name: string;
  /** IFC versions in which this data type exists. */
  readonly versions: readonly IfcSchemaVersion[];
  /** Backing XSD type, e.g. `xs:string`, `xs:double`, `xs:boolean`. */
  readonly backingType: string;
}

/**
 * IFC attribute metadata. Tracks which entities hold the attribute and
 * whether the attribute admits a simple `<value>` constraint or is a
 * complex (entity-typed) reference.
 */
export interface IfcAttributeInfo {
  /** Attribute name as defined on EXPRESS entities (PascalCase). */
  readonly name: string;
  /** Uppercase entity names where the attribute admits a simple value. */
  readonly simpleValueEntities: readonly string[];
  /** Uppercase entity names where the attribute holds a complex/entity reference. */
  readonly complexEntities: readonly string[];
  /**
   * Map of uppercase entity name → the XSD primitive types that the
   * attribute's slot accepts for that entity. Per IDS 1.0 spec, an
   * `<attribute><value>` literal MUST cast successfully under at least
   * one of these XSD types: `xs:integer` rejects `42.0`, `xs:double`
   * accepts either, `xs:string` accepts anything textual, etc.
   *
   * Sourced from the upstream `SchemaInfo.Attributes.g.cs` 4th argument
   * (a union across the entity group declared in the same call). When
   * an entity isn't a key here the type information is unknown and the
   * validator falls back to permissive comparison.
   */
  readonly xsdTypesByEntity: Readonly<Record<string, readonly string[]>>;
}
