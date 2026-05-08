/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Per-IFC-version schema lookup.
 *
 * Backed by the generated tables in `./generated/`, which the generator
 * (`scripts/generate-ifc-schema.ts`) builds from buildingSMART/IDS-Audit-tool's
 * `SchemaInfo.*.g.cs` data. The async signatures pin the API so future
 * implementations can lazy-load multi-MB JSON dumps without touching
 * consumers.
 *
 * Browser-runnable: no `fs`, no `path`, no Node-only APIs.
 */

import { ENTITIES_IFC2X3 } from './generated/entities-ifc2x3.js';
import { ENTITIES_IFC4 } from './generated/entities-ifc4.js';
import { ENTITIES_IFC4X3 } from './generated/entities-ifc4x3.js';
import {
  PART_OF_RELATIONS_IFC2X3,
  PART_OF_RELATIONS_IFC4,
  PART_OF_RELATIONS_IFC4X3,
} from './generated/partof-relations.js';
import { PROPERTY_SETS_IFC2X3 } from './generated/psets-ifc2x3.js';
import { PROPERTY_SETS_IFC4 } from './generated/psets-ifc4.js';
import { PROPERTY_SETS_IFC4X3 } from './generated/psets-ifc4x3.js';
import type {
  IfcEntityInfo,
  IfcPropertySetInfo,
  IfcSchemaVersion,
  PartOfRelationInfo,
} from './types.js';

export type {
  IfcEntityInfo,
  IfcPropertyInfo,
  IfcPropertySetInfo,
  IfcSchemaVersion,
  PartOfRelationInfo,
} from './types.js';

/**
 * `Pset_*` and `Qto_*` are reserved for buildingSMART-published property
 * sets (see `IdsProperty.cs` in IDS-Audit-tool). User-defined sets must
 * not use these prefixes; the auditor surfaces a warning when an
 * unknown name does.
 */
export const RESERVED_PSET_PREFIXES: readonly string[] = ['Pset_', 'Qto_'];

const ENTITIES_BY_VERSION: Record<IfcSchemaVersion, readonly IfcEntityInfo[]> = {
  IFC2X3: ENTITIES_IFC2X3,
  IFC4: ENTITIES_IFC4,
  IFC4X3: ENTITIES_IFC4X3,
  // IFC4X3_ADD2 is the addendum-2 release of IFC4X3 — same entity list
  // for authoring purposes.
  IFC4X3_ADD2: ENTITIES_IFC4X3,
};

const PROPERTY_SETS_BY_VERSION: Record<
  IfcSchemaVersion,
  readonly IfcPropertySetInfo[]
> = {
  IFC2X3: PROPERTY_SETS_IFC2X3,
  IFC4: PROPERTY_SETS_IFC4,
  IFC4X3: PROPERTY_SETS_IFC4X3,
  IFC4X3_ADD2: PROPERTY_SETS_IFC4X3,
};

const PART_OF_BY_VERSION: Record<
  IfcSchemaVersion,
  readonly PartOfRelationInfo[]
> = {
  IFC2X3: PART_OF_RELATIONS_IFC2X3,
  IFC4: PART_OF_RELATIONS_IFC4,
  IFC4X3: PART_OF_RELATIONS_IFC4X3,
  IFC4X3_ADD2: PART_OF_RELATIONS_IFC4X3,
};

function ensureVersion(v: IfcSchemaVersion): void {
  if (!(v in ENTITIES_BY_VERSION)) {
    throw new Error(`Unsupported IFC schema version: ${v}`);
  }
}

/**
 * Async by contract — even though tables are bundled today, future
 * implementations may dynamically import multi-MB JSON files. Pin the
 * API now so consumers don't need a breaking change later.
 */
export async function getEntities(
  v: IfcSchemaVersion
): Promise<readonly IfcEntityInfo[]> {
  ensureVersion(v);
  return ENTITIES_BY_VERSION[v];
}

export async function getPropertySets(
  v: IfcSchemaVersion
): Promise<readonly IfcPropertySetInfo[]> {
  ensureVersion(v);
  return PROPERTY_SETS_BY_VERSION[v];
}

export async function getPartOfRelations(
  v: IfcSchemaVersion
): Promise<readonly PartOfRelationInfo[]> {
  ensureVersion(v);
  return PART_OF_BY_VERSION[v];
}

/**
 * Case-insensitive entity lookup. Returns `undefined` when the entity
 * isn't part of the schema for the requested IFC version.
 */
export async function findEntity(
  v: IfcSchemaVersion,
  name: string
): Promise<IfcEntityInfo | undefined> {
  const upper = name.toUpperCase();
  const list = await getEntities(v);
  return list.find((e) => e.name.toUpperCase() === upper);
}

export async function findPropertySet(
  v: IfcSchemaVersion,
  name: string
): Promise<IfcPropertySetInfo | undefined> {
  const list = await getPropertySets(v);
  return list.find((p) => p.name === name);
}

/**
 * Walk the EXPRESS inheritance chain. Returns the named entity plus
 * every supertype, with `IfcRoot` last. `[]` when the entity isn't in
 * the schema.
 */
export async function getInheritanceChain(
  v: IfcSchemaVersion,
  name: string
): Promise<readonly IfcEntityInfo[]> {
  const list = await getEntities(v);
  const byName = new Map<string, IfcEntityInfo>();
  for (const e of list) byName.set(e.name.toUpperCase(), e);
  const chain: IfcEntityInfo[] = [];
  let cursor: IfcEntityInfo | undefined = byName.get(name.toUpperCase());
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor.name)) {
    chain.push(cursor);
    seen.add(cursor.name);
    cursor = cursor.parent ? byName.get(cursor.parent.toUpperCase()) : undefined;
  }
  return chain;
}

/**
 * Test whether `entity` (or any supertype in its inheritance chain)
 * matches `target`. The check is case-insensitive on names.
 */
export async function isEntitySubtypeOf(
  v: IfcSchemaVersion,
  entity: string,
  target: string
): Promise<boolean> {
  const chain = await getInheritanceChain(v, entity);
  const upper = target.toUpperCase();
  return chain.some((e) => e.name.toUpperCase() === upper);
}
