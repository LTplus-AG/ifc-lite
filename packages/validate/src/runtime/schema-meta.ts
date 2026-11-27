/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** The schema tables `@ifc-lite/codegen` emits for the validator runtime. */

import type { EntityInstance } from './instance.js';
import type { Model } from './model.js';
import type { Value } from './values.js';

export type SimpleTypeName = 'REAL' | 'INTEGER' | 'NUMBER' | 'BOOLEAN' | 'LOGICAL' | 'STRING' | 'BINARY';

export type TypeRef =
  | { k: 'simple'; name: SimpleTypeName; width?: number; fixed?: boolean }
  | { k: 'named'; name: string }
  | { k: 'aggregate'; kind: 'LIST' | 'SET' | 'BAG' | 'ARRAY'; low?: number; high?: number; unique: boolean; optional: boolean; of: TypeRef }
  | { k: 'generic' };

export interface AttributeMeta {
  name: string;
  type: TypeRef;
  optional: boolean;
}

export interface InverseMeta {
  name: string;
  entity: string;
  forAttribute: string;
  aggregate?: 'SET' | 'BAG';
  low: number;
  high?: number;
}

export interface UniqueMeta {
  label: string;
  attributes: string[];
}

export interface EntityMeta {
  name: string;
  abstract: boolean;
  supertype?: string;
  supertypes?: string[];
  /** Explicit attributes this entity introduces, in STEP order. */
  attributes: AttributeMeta[];
  /** Inherited explicit attributes this entity redeclares with a narrower type. */
  retyped?: Record<string, AttributeMeta>;
  /** Inherited explicit attributes this entity redeclares as DERIVE (STEP `*`). */
  derivedRedeclarations?: string[];
  /** DERIVE attributes this entity introduces (not redeclarations). */
  derived?: string[];
  inverse?: InverseMeta[];
  unique?: UniqueMeta[];
}

export type TypeMeta =
  | { kind: 'defined'; name: string; underlying: TypeRef }
  | { kind: 'enum'; name: string; items: string[] }
  | { kind: 'select'; name: string; items: string[] };

export interface SchemaMeta {
  name: string;
  /** Schema qualifier of TYPEOF results, as the rules spell it. */
  typePrefix?: string;
  entities: EntityMeta[];
  types: TypeMeta[];
}

export type EntityRuleFn = (self: EntityInstance, m: Model) => Value;
export type TypeRuleFn = (self: Value, m: Model) => Value;
export type DerivedFn = (self: EntityInstance, m: Model) => Value;
export type GlobalRuleFn = (m: Model) => Array<[label: string, result: Value]>;

export interface CompiledRule<F> {
  label: string;
  source: string;
  check: F;
}

export interface UnsupportedRule {
  scope: 'entity' | 'type' | 'derived' | 'global' | 'function' | 'schema';
  owner: string;
  label: string;
  reason: string;
}

export interface CompiledRules {
  entity: Record<string, CompiledRule<EntityRuleFn>[]>;
  type: Record<string, CompiledRule<TypeRuleFn>[]>;
  derived: Record<string, DerivedFn>;
  global: { name: string; appliesTo: string[]; rules: { label: string; source: string }[]; run: GlobalRuleFn }[];
  unsupported: UnsupportedRule[];
}
