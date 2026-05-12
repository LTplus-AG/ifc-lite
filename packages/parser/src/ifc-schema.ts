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
 * Get the full inheritance chain for an IFC entity type (root → leaf).
 * Returns PascalCase names, e.g. ['IfcRoot', ..., 'IfcFlowTerminal', 'IfcAirTerminal'].
 */
export function getInheritanceChain(type: string): string[] {
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
