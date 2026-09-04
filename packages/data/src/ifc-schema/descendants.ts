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
 * Neither one schema table alone nor a plain union across the three is the
 * right authority, and the two failure modes are opposite:
 *
 *   - One table alone NARROWS. `entityIndex.byType` is keyed by the names the
 *     FILE contains, and those need not belong to the version its
 *     `FILE_SCHEMA` header claims: converters and hand-edits produce
 *     IFC4X3-headered files still carrying `IFCSLABSTANDARDCASE`, a name only
 *     the IFC4 table declares. Resolving per header made the header, not the
 *     content, decide what a query found.
 *   - A plain union MISFILES. buildingSMART re-parented entities between
 *     versions, so a name can sit under a different base in a schema the file
 *     is not written in: `IfcReinforcingBar` is an `IfcBuildingElement` in
 *     IFC2X3 and an `IfcElementComponent` in IFC4, `IfcProject` is an
 *     `IfcObject` in IFC2X3 and an `IfcContext` from IFC4 on, `IfcZone` is an
 *     `IfcSystem` in IFC4 and an `IfcGroup` in IFC2X3. Unioning made
 *     `byType('IfcBuildingElement')` on an IFC4 file answer with reinforcing
 *     bars — 45 such (supertype, schema) pairs.
 *
 * So the closure for a file is:
 *
 *   (a) the descendants of the requested type in the file's OWN schema table;
 *   (b) plus names from the other tables that the file's schema does not
 *       define AT ALL and that are descendants of the requested type in the
 *       table that does define them — the legacy and newer leaf spellings
 *       (`IFCSLABSTANDARDCASE` on an IFC4X3 file, `IFCFURNITURE` on an IFC2X3
 *       one). A name the file's own schema defines under a different parent is
 *       never added, which is what keeps (b) from re-opening the union's
 *       misfiling;
 *   (c) plus the two alias relations in `./entity-aliases.js`: the
 *       cross-schema rename equality, and the narrowing for leaves no bundled
 *       table declares.
 */

import { ENTITY_NAME_ALIASES, CROSS_SCHEMA_RENAMES } from './entity-aliases.js';
import { ENTITIES_IFC2X3 } from './generated/entities-ifc2x3.js';
import { ENTITIES_IFC4 } from './generated/entities-ifc4.js';
import { ENTITIES_IFC4X3 } from './generated/entities-ifc4x3.js';
import type { IfcEntityInfo, IfcSchemaVersion } from './types.js';

const ENTITY_LISTS: Record<IfcSchemaVersion, readonly IfcEntityInfo[]> = {
  IFC2X3: ENTITIES_IFC2X3,
  IFC4: ENTITIES_IFC4,
  IFC4X3: ENTITIES_IFC4X3,
  // IFC4X3_ADD2 is the addendum-2 release of IFC4X3 — same entity list.
  IFC4X3_ADD2: ENTITIES_IFC4X3,
};

const ALL_VERSIONS: readonly IfcSchemaVersion[] = ['IFC2X3', 'IFC4', 'IFC4X3'];

/** One schema table indexed both ways a closure needs it. */
interface SchemaTable {
  /** parent (UPPERCASE) → direct children (UPPERCASE). */
  readonly children: ReadonlyMap<string, readonly string[]>;
  /** every name this schema declares (UPPERCASE). */
  readonly names: ReadonlySet<string>;
}

const tableCache = new Map<IfcSchemaVersion, SchemaTable>();

function tableFor(v: IfcSchemaVersion): SchemaTable {
  const cached = tableCache.get(v);
  if (cached) return cached;
  const children = new Map<string, string[]>();
  const names = new Set<string>();
  for (const entity of ENTITY_LISTS[v]) {
    names.add(entity.name.toUpperCase());
    if (!entity.parent) continue;
    const parent = entity.parent.toUpperCase();
    const bucket = children.get(parent);
    if (bucket) bucket.push(entity.name.toUpperCase());
    else children.set(parent, [entity.name.toUpperCase()]);
  }
  const table: SchemaTable = { children, names };
  tableCache.set(v, table);
  return table;
}

/**
 * Narrow a raw schema-version string (a store's `schemaVersion`, which
 * carries values like `'IFC5'` these tables do not cover) to a version with a
 * bundled table.
 *
 * Deliberately the same mapping as `narrowSchemaVersion` in
 * `packages/ids/src/bridge/schema-version.ts` — IFC5 has no published EXPRESS
 * schema, and IFC4X3 is its nearest — pinned from that side in
 * `schema-version.test.ts`, since `@ifc-lite/ids` depends on this package and
 * not the other way round. Two resolvers that disagreed about IFC5 is what
 * this replaces.
 */
function resolveSchemaVersion(schemaVersion: string | undefined): IfcSchemaVersion {
  switch (schemaVersion?.toUpperCase()) {
    case 'IFC2X3':
      return 'IFC2X3';
    case 'IFC4X3':
    case 'IFC4X3_ADD2':
    case 'IFC5':
      return 'IFC4X3';
    default:
      return 'IFC4';
  }
}

/**
 * The names a query for `type` also means, before any schema is consulted:
 * the type itself plus the other spelling of a cross-schema rename.
 *
 * The rename is an equality, not a subtype relation, so both spellings are
 * kept in the answer: a file written under either schema may hold records
 * under either name, and a name the file does not contain matches an empty
 * bucket.
 */
function renameGroup(upper: string): string[] {
  const group = [upper];
  for (const pair of CROSS_SCHEMA_RENAMES) {
    if (!pair.includes(upper)) continue;
    for (const name of pair) if (!group.includes(name)) group.push(name);
  }
  return group;
}

/** Transitive descendants of `seeds` within one schema table, seeds excluded. */
function descendantsInTable(table: SchemaTable, seeds: readonly string[]): Set<string> {
  const found = new Set<string>();
  const stack = [...seeds];
  const visited = new Set<string>(seeds);
  while (stack.length > 0) {
    for (const child of table.children.get(stack.pop() as string) ?? []) {
      if (visited.has(child)) continue;
      visited.add(child);
      found.add(child);
      stack.push(child);
    }
  }
  return found;
}

/**
 * One type's descendant set for a file written in `v`: itself, plus every
 * type the rule in the module doc admits, UPPERCASE and deduplicated.
 *
 * Order: the requested type first, then the rest sorted. Callers page results
 * with `offset`/`limit`, so a traversal-dependent order would shift a caller's
 * page whenever the schema tables were regenerated. Depth-first pop order did
 * exactly that; sorted does not.
 */
function descendantsOf(type: string, v: IfcSchemaVersion): string[] {
  const upper = type.toUpperCase();
  const seeds = renameGroup(upper);
  const own = tableFor(v);

  const found = new Set<string>(seeds.slice(1));
  for (const name of descendantsInTable(own, seeds)) found.add(name);

  // (b) A leaf spelling this schema has no opinion about at all. Guarded on
  // `own.names`, so a name this schema DOES declare — under whatever parent —
  // is never pulled in from a version the file is not written in.
  for (const other of ALL_VERSIONS) {
    const table = tableFor(other);
    if (table === own) continue;
    for (const name of descendantsInTable(table, seeds)) {
      if (!own.names.has(name)) found.add(name);
    }
  }

  // (c) The narrowing: a leaf no bundled table declares hangs off its nearest
  // schema-known supertype. One direction only, so `IfcGeotechnicalStratum`
  // gains `IfcSolidStratum` while `IfcSolidStratum` does not gain its siblings.
  for (const [leaf, supertype] of Object.entries(ENTITY_NAME_ALIASES)) {
    const parent = supertype.toUpperCase();
    if (parent === upper || found.has(parent)) found.add(leaf.toUpperCase());
  }

  found.delete(upper);
  return [upper, ...[...found].sort()];
}

/**
 * Expand a caller's type list to every descendant each type has for a file
 * written in `schemaVersion` — see the module doc for what that admits.
 * Case-insensitive input; UPPERCASE output, deduplicated across the whole
 * list, each requested type immediately ahead of its own sorted descendants.
 *
 * `schemaVersion` is required and should be the queried model's own
 * `store.schemaVersion`. It is what keeps a re-parented entity out of the
 * answer, so there is no sensible default: an omitted version would silently
 * mean "IFC4", and on an IFC2X3 model that answer is wrong rather than
 * approximate. Values with no bundled table fall back as documented on
 * `resolveSchemaVersion`.
 *
 * A type unknown to every bundled table (a typo, a vendor extension) comes
 * back as itself, so the caller's list keeps its shape rather than silently
 * losing an entry.
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
