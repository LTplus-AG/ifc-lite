/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Types for IFC mutation tracking
 */

import type { PropertyValueType, IfcAttributeValue as CanonicalIfcAttributeValue } from '@ifc-lite/data';

/**
 * IFC STEP attribute value, as produced by `EntityExtractor.extractEntity()`.
 *
 * Mirrors the parser's `IfcAttributeValue` to keep `@ifc-lite/mutations` free
 * of a `@ifc-lite/parser` dependency (parser → ifcx → mutations would cycle).
 *
 * The extra `{ real: number }` and `{ typed: { type, value } }` variants are
 * WRITE-ONLY markers (never produced by extraction). `{ real }` forces STEP
 * REAL serialization with a decimal point for whole numbers (`5.` not `5`).
 * `{ typed }` forces a type-qualified value `IFC<TYPE>(<value>)` for a SELECT
 * member that is a defined type (`IFCBOOLEAN(.T.)`) or the `IfcValue` family;
 * it generalizes `{ real }`. See `@ifc-lite/data`'s `IfcAttributeValue` for the
 * full contract (kept in sync here to avoid a package cycle).
 */
export type IfcAttributeValue =
  | string
  | number
  | boolean
  | null
  | { real: number }
  | { typed: { type: string; value: string | number | boolean } }
  | IfcAttributeValue[];

/**
 * Compile-time drift guard (no runtime footprint): this mirror MUST stay
 * structurally identical to the canonical `@ifc-lite/data` `IfcAttributeValue`
 * — the two are hand-duplicated only to keep the documented parser-cycle
 * boundary. If they diverge, `MutuallyAssignable` resolves to `false`, which
 * violates `AssertTrue`'s `extends true` constraint and fails the build.
 */
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type AssertTrue<T extends true> = T;
type _IfcAttributeValueMirrorInSync = AssertTrue<
  MutuallyAssignable<IfcAttributeValue, CanonicalIfcAttributeValue>
>;

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
  | 'UPDATE_ENTITY_TYPE'
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
  /** Quantity type (Length, Area, Volume, etc.) — for CREATE/UPDATE_QUANTITY */
  quantityType?: number;
  /** Unit (for quantities) */
  unit?: string;

  // Attribute specific fields
  /** Attribute name (IFC entity attributes like Name, Description, ObjectType, Tag, etc.) */
  attributeName?: string;

  // Entity-type (retype) specific fields
  /** New IFC class keyword for UPDATE_ENTITY_TYPE (canonical PascalCase, e.g. "IfcColumn"). */
  entityType?: string;
  /**
   * Optional PredefinedType to set on the retyped entity. Validated against the
   * target class's enum domain at export; an unknown value falls back to
   * USERDEFINED + ObjectType (mirrors IfcOpenShell's reassign_class).
   */
  predefinedType?: string | null;
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
 * Entity-type (retype) mutation for overlay tracking.
 *
 * Records an intent to change an entity's IFC class in place, materialized by
 * the STEP exporter. The entity keeps its expressId, so geometry / placement /
 * representation and every `IfcRel*` reference (all keyed by `#id`) carry over
 * unchanged. Attribute values are re-laid-out by NAME against the target
 * class's declared attribute list at export.
 */
export interface EntityTypeMutation {
  /** Target IFC class (canonical PascalCase, e.g. "IfcColumn"). */
  newType: string;
  /** Source IFC class at the time of the edit (for undo / display). */
  oldType?: string;
  /** Optional PredefinedType to apply to the target class. */
  predefinedType?: string | null;
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
 * Kind of an {@link EffectiveChange} — mirrors the overlay sources
 * `MutablePropertyView.getEffectiveChanges()` reads.
 */
export type EffectiveChangeKind =
  | 'attribute'
  | 'property'
  | 'quantity'
  | 'pset-added'
  | 'pset-deleted'
  | 'qset-added'
  | 'qset-deleted'
  | 'type'
  | 'entity-added'
  | 'entity-deleted';

/**
 * One change as the overlay CURRENTLY stands, for `getEffectiveChanges()`.
 *
 * Unlike a {@link Mutation} from `mutationHistory` (append-only — undo does
 * not pop it, see `MutablePropertyView.getMutations()`), this is derived
 * fresh from the live overlay maps every call, so it always agrees with
 * `hasPendingChanges()` / `getModifiedEntityCount()` — including after an
 * undo→redo cycle.
 */
export interface EffectiveChange {
  /** Entity EXPRESS ID the change applies to. */
  entityId: number;
  /** What kind of overlay entry this is. */
  kind: EffectiveChangeKind;
  /** Pset/Qset name, for 'property' | 'quantity' | 'pset-added' | 'pset-deleted' | 'qset-added' | 'qset-deleted'. */
  setName?: string;
  /** Attribute / property / quantity name, where applicable. */
  name?: string;
  /**
   * Previous value, stringified. Derived from the base data (property table /
   * on-demand extractor / attribute extractor) — NEVER from `mutationHistory`
   * — so it stays correct across undo→redo. Absent when the base value can't
   * be resolved (e.g. no extractor registered, or the property/attribute did
   * not exist before this session).
   */
  previousValue?: string;
  /**
   * New value, stringified. Absent both for a DELETE-operation
   * property/quantity AND for a SET whose stored value is `null` (`null` is
   * a legitimate, present-but-empty value — e.g. an unset Boolean added from
   * bSDD, issue #1107 — not an absence). `deleted` below is the only
   * reliable signal for telling those two apart; do not infer "deleted" from
   * `newValue === undefined` alone.
   */
  newValue?: string;
  /**
   * `true` only for a `kind: 'property' | 'quantity'` row backed by a DELETE
   * mutation (the property/quantity is actually removed on export).
   * Undefined/`false` for every other row, including a SET whose value
   * happens to stringify to `undefined` (a `null` value) — that row still
   * carries a value, just an empty one, and must not render as deleted.
   */
  deleted?: boolean;
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
  /**
   * Secondary index of property atoms the parser deferred out of `byId` on
   * huge files (`deferPropertyAtomIndex`). These still occupy express ids in
   * the source, so the overlay id allocator must clear them too — otherwise a
   * deferred atom sitting above `max(byId)` gets its id reused for a new
   * overlay entity, producing a duplicate `#ID=` definition once the exporter
   * emits both. See @ifc-lite/export `getCompleteEntityIndex`.
   */
  deferredEntityIndex?: MutationEntityByIdIndex;
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
