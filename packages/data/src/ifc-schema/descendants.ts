/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Descendant-closure resolution for entity-type queries.
 *
 * `getInheritanceChain`/`isEntitySubtypeOf` in `./index.ts` walk the EXPRESS
 * hierarchy leaf → root (a type plus its ancestors). Every `BimBackend`'s
 * `byType()` query needs the opposite direction: given a type name, every
 * type that HAS it as an ancestor, so that asking for an abstract supertype
 * (`IfcBuildingElement`, `IfcElement`) — never a literal STEP entity type —
 * finds the concrete leaves a real file actually contains, instead of
 * silently answering zero.
 *
 * Deliberately per-schema-version, not a union across all three bundled
 * schemas: a descendant query has to respect schema boundaries the same way
 * the model itself does. `IfcWallStandardCase` exists in IFC4's entity list;
 * IFC4X3 renamed `IfcBuildingElement` to `IfcBuiltElement`. Resolving against
 * the union would let an IFC2X3 model's `byType('IfcBuiltElement')` match an
 * IFC4X3-only name it could never contain, or vice versa.
 */

import { ENTITIES_IFC2X3 } from './generated/entities-ifc2x3.js';
import { ENTITIES_IFC4 } from './generated/entities-ifc4.js';
import { ENTITIES_IFC4X3 } from './generated/entities-ifc4x3.js';
import type { IfcEntityInfo, IfcSchemaVersion } from './types.js';

const ENTITY_LISTS_BY_VERSION: Record<IfcSchemaVersion, readonly IfcEntityInfo[]> = {
  IFC2X3: ENTITIES_IFC2X3,
  IFC4: ENTITIES_IFC4,
  IFC4X3: ENTITIES_IFC4X3,
  // IFC4X3_ADD2 is the addendum-2 release of IFC4X3 — same entity list.
  IFC4X3_ADD2: ENTITIES_IFC4X3,
};

/** parent (UPPERCASE) → direct children names (UPPERCASE), for one schema version. */
type ChildrenMap = Map<string, string[]>;

// Cached per schema version so a query loop (every `byType()` call, across
// every entity fetched) doesn't rebuild the parent→children map each time.
const childrenMapCache = new Map<IfcSchemaVersion, ChildrenMap>();

function buildChildrenMap(v: IfcSchemaVersion): ChildrenMap {
  const cached = childrenMapCache.get(v);
  if (cached) return cached;

  const list = ENTITY_LISTS_BY_VERSION[v];
  const map: ChildrenMap = new Map();
  for (const entity of list) {
    if (!entity.parent) continue;
    const parentUpper = entity.parent.toUpperCase();
    let children = map.get(parentUpper);
    if (!children) {
      children = [];
      map.set(parentUpper, children);
    }
    children.push(entity.name.toUpperCase());
  }
  childrenMapCache.set(v, map);
  return map;
}

// Every entity name (UPPERCASE) known to a schema version, so an unknown
// type can fall back to itself instead of silently vanishing.
const knownNamesCache = new Map<IfcSchemaVersion, Set<string>>();

function knownNames(v: IfcSchemaVersion): Set<string> {
  const cached = knownNamesCache.get(v);
  if (cached) return cached;
  const set = new Set<string>();
  for (const entity of ENTITY_LISTS_BY_VERSION[v]) set.add(entity.name.toUpperCase());
  knownNamesCache.set(v, set);
  return set;
}

/**
 * Resolve a raw schema-version string (e.g. a store's `schemaVersion`
 * field, which may carry values like `'IFC5'` that this table doesn't
 * cover) to one of the versions the bundled entity tables support.
 * Unrecognized/undefined input falls back to IFC4 — the version the old
 * hand-written `IFC_SUBTYPES` table implicitly assumed.
 */
function resolveSchemaVersion(schemaVersion: string | undefined): IfcSchemaVersion {
  const upper = schemaVersion?.toUpperCase();
  if (upper === 'IFC2X3' || upper === 'IFC4' || upper === 'IFC4X3' || upper === 'IFC4X3_ADD2') {
    return upper;
  }
  return 'IFC4';
}

/** One type's full descendant set (itself + every type with it as an ancestor), UPPERCASE, deduplicated. */
function descendantsOf(type: string, v: IfcSchemaVersion): string[] {
  const upper = type.toUpperCase();
  const childrenMap = buildChildrenMap(v);
  const result: string[] = [upper];
  const seen = new Set<string>([upper]);
  const stack: string[] = [upper];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    const children = childrenMap.get(current);
    if (!children) continue;
    for (const child of children) {
      if (seen.has(child)) continue;
      seen.add(child);
      result.push(child);
      stack.push(child);
    }
  }
  // Graceful fallback: an unknown type (typo, vendor extension, or a name
  // outside this schema version) still returns itself rather than being
  // silently dropped from the caller's type list.
  if (result.length === 1 && !knownNames(v).has(upper)) return [upper];
  return result;
}

/**
 * Expand a caller's type list to include every descendant of each type
 * (itself plus every type that has it as an ancestor, direct or indirect)
 * within ONE IFC schema version. Case-insensitive input; UPPERCASE output,
 * deduplicated across the whole list.
 *
 * `schemaVersion` should be the MODEL'S OWN schema version (a store's
 * `schemaVersion` field), not a hardcoded default — descendant sets differ
 * across schema versions (see module doc). Unrecognized/undefined values
 * fall back to IFC4.
 */
export function expandTypeNamesToDescendants(
  types: readonly string[],
  schemaVersion: IfcSchemaVersion | string | undefined,
): string[] {
  const v = resolveSchemaVersion(schemaVersion);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const type of types) {
    for (const name of descendantsOf(type, v)) {
      if (seen.has(name)) continue;
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}
