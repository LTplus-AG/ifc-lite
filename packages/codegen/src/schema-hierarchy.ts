/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Schema-derived type-membership helpers.
 *
 * Every `generated/{ifc4,ifc4x3}/schema-registry.ts` bundle carries, per
 * entity, an `inheritanceChain: string[]` running from the schema root down
 * to the entity itself (inclusive) — e.g.
 * `IfcMaterialConstituent.inheritanceChain = ['IfcMaterialDefinition', 'IfcMaterialConstituent']`.
 * That is a schema fact, not a naming convention: it is the correct tool for
 * "is this entity a subtype of X", a question three call sites answered with
 * a string test (`startsWith`/`endsWith`/`includes`) and got wrong at three
 * different edges (see ifc-lite issue #3999).
 *
 * This module is deliberately decoupled from any one generated bundle's
 * concrete `SchemaRegistry`/`EntityMetadata` interfaces (each bundle
 * re-declares its own, identically) — it only requires the shape it
 * actually reads, so it works unchanged against `ifc4`'s registry, `ifc4x3`'s,
 * or both.
 */

/** The minimal shape this module reads off a generated bundle's entity metadata. */
export interface HierarchyEntity {
  inheritanceChain?: string[];
}

/** The minimal shape this module reads off a generated bundle's `SchemaRegistry`. */
export interface HierarchyRegistry {
  entities: Record<string, HierarchyEntity>;
}

/**
 * Per-registry index from upper-cased entity name to its upper-cased
 * inheritance chain, built once per registry object and cached by identity
 * (a generated bundle's `SCHEMA_REGISTRY` is a module-level singleton, so
 * identity is stable for the process lifetime). IFC EXPRESS entity names are
 * unique under case-folding, so upper-casing both the key and the chain
 * entries is lossless and lets callers pass either the raw STEP/type-table
 * spelling (already upper-case, e.g. `'IFCWALL'`) or the schema's own
 * PascalCase spelling (`'IfcWall'`) without needing to know which.
 */
const chainIndexCache = new WeakMap<HierarchyRegistry, Map<string, string[]>>();

function chainIndexFor(registry: HierarchyRegistry): Map<string, string[]> {
  let index = chainIndexCache.get(registry);
  if (!index) {
    index = new Map();
    for (const [name, meta] of Object.entries(registry.entities)) {
      if (meta.inheritanceChain && meta.inheritanceChain.length > 0) {
        index.set(
          name.toUpperCase(),
          meta.inheritanceChain.map((n) => n.toUpperCase())
        );
      }
    }
    chainIndexCache.set(registry, index);
  }
  return index;
}

/**
 * Is `type` the same entity as `ancestor`, or a (possibly transitive) subtype
 * of it, according to `registry`? Reflexive: `isSubtypeOf(r, 'IfcWall',
 * 'IfcWall')` is `true`, matching the chain's own inclusion of the entity
 * itself. Case-insensitive on both arguments. Returns `false` for a `type`
 * the registry does not know (including an abstract supertype with no
 * `inheritanceChain` of its own, and any name from a *different* schema
 * version's vocabulary) — never throws.
 */
export function isSubtypeOf(registry: HierarchyRegistry, type: string, ancestor: string): boolean {
  const chain = chainIndexFor(registry).get(type.toUpperCase());
  if (!chain) return false;
  return chain.includes(ancestor.toUpperCase());
}

/**
 * Is `type` a subtype of (or the same entity as) `ancestor` in ANY of the
 * given registries? Use this to test membership against a schema-version
 * union — e.g. a set of entity types that must be recognised whether the
 * store was parsed against IFC4 or IFC4X3, mirroring how a hand-maintained
 * "recognise it in either schema" allowlist used to be built by hand.
 */
export function isSubtypeOfAny(
  registries: readonly HierarchyRegistry[],
  type: string,
  ancestor: string
): boolean {
  return registries.some((registry) => isSubtypeOf(registry, type, ancestor));
}

/**
 * Is `type` a PROPER (strict) subtype of `ancestor` — i.e. `isSubtypeOf` is
 * true AND `type` is not `ancestor` itself? Use this for an abstract
 * supertype with no concrete instances (`IfcMaterialDefinition`,
 * `IfcProfileDef`, …): no real IFC entity's `EntityRef.type` is ever the
 * literal abstract-type name, so a caller asking "is this entity one of
 * that abstract type's concrete members" wants the self-match excluded,
 * not `isSubtypeOf`'s reflexive answer.
 */
export function isProperSubtypeOf(registry: HierarchyRegistry, type: string, ancestor: string): boolean {
  return type.toUpperCase() !== ancestor.toUpperCase() && isSubtypeOf(registry, type, ancestor);
}

/** `isProperSubtypeOf`, checked against ANY of the given registries. */
export function isProperSubtypeOfAny(
  registries: readonly HierarchyRegistry[],
  type: string,
  ancestor: string
): boolean {
  return registries.some((registry) => isProperSubtypeOf(registry, type, ancestor));
}
