/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The lookup tables every `BimBackend` needs, declared once.
 *
 * There are three backends behind one SDK query API — the viewer's
 * `query-adapter`, `@ifc-lite/cli`'s `HeadlessBackend`, and `@ifc-lite/mcp`'s
 * `backend-query` — and each carried its own byte-identical copy of the two
 * tables below. Only the CLI copy had tests, so editing either of the other
 * two changed what `byType()` or `related()` answered on that surface alone,
 * with nothing failing: dropping `IFCSLABELEMENTEDCASE` from the MCP copy left
 * all 272 of its tests green. Three answers to one question is one answer too
 * many, so the tables live here, next to the `entityIndex` whose key shape
 * they are written against.
 */

import { RelationshipType, expandTypeNamesToDescendants } from '@ifc-lite/data';
import { getInheritanceChain, isQueryableObjectType } from './ifc-schema.js';

/**
 * IFC4 subtype map — parent types to their StandardCase/ElementedCase
 * subtypes, kept for backward compatibility (`@ifc-lite/cli`'s
 * `validate-subtypes.test.ts` reads this table directly as ground truth) and
 * as a fixed, hand-legible cross-check of the schema-driven expansion below.
 * `expandTypes` no longer walks this table itself — see its doc comment.
 *
 * Keys and values are UPPERCASE because `entityIndex.byType` is keyed by the
 * raw STEP type name (e.g. `IFCWALLSTANDARDCASE`).
 */
export const IFC_SUBTYPES: Record<string, string[]> = {
  IFCWALL: ['IFCWALLSTANDARDCASE', 'IFCWALLELEMENTEDCASE'],
  IFCBEAM: ['IFCBEAMSTANDARDCASE'],
  IFCCOLUMN: ['IFCCOLUMNSTANDARDCASE'],
  IFCDOOR: ['IFCDOORSTANDARDCASE'],
  IFCWINDOW: ['IFCWINDOWSTANDARDCASE'],
  IFCSLAB: ['IFCSLABSTANDARDCASE', 'IFCSLABELEMENTEDCASE'],
  IFCMEMBER: ['IFCMEMBERSTANDARDCASE'],
  IFCPLATE: ['IFCPLATESTANDARDCASE'],
  IFCOPENINGELEMENT: ['IFCOPENINGSTANDARDCASE'],
  // Not a `*StandardCase` family, and absent until #3229: IFC4 exporters write
  // furniture as IFCFURNITURE, so `byType('IfcFurnishingElement')` answered
  // with nothing on a model that plainly contained furniture.
  IFCFURNISHINGELEMENT: ['IFCFURNITURE', 'IFCSYSTEMFURNITUREELEMENT'],
};

/**
 * Which of `IfcRoot`'s branches a class sits in.
 *
 * `IfcRoot` is the ancestor of everything with a GlobalId, and its three
 * branches answer three different questions: occurrences, the property
 * definitions attached to them, and the relationships between them. Type
 * objects are a fourth answer inside the first, which is the line
 * {@link isQueryableObjectType} already draws for an UNFILTERED query.
 *
 * `'other'` is `IfcRoot` itself, and anything the bundled schemas do not
 * know — a vendor extension, a typo.
 */
type RootBranch = 'object' | 'typeObject' | 'propertyDefinition' | 'relationship' | 'other';

// Cached per name: `rootBranchOf` and `isQueryableObjectType` both walk the
// inheritance chain, and the gate calls one of them once per descendant. On
// `byType('IfcRoot')` that is 294 uncached walks for one query.
const rootBranchCache = new Map<string, RootBranch>();

function rootBranchOf(type: string): RootBranch {
  const cached = rootBranchCache.get(type);
  if (cached !== undefined) return cached;
  const branch = computeRootBranch(type);
  rootBranchCache.set(type, branch);
  return branch;
}

function computeRootBranch(type: string): RootBranch {
  const chain = getInheritanceChain(type);
  if (chain.includes('IfcRelationship')) return 'relationship';
  if (chain.includes('IfcPropertyDefinition')) return 'propertyDefinition';
  if (chain.includes('IfcTypeObject')) return 'typeObject';
  if (chain.includes('IfcObjectDefinition')) return 'object';
  return 'other';
}

/**
 * Expand a caller's type list to every schema-declared descendant (itself
 * plus every type that has it as an ancestor, direct or indirect), so
 * `byType('IfcBuildingElement')` finds the concrete leaves a model actually
 * contains instead of matching nothing — `IfcBuildingElement`/`IfcElement`
 * are abstract EXPRESS supertypes, never a literal STEP entity type, so a
 * caller asking for one always meant its subtypes.
 *
 * Delegates to `@ifc-lite/data`'s `expandTypeNamesToDescendants`, the single
 * schema-authority resolver every `byType()` backend now shares — this used
 * to be a fixed nine-entry `IFC_SUBTYPES` table (still above, unused here)
 * that only aliased `*StandardCase`/`*ElementedCase` pairs and silently
 * dropped every abstract-supertype query.
 *
 * `schemaVersion` is required and is the queried model's own
 * `store.schemaVersion`. Descendant sets are not the same across versions --
 * buildingSMART re-parented entities, so `IfcReinforcingBar` is an
 * `IfcBuildingElement` in IFC2X3 and an `IfcElementComponent` in IFC4 -- while
 * the names a FILE contains need not belong to the version its header claims.
 * The resolver reconciles the two; see its module doc for the exact rule.
 *
 * The expansion does not cross an `IfcRoot` branch. Descending the whole
 * hierarchy from an abstract root turned `byType('IfcRoot')` into "every
 * rooted record in the file" — 223 rows on `infra-bridge.ifc`, 36 of them
 * `IfcRelDefinesByProperties` — which a caller then hands to `storey()` or
 * `group_by`, written against products. `IfcObjectDefinition` swept in every
 * `*Type` the same way, contradicting the untyped branch of the very same
 * backends, which has always answered with {@link isQueryableObjectType}
 * only.
 *
 * The gate reads the requested type's branch rather than "is a product",
 * because `byType('IfcBuildingElementType')` means its subtypes exactly as
 * much as `byType('IfcBuildingElement')` does. The requested names themselves
 * are never gated: a caller who spells out `IfcPropertySet` said what they
 * wanted.
 *
 * Memoized on (schemaVersion, type list). Every `byType()` call goes through
 * here, and `validate` now calls it twice per store; the closure plus the gate
 * cost 0.78 ms for `IfcRoot` on IFC4, which the caches take to a Map lookup.
 * The key keeps the caller's order rather than sorting it: the output order is
 * contractual — each requested type ahead of its own descendants — so two
 * different orders are two different answers and must not share an entry.
 */
const expandCache = new Map<string, readonly string[]>();

export function expandTypes(types: string[], schemaVersion: string | undefined): string[] {
  const key = `${schemaVersion ?? ''}\u0000${types.join('\u0000')}`;
  const cached = expandCache.get(key);
  if (cached) return [...cached];
  const result = computeExpandTypes(types, schemaVersion);
  expandCache.set(key, result);
  return [...result];
}

function computeExpandTypes(types: string[], schemaVersion: string | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const type of types) {
    const branch = rootBranchOf(type);
    const [self, ...descendants] = expandTypeNamesToDescendants([type], schemaVersion);
    for (const name of [self as string, ...descendants.filter(
      (d) => isQueryableObjectType(d) || rootBranchOf(d) === branch,
    )]) {
      if (seen.has(name)) continue;
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

/**
 * Relationship names the SDK's `related(ref, relType, direction)` accepts,
 * keyed in the PascalCase spelling a caller writes.
 *
 * Deliberately NARROWER than `REL_TYPE_MAP` in `columnar-parser-indexes.ts`,
 * which the parser uses to bucket every relationship it indexes: the SDK
 * surface exposes five of those, and a name outside this map resolves to no
 * edges rather than throwing. Keeping the two maps in one place — rather than
 * three copies of this one and no cross-reference to the other — is what makes
 * that narrowing visible; widening the SDK surface is a deliberate change to
 * this table, not an accident of which backend a caller reached.
 */
export const QUERY_REL_TYPE_MAP: Record<string, RelationshipType> = {
  IfcRelContainedInSpatialStructure: RelationshipType.ContainsElements,
  IfcRelAggregates: RelationshipType.Aggregates,
  IfcRelDefinesByType: RelationshipType.DefinesByType,
  IfcRelVoidsElement: RelationshipType.VoidsElement,
  IfcRelFillsElement: RelationshipType.FillsElement,
};
