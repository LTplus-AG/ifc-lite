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
 *       one). A name the file's own schema defines is never added, and if it
 *       defines that name under a DIFFERENT parent the walk does not descend
 *       through it either — both halves are what keep (b) from re-opening the
 *       union's misfiling;
 *   (c) plus the two alias relations in `./entity-aliases.js`: the
 *       cross-schema rename equality, and the narrowing for leaves no bundled
 *       table declares.
 */

import { ENTITY_NAME_ALIASES, CROSS_SCHEMA_RENAMES } from './entity-aliases.js';
// The same per-version map `getEntities` answers from. Shared rather than
// re-declared here: a second copy would let a future schema version reach one
// of the two and give `getEntities` and this resolver different worlds.
import { ENTITIES_BY_VERSION } from './index.js';
import type { IfcSchemaVersion } from './types.js';

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
  for (const entity of ENTITIES_BY_VERSION[v]) {
    const name = entity.name.toUpperCase();
    names.add(name);
    if (!entity.parent) continue;
    const parent = entity.parent.toUpperCase();
    const bucket = children.get(parent);
    if (bucket) bucket.push(name);
    else children.set(parent, [name]);
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

/**
 * `ENTITY_NAME_ALIASES` as UPPERCASE `[leaf, supertype]` rows, uppercased once
 * at module load rather than on every call. The table is read-only.
 */
const ALIAS_ROWS: readonly (readonly [string, string])[] = Object.entries(
  ENTITY_NAME_ALIASES,
).map(([leaf, supertype]) => [leaf.toUpperCase(), supertype.toUpperCase()] as const);

/**
 * The file's own schema's verdict on a foreign table's walk: which names it
 * declares, and which of them it puts inside the requested subtree.
 *
 * `subtree` is the seeds plus their descendants in the OWN table. `active` is
 * false when the own table declares none of the seeds — it then has no opinion
 * about this subtree at all, and the table that does declare the requested type
 * is the only authority, so nothing is pruned and nothing is skipped. Pruning
 * without that guard cost `byType('IfcSpatialElement')` on IFC2X3 every
 * `IFCBRIDGE`/`IFCROAD`: IFC2X3 has no `IfcSpatialElement`, so an empty subtree
 * would have read as "own says no" rather than "own says nothing". Skipping
 * without it cost the same query every `IFCBUILDING`, `IFCBUILDINGSTOREY`,
 * `IFCSITE` and `IFCSPACE` — names IFC2X3 does declare, under a supertype it
 * has no equivalent of, so its own walk had returned none of them either.
 */
interface OwnVerdict {
  readonly table: SchemaTable;
  readonly subtree: ReadonlySet<string>;
  readonly active: boolean;
}

/**
 * Transitive descendants of `seeds` within one schema table, seeds excluded.
 *
 * `own` is the file's own schema's verdict, passed when `table` is a foreign
 * one; it is what implements rule (b). When the own table has an opinion about
 * this subtree, a name it declares is never returned — that table is the
 * authority on where it sits — and when it puts that name OUTSIDE the requested
 * subtree, the walk does not descend through it either. When `own.active` is
 * false the own table has no opinion at all, so neither half applies and the
 * foreign table's answer is kept whole: `IfcSpatialElement` on IFC2X3 must
 * still find `IFCBUILDING` and `IFCSPACE`, names IFC2X3 declares but places
 * under a supertype it has no equivalent of.
 *
 * That second half is not decoration. `IfcTendonConduit` is IFC4X3-only and
 * sits under `IfcReinforcingElement` there; IFC2X3 declares
 * `IfcReinforcingElement` under `IfcBuildingElement`, nowhere near
 * `IfcElementComponent`. Skipping the re-parented node but still walking
 * through it put `IFCTENDONCONDUIT` in `byType('IfcElementComponent')` on an
 * IFC2X3 file — the union's misfiling, one level down.
 *
 * The test is subtree membership, not same-parent: the IFC4X3 rename moved
 * every element from `IfcBuildingElement` to `IfcBuiltElement`, so comparing
 * declared parents reads the whole hierarchy as re-parented and drops
 * `IFCSLABSTANDARDCASE` from `byType('IfcBuiltElement')` on IFC4X3 — the
 * headline case this resolver exists for. `IfcSlab` sits under both spellings,
 * so it is inside the subtree and the walk continues through it.
 */
function descendantsInTable(
  table: SchemaTable,
  seeds: readonly string[],
  own?: OwnVerdict,
): Set<string> {
  const found = new Set<string>();
  const stack = [...seeds];
  const visited = new Set<string>(seeds);
  while (stack.length > 0) {
    for (const child of table.children.get(stack.pop() as string) ?? []) {
      if (visited.has(child)) continue;
      visited.add(child);
      if (own?.active && own.table.names.has(child)) {
        // Own declares it AND has an opinion about this subtree, so it is
        // never added here: own's own walk already returned it if own agrees
        // it belongs. Descend only if own agrees.
        if (own.subtree.has(child)) stack.push(child);
        continue;
      }
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
 *
 * Memoized per (version, type). Three table walks plus a sort of the result is
 * 0.3 ms for `IfcRoot` on IFC4, and `expandTypeNamesToDescendants` is public
 * API, so a consumer outside `@ifc-lite/parser` — whose own memo is keyed on
 * the whole ordered list, and so misses whenever that list is reordered —
 * would otherwise pay that on every call. The cached array never leaves this
 * module: the only caller copies names out of it into a fresh list.
 */
const descendantCache = new Map<string, readonly string[]>();

/**
 * Bound on every memo in this resolver's path. The keys are caller-supplied
 * type names, and the MCP server and the viewer are long-lived processes where
 * those come from an agent or an SDK script, so an unbounded map grows on
 * typos and vendor namespaces forever. Clearing wholesale rather than evicting
 * one entry costs a recompute on the next call and needs no bookkeeping; the
 * bundled schemas declare ~1160 names, so a real workload never reaches it.
 */
const CACHE_LIMIT = 4096;

function descendantsOf(type: string, v: IfcSchemaVersion): readonly string[] {
  const upper = type.toUpperCase();
  const key = `${v}\u0000${upper}`;
  const cached = descendantCache.get(key);
  if (cached) return cached;
  const computed = computeDescendantsOf(upper, v);
  if (descendantCache.size >= CACHE_LIMIT) descendantCache.clear();
  descendantCache.set(key, computed);
  return computed;
}

function computeDescendantsOf(upper: string, v: IfcSchemaVersion): string[] {
  const seeds = renameGroup(upper);
  const own = tableFor(v);

  const ownDescendants = descendantsInTable(own, seeds);
  const found = new Set<string>(seeds.slice(1));
  for (const name of ownDescendants) found.add(name);

  // (b) A leaf spelling this schema has no opinion about at all. The own
  // table's verdict is handed to the walk, which is what keeps a name this
  // schema declares out of the answer, and what stops the walk from descending
  // through one this schema places outside the requested subtree. See
  // `descendantsInTable`.
  const verdict: OwnVerdict = {
    table: own,
    subtree: new Set([...seeds, ...ownDescendants]),
    active: seeds.some((seed) => own.names.has(seed)),
  };
  for (const other of ALL_VERSIONS) {
    const table = tableFor(other);
    if (table === own) continue;
    for (const name of descendantsInTable(table, seeds, verdict)) found.add(name);
  }

  // (c) The narrowing: a leaf no bundled table declares hangs off its nearest
  // schema-known supertype. One direction only, so `IfcGeotechnicalStratum`
  // gains `IfcSolidStratum` while `IfcSolidStratum` does not gain its siblings.
  for (const [leaf, parent] of ALIAS_ROWS) {
    if (parent === upper || found.has(parent)) found.add(leaf);
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
