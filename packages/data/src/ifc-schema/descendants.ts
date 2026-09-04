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
 * Resolved against the UNION of the three bundled schema tables, not against
 * one version at a time. `entityIndex.byType` is keyed by the names the FILE
 * contains, and those names do not have to belong to the version its
 * `FILE_SCHEMA` header claims: converters, authoring tools and hand-edits all
 * emit IFC4X3-headered files still carrying `IFCSLABSTANDARDCASE`, and
 * IFC2X3-headered files carrying `IFCFURNITURE`. A per-version closure made
 * the header — not the content — decide what a query found, so the same bytes
 * answered 3 under `IFC4` and 1 under `IFC4X3`. A name the file does not
 * contain matches an empty bucket, so widening to the union costs a caller
 * nothing: it can only find records that are really there.
 *
 * Cross-version renames and the leaves no bundled table states are folded in
 * from `./entity-aliases.js`; see that module for why the two tables there
 * are read in opposite directions.
 */

import { ENTITY_NAME_ALIASES, CROSS_SCHEMA_RENAMES } from './entity-aliases.js';
import { ENTITIES_IFC2X3 } from './generated/entities-ifc2x3.js';
import { ENTITIES_IFC4 } from './generated/entities-ifc4.js';
import { ENTITIES_IFC4X3 } from './generated/entities-ifc4x3.js';

/** parent (UPPERCASE) → direct children names (UPPERCASE), across all bundled schemas. */
type ChildrenMap = ReadonlyMap<string, readonly string[]>;

// Built once, on first use: three full entity tables plus two alias tables is
// more work than a `byType()` call should repeat, and the tables are static.
let childrenMap: ChildrenMap | undefined;

function addChild(map: Map<string, string[]>, parent: string, child: string): void {
  let children = map.get(parent);
  if (!children) {
    children = [];
    map.set(parent, children);
  }
  if (!children.includes(child)) children.push(child);
}

function buildChildrenMap(): ChildrenMap {
  if (childrenMap) return childrenMap;

  const map = new Map<string, string[]>();
  for (const list of [ENTITIES_IFC2X3, ENTITIES_IFC4, ENTITIES_IFC4X3]) {
    for (const entity of list) {
      if (!entity.parent) continue;
      addChild(map, entity.parent.toUpperCase(), entity.name.toUpperCase());
    }
  }
  // A leaf no bundled table states hangs off its nearest schema-known
  // supertype. One direction only: `IfcGeotechnicalStratum` gains
  // `IfcSolidStratum`, but `IfcSolidStratum` must not gain `IfcWaterStratum`.
  for (const [leaf, supertype] of Object.entries(ENTITY_NAME_ALIASES)) {
    addChild(map, supertype.toUpperCase(), leaf.toUpperCase());
  }
  // A rename is an equality, so each spelling adopts the other's children —
  // not the other name itself, which is the same class rather than a subtype
  // and would show up as a phantom row in a debug dump of the expansion.
  for (const [older, newer] of CROSS_SCHEMA_RENAMES) {
    for (const child of map.get(newer) ?? []) addChild(map, older, child);
    for (const child of map.get(older) ?? []) addChild(map, newer, child);
  }

  childrenMap = map;
  return map;
}

/**
 * One type's full descendant set (itself + every type with it as an ancestor),
 * UPPERCASE and deduplicated.
 *
 * Order: the requested type first, then its descendants. Callers page results
 * with `offset`/`limit` over the rows this produces, so a traversal-dependent
 * order would shift a caller's page whenever the schema tables were
 * regenerated. Depth-first pop order did exactly that; sorted does not.
 */
function descendantsOf(type: string): string[] {
  const upper = type.toUpperCase();
  const map = buildChildrenMap();
  const found = new Set<string>();
  const stack: string[] = [upper];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    for (const child of map.get(current) ?? []) {
      if (found.has(child) || child === upper) continue;
      found.add(child);
      stack.push(child);
    }
  }
  return [upper, ...[...found].sort()];
}

/**
 * Expand a caller's type list to include every descendant of each type
 * (itself plus every type that has it as an ancestor, direct or indirect),
 * across the union of the bundled schemas. Case-insensitive input; UPPERCASE
 * output, deduplicated across the whole list, each requested type immediately
 * ahead of its own sorted descendants.
 *
 * A type unknown to every bundled table (a typo, a vendor extension) comes
 * back as itself, so the caller's list keeps its shape rather than silently
 * losing an entry.
 *
 * Takes no schema version by design — see the module doc. The queried model's
 * header narrowing this would mean the same bytes answering differently.
 */
export function expandTypeNamesToDescendants(types: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const type of types) {
    for (const name of descendantsOf(type)) {
      if (seen.has(name)) continue;
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}
