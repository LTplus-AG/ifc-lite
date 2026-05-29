/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IFC Schema accessors — thin wrappers over the generated schema registry.
 *
 * The registry is code-generated from the IFC EXPRESS schema via `@ifc-lite/codegen`.
 * Do NOT hardcode entity types or attributes here; regenerate instead.
 */

import { getAllAttributesForEntity, isKnownEntity, getInheritanceChainForEntity, getEntityMetadata } from './generated/schema-registry.js';
import { ENTITIES_IFC2X3, ENTITIES_IFC4, ENTITIES_IFC4X3, type IfcEntityInfo } from '@ifc-lite/data';

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

function getInheritanceChainFromSchemaUnion(type: string): string[] | null {
    const upper = type.toUpperCase();
    const canonical = ENTITY_NAME_ALIASES[upper] ?? type;
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
 * Check if a type is known in the IFC schema.
 */
export function isKnownType(type: string): boolean {
    return isKnownEntity(type);
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
 * - `'IfcVendorExtensionFoo'` → `'IfcVendorExtensionFoo'` (unchanged — unknown to registry)
 *
 * Used at user-facing API boundaries to keep the public contract on
 * canonical PascalCase regardless of how the caller spells the type.
 */
export function normalizeIfcTypeName(type: string): string {
    if (typeof type !== 'string' || type.length === 0) return type;
    const metadata = getEntityMetadata(type);
    if (metadata) return metadata.name;
    // Unknown to registry — preserve as-is (could be a vendor extension).
    return type;
}
