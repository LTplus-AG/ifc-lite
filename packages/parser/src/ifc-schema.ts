/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IFC Schema accessors — thin wrappers over the generated schema registry.
 *
 * The registry is code-generated from the IFC EXPRESS schema via `@ifc-lite/codegen`.
 * Do NOT hardcode entity types or attributes here; regenerate instead.
 */

import { SCHEMA_REGISTRY, getAllAttributesForEntity, isKnownEntity, getInheritanceChainForEntity, getEntityMetadata } from './generated/schema-registry.js';
import { ENTITIES_IFC2X3, ENTITIES_IFC4, ENTITIES_IFC4X3, IFC_DATA_TYPES, type IfcEntityInfo } from '@ifc-lite/data';

// Union map across every bundled IFC schema (2X3 + 4 + 4X3). The parser
// has to categorize entities from ANY schema the user loads — so the
// inheritance walk must consult more than the IFC4 registry the parser's
// codegen pinned. Later schemas win on name collision (a non-issue in
// practice because the modern schemas are supersets).
const ENTITY_INFO_BY_UPPER: Map<string, IfcEntityInfo> = (() => {
    const map = new Map<string, IfcEntityInfo>();
    for (const list of [ENTITIES_IFC2X3, ENTITIES_IFC4, ENTITIES_IFC4X3]) {
        for (const entity of list) {
            map.set(entity.name.toUpperCase(), entity);
        }
    }
    return map;
})();

// Aliases for entity names that appear in real STEP files but aren't in
// the bundled EXPRESS schema exports — typically draft IFC4x3 additions
// where the upstream codegen only modelled the abstract base while real
// authoring tools emit the leaf. Resolving the alias to its closest
// schema-known supertype lets the inheritance walk reach IfcProduct.
//
// Mirrors `rust/core/src/legacy_entities.rs` so the two sides stay in
// lockstep — if you add a row here, add the matching Rust entry too.
const ENTITY_NAME_ALIASES: Record<string, string> = {
    // IFC4.3 stratum subtypes (issue #860) — schema only has the abstract
    // `IfcGeotechnicalStratum`, real models emit one of these three leaves
    // with a PredefinedType pinned (SOLID / VOID / WATER).
    IFCSOLIDSTRATUM: 'IfcGeotechnicalStratum',
    IFCVOIDSTRATUM: 'IfcGeotechnicalStratum',
    IFCWATERSTRATUM: 'IfcGeotechnicalStratum',
};

/**
 * Resolve an entity name through {@link ENTITY_NAME_ALIASES}, returning the
 * name unchanged when it is not an alias.
 *
 * Exported because consumers that index the bundled schema union themselves
 * (the STEP exporter's enum-slot resolution) have to canonicalize the SAME way
 * {@link getAttributeNamesAcrossSchemas} does, or their indices refer to a
 * different attribute list than the names they are indices into. Copying the
 * table into another package would give it a third home — this one and
 * `rust/core/src/legacy_entities.rs` are already two.
 */
export function resolveEntityNameAlias(type: string): string {
    return ENTITY_NAME_ALIASES[type.toUpperCase()] ?? type;
}

// The bundled `ENTITIES_*` tables are generated from buildingSMART's
// SchemaInfo dumps, which list EXPRESS *defined types* (IfcLengthMeasure,
// IfcBoolean, IfcCountMeasure, …) alongside real ENTITY declarations. Those
// are not instantiable, so an "is this a class?" predicate has to subtract
// them or it would start answering yes for `IfcLengthMeasure`, which the IFC4
// codegen pin has always answered no for.
//
// Two authoritative tables say which names are not ENTITY declarations, and
// both are needed — measured over the 1159 union rows:
//   - `IFC_DATA_TYPES` (cross-schema, IDS-derived): 132 rows.
//   - `SCHEMA_REGISTRY.types` (the pin's own EXPRESS TYPE map): 6 more that
//     the IDS table omits — IfcBinary, IfcArcIndex, IfcLineIndex,
//     IfcComplexNumber, IfcCompoundPlaneAngleMeasure, IfcPropertySetDefinitionSet.
// `.enums` and `.selects` subtract nothing today and are folded in because the
// question is "does the pin classify this name as a non-ENTITY declaration",
// and answering it from two thirds of the pin's own classification would be
// the arbitrary choice. Asserted in `known-type-across-schemas.test.ts`.
//
// None of the pin's 776 ENTITY names appears in any of these tables, so the
// subtraction cannot change an IFC4 answer — and could not reject a pinned
// class even if it did, because `isKnownType` falls back to `isKnownEntity`.
const NON_ENTITY_NAMES_UPPER: ReadonlySet<string> = new Set([
    ...IFC_DATA_TYPES.map(t => t.name.toUpperCase()),
    ...Object.keys(SCHEMA_REGISTRY.types).map(n => n.toUpperCase()),
    ...Object.keys(SCHEMA_REGISTRY.enums).map(n => n.toUpperCase()),
    ...Object.keys(SCHEMA_REGISTRY.selects).map(n => n.toUpperCase()),
]);

/**
 * Entity-metadata lookup across the bundled schema union (2X3 + 4 + 4X3) —
 * the counterpart of the generated `getEntityMetadata`, which only knows the
 * IFC4_ADD2_TC1 codegen pin and so answers `undefined` for the 251 classes
 * outside it (`IfcMove`, `IfcScheduleTimeControl`, `IfcRoad`, `IfcSignal`, …).
 *
 * Deliberately does NOT resolve {@link ENTITY_NAME_ALIASES}: an alias maps a
 * leaf to its nearest schema-known *supertype*, which is what an inheritance
 * walk wants and the opposite of what a name-canonicalizer wants — resolving
 * it here would turn `normalizeIfcTypeName('IfcSolidStratum')` into
 * `'IfcGeotechnicalStratum'`, silently changing the caller's class.
 */
function getEntityInfoAcrossSchemas(type: string): IfcEntityInfo | undefined {
    const upper = type.toUpperCase();
    if (NON_ENTITY_NAMES_UPPER.has(upper)) return undefined;
    return ENTITY_INFO_BY_UPPER.get(upper);
}

function getInheritanceChainFromSchemaUnion(type: string): string[] | null {
    const upper = type.toUpperCase();
    const canonical = resolveEntityNameAlias(type);
    const start = ENTITY_INFO_BY_UPPER.get(canonical.toUpperCase());
    if (!start) return null;
    const chain: string[] = [];
    const seen = new Set<string>();
    // Surface the original (possibly aliased) leaf at the head of the
    // chain so consumers that compare against the leaf name still match,
    // then continue with the schema-known supertype chain.
    if (ENTITY_NAME_ALIASES[upper]) chain.push(type);
    let cursor: IfcEntityInfo | undefined = start;
    while (cursor && !seen.has(cursor.name)) {
        chain.push(cursor.name);
        seen.add(cursor.name);
        cursor = cursor.parent ? ENTITY_INFO_BY_UPPER.get(cursor.parent.toUpperCase()) : undefined;
    }
    return chain;
}

/**
 * Get all attribute names for an IFC entity type in STEP positional order.
 * Walks the inheritance chain (root → leaf) via the generated schema registry.
 */
export function getAttributeNames(type: string): string[] {
    const allAttrs = getAllAttributesForEntity(type);
    return allAttrs.map(a => a.name);
}

/**
 * Like {@link getAttributeNames}, but resolves across the bundled schema union
 * (2X3 + 4 + 4X3) when the parser's IFC4-pinned registry does not know the type.
 * IFC4.3 infrastructure leaves the codegen pin doesn't carry — IfcFacility,
 * IfcFacilityPart, IfcBridge, IfcRoad, IfcRailway, IfcMarineFacility, … — still
 * resolve their positional attributes (e.g. LongName at index 7) this way, so
 * name-by-index attribute reads stay correct across every schema, not just IFC4.
 * Known types keep the exact pinned-registry result (identical to
 * `getAttributeNames`); only otherwise-empty lookups consult the union.
 */
export function getAttributeNamesAcrossSchemas(type: string): string[] {
    const pinned = getAttributeNames(type);
    if (pinned.length > 0) return pinned;
    const canonical = resolveEntityNameAlias(type);
    const info = ENTITY_INFO_BY_UPPER.get(canonical.toUpperCase());
    return info ? [...info.attributes] : [];
}

/**
 * Check if a type is a real IFC entity class in any bundled schema.
 *
 * Answers for the union of every bundled IFC schema (2X3 + 4 + 4X3), falling
 * back to the parser's IFC4_ADD2_TC1 codegen pin — the same union-first,
 * pin-second order as {@link getInheritanceChain}. Answering from the pin alone
 * rejected roughly 251 perfectly valid classes: the IFC2X3 ones IFC4 dropped
 * (`IfcMove`, `IfcScheduleTimeControl`, `IfcSpaceProgram`, …) and the IFC4X3
 * infrastructure ones it never had (`IfcRoad`, `IfcSignal`, `IfcAlignment`, …).
 * That made `@ifc-lite/sdk`'s `addEntity` refuse to author them at all (#2003).
 *
 * Still a real guard, not a pass-through: a typo (`IfcWal`), a vendor extension
 * and an EXPRESS defined type (`IfcLengthMeasure`, `IfcArcIndex`) are all
 * rejected.
 *
 * Known-ness, not instantiability: abstract supertypes (`IfcProduct`,
 * `IfcRoot`) answer `true`, as they always have — that is a different
 * predicate, {@link isInstantiable}, and it belongs at the authoring
 * boundary, not in a name-registry check (#2035).
 */
export function isKnownType(type: string): boolean {
    if (getEntityInfoAcrossSchemas(type)) return true;
    return isKnownEntity(type);
}

/**
 * Check whether a type is a real IFC entity class that can actually be
 * instantiated — `known && !abstract`.
 *
 * {@link isKnownType} answers a different question ("is this a real EXPRESS
 * class name") and always has: `IfcProduct`, `IfcRoot` and `IfcRelationship`
 * are real classes and abstract EXPRESS supertypes, so `isKnownType` answers
 * `true` for them, and authoring code that only checked known-ness could
 * write `#N=IFCPRODUCT(...)` into an exported file, which is not valid IFC
 * (#2035).
 *
 * Same union-first, pin-second resolution order as {@link isKnownType}: the
 * bundled schema union's `abstract` flag and the codegen pin's `isAbstract`
 * flag agree on every class both know, so there is no reconciliation
 * question, only which table happens to carry the name.
 */
export function isInstantiable(type: string): boolean {
    const info = getEntityInfoAcrossSchemas(type);
    if (info) return !info.abstract;
    const metadata = getEntityMetadata(type);
    if (metadata) return !metadata.isAbstract;
    return false;
}

/**
 * Get the full inheritance chain for an IFC entity type.
 * Returns PascalCase names, leaf → root order (e.g. `['IfcAirTerminal',
 * 'IfcFlowTerminal', ..., 'IfcRoot']`).
 *
 * Walks the union of every bundled IFC schema (2X3 + 4 + 4X3) so that
 * IFC4x3 infrastructure leaves (IfcReferent, IfcSignal, IfcAlignment,
 * IfcPavement, IfcCourse, IfcSign, …) resolve their chain correctly even
 * though the parser's own codegen pin (`./generated/schema-registry.ts`)
 * is still on IFC4_ADD2_TC1. Falls back to the IFC4 registry for vendor
 * extensions that the union map doesn't know.
 */
export function getInheritanceChain(type: string): string[] {
    const fromUnion = getInheritanceChainFromSchemaUnion(type);
    if (fromUnion && fromUnion.length > 0) return fromUnion;
    return getInheritanceChainForEntity(type);
}

/**
 * Get attribute name at a specific index for a type.
 */
export function getAttributeNameAt(type: string, index: number): string | null {
    const names = getAttributeNames(type);
    return names[index] || null;
}

/**
 * Normalize an IFC entity type name to canonical EXPRESS PascalCase.
 *
 * - `'IFCWALL'` → `'IfcWall'`
 * - `'IfcWall'` → `'IfcWall'` (unchanged)
 * - `'IFCROAD'` → `'IfcRoad'` (IFC4X3, outside the codegen pin)
 * - `'ifcmove'` → `'IfcMove'` (IFC2X3, dropped in IFC4)
 * - `'IfcVendorExtensionFoo'` → `'IfcVendorExtensionFoo'` (unchanged — unknown to registry)
 *
 * Resolves against the bundled schema union first and the IFC4_ADD2_TC1 pin
 * second, matching {@link isKnownType} — the pin alone left every class outside
 * it falling through to "preserve as-is", so an IFC4X3 class kept whatever
 * casing the caller happened to type instead of being canonicalized (#2003).
 *
 * Used at user-facing API boundaries to keep the public contract on
 * canonical PascalCase regardless of how the caller spells the type.
 */
export function normalizeIfcTypeName(type: string): string {
    if (typeof type !== 'string' || type.length === 0) return type;
    const info = getEntityInfoAcrossSchemas(type);
    if (info) return info.name;
    const metadata = getEntityMetadata(type);
    if (metadata) return metadata.name;
    // Unknown to registry — preserve as-is (could be a vendor extension).
    return type;
}
