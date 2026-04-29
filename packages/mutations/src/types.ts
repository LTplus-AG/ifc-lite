/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Types for IFC mutation tracking
 */

import type { PropertyValueType } from '@ifc-lite/data';

/**
 * IFC STEP attribute value, as produced by `EntityExtractor.extractEntity()`.
 *
 * Mirrors the parser's `IfcAttributeValue` to keep `@ifc-lite/mutations` free
 * of a `@ifc-lite/parser` dependency (parser → ifcx → mutations would cycle).
 */
export type IfcAttributeValue =
  | string
  | number
  | boolean
  | null
  | IfcAttributeValue[];

/**
 * Property value types supported by mutations
 */
export type PropertyValue = string | number | boolean | null | PropertyValue[];

/**
 * Types of mutations that can be applied to IFC data
 */
export type MutationType =
  | 'CREATE_PROPERTY'
  | 'UPDATE_PROPERTY'
  | 'DELETE_PROPERTY'
  | 'CREATE_PROPERTY_SET'
  | 'DELETE_PROPERTY_SET'
  | 'CREATE_QUANTITY'
  | 'UPDATE_QUANTITY'
  | 'DELETE_QUANTITY'
  | 'UPDATE_ATTRIBUTE'
  | 'UPDATE_POSITIONAL_ATTRIBUTE'
  | 'CREATE_ENTITY'
  | 'DELETE_ENTITY';

/**
 * A single mutation operation
 */
export interface Mutation {
  /** Unique identifier for this mutation */
  id: string;
  /** Type of mutation */
  type: MutationType;
  /** Timestamp when mutation was created */
  timestamp: number;
  /** Model ID this mutation applies to */
  modelId: string;
  /** Entity EXPRESS ID */
  entityId: number;

  // Property/Quantity specific fields
  /** Property set or quantity set name */
  psetName?: string;
  /** Property or quantity name */
  propName?: string;
  /** Previous value (for undo) */
  oldValue?: PropertyValue;
  /** New value */
  newValue?: PropertyValue;
  /** Value type */
  valueType?: PropertyValueType;
  /** Unit (for quantities) */
  unit?: string;

  // Attribute specific fields
  /** Attribute name (IFC entity attributes like Name, Description, ObjectType, Tag, etc.) */
  attributeName?: string;
}

/**
 * A collection of related mutations
 */
export interface ChangeSet {
  /** Unique identifier */
  id: string;
  /** User-provided name */
  name: string;
  /** Creation timestamp */
  createdAt: number;
  /** Mutations in this change set */
  mutations: Mutation[];
  /** Whether this change set has been applied */
  applied: boolean;
}

/**
 * Property mutation for overlay tracking
 */
export interface PropertyMutation {
  /** Operation type */
  operation: 'SET' | 'DELETE';
  /** New value (for SET operations) */
  value?: PropertyValue;
  /** Value type (for SET operations) */
  valueType?: PropertyValueType;
  /** Unit (optional) */
  unit?: string;
}

/**
 * Quantity mutation for overlay tracking
 */
export interface QuantityMutation {
  /** Operation type */
  operation: 'SET' | 'DELETE';
  /** New value (for SET operations) */
  value?: number;
  /** Quantity type (Length, Area, Volume, etc.) */
  quantityType?: number;
  /** Unit (optional) */
  unit?: string;
}

/**
 * Attribute mutation for overlay tracking
 */
export interface AttributeMutation {
  /** Attribute name (IFC entity attributes like Name, Description, ObjectType, Tag, etc.) */
  attribute: string;
  /** New value */
  value: string;
  /** Previous value (for undo) */
  oldValue?: string;
}

/**
 * In-memory record for an entity created via the overlay.
 *
 * `attributes` is the positional STEP argument list for the entity, in the
 * same shape that `EntityExtractor.extractEntity()` produces. Numbers become
 * STEP integer/REAL literals; strings/booleans/null are emitted literally;
 * nested arrays are emitted as STEP lists. Use a string `"#42"` for entity
 * references, `".AREA."` for enums, `"$"` for explicit unset.
 */
export interface NewEntity {
  expressId: number;
  type: string;
  attributes: IfcAttributeValue[];
}

/**
 * Minimal `EntityRef` shape consumed by `StoreEditor`. Structurally compatible
 * with `@ifc-lite/parser`'s `EntityRef`.
 */
export interface MutationEntityRef {
  expressId: number;
  type: string;
  byteOffset: number;
  byteLength: number;
  lineNumber: number;
}

/**
 * Minimal entity-by-id index shape. Compatible with `Map<number, EntityRef>`
 * and the parser's `CompactEntityIndex`. Only the read methods are required
 * — the overlay never mutates the underlying index.
 */
export interface MutationEntityByIdIndex {
  get(expressId: number): MutationEntityRef | undefined;
  has(expressId: number): boolean;
  readonly size: number;
  keys(): IterableIterator<number>;
}

/**
 * Minimal `IfcDataStore` shape consumed by `StoreEditor`.
 */
export interface MutationStoreShape {
  entityIndex: {
    byId: MutationEntityByIdIndex;
  };
}

/**
 * Generate a unique ID for mutations
 */
export function generateMutationId(): string {
  return `mut_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Generate a unique ID for change sets
 */
export function generateChangeSetId(): string {
  return `cs_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Create a mutation key for property lookup
 */
export function propertyKey(entityId: number, psetName: string, propName: string): string {
  return `${entityId}:${psetName}:${propName}`;
}

/**
 * Create a mutation key for quantity lookup
 */
export function quantityKey(entityId: number, qsetName: string, quantName: string): string {
  return `${entityId}:${qsetName}:${quantName}`;
}

/**
 * Create a mutation key for attribute lookup
 */
export function attributeKey(entityId: number, attributeName: string): string {
  return `${entityId}:attr:${attributeName}`;
}
