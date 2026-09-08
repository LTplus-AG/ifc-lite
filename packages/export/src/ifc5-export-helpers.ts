/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Small standalone helpers for {@link Ifc5Exporter} — split out purely to
 * keep ifc5-exporter.ts under its module-size budget; no behavior change.
 */

import { IfcTypeEnumToString, IfcTypeEnumFromString } from '@ifc-lite/data';

/** IFCX node in output, matching the shape `collectRequiredImports` scans. */
interface IfcxNodeOutputLike {
  attributes?: Record<string, unknown>;
}

/** Standard IFC5 schema package URIs, keyed by the attribute prefix they provide. */
export const IFCX_SCHEMA_IMPORTS = {
  /** Core IFC: bsi::ifc::class, bsi::ifc::presentation::*, bsi::ifc::material, bsi::ifc::spaceBoundary */
  IFC_CORE: 'https://ifcx.dev/@standards.buildingsmart.org/ifc/core/ifc@v5a.ifcx',
  /** IFC properties: bsi::ifc::prop::* */
  IFC_PROP: 'https://ifcx.dev/@standards.buildingsmart.org/ifc/core/prop@v5a.ifcx',
  /** OpenUSD geometry: usd::usdgeom::mesh, usd::xformop, usd::usdgeom::visibility */
  USD: 'https://ifcx.dev/@openusd.org/usd@v1.ifcx',
} as const;

/**
 * Scan data nodes and return the list of standard IFCX import URIs needed
 * for the attribute namespaces actually used.
 */
export function collectRequiredImports(nodes: IfcxNodeOutputLike[]): { uri: string }[] {
  let needsIfcCore = false;
  let needsIfcProp = false;
  let needsUsd = false;

  for (const node of nodes) {
    if (!node.attributes) continue;
    for (const key of Object.keys(node.attributes)) {
      // IFC core schemas: class, presentation, material, spaceBoundary
      if (!needsIfcCore && (
        key === 'bsi::ifc::class' ||
        key.startsWith('bsi::ifc::presentation::') ||
        key === 'bsi::ifc::material' ||
        key === 'bsi::ifc::spaceBoundary'
      )) {
        needsIfcCore = true;
      }
      // IFC property schemas: bsi::ifc::prop::*
      if (!needsIfcProp && key.startsWith('bsi::ifc::prop::')) {
        needsIfcProp = true;
      }
      // USD schemas: usd::*
      if (!needsUsd && key.startsWith('usd::')) {
        needsUsd = true;
      }
      if (needsIfcCore && needsIfcProp && needsUsd) break;
    }
    if (needsIfcCore && needsIfcProp && needsUsd) break;
  }

  const imports: { uri: string }[] = [];
  if (needsIfcCore) imports.push({ uri: IFCX_SCHEMA_IMPORTS.IFC_CORE });
  if (needsIfcProp) imports.push({ uri: IFCX_SCHEMA_IMPORTS.IFC_PROP });
  if (needsUsd) imports.push({ uri: IFCX_SCHEMA_IMPORTS.USD });
  return imports;
}

/**
 * Generate a deterministic UUID-like string from an expressId.
 * Format: 8-4-4-4-12 hex chars (UUID v4-like but deterministic).
 */
export function generateUuid(id: number): string {
  const hex = id.toString(16).padStart(12, '0');
  return `00000000-0000-4000-8000-${hex}`;
}

/**
 * Convert STEP uppercase type name (e.g. "IFCWALL") to PascalCase class name (e.g. "IfcWall").
 * Uses the IFC type enum lookup for canonical casing (e.g. "IfcRelAggregates", not "Ifcrelaggregates").
 */
export function stepTypeToClassName(stepType: string): string {
  const enumVal = IfcTypeEnumFromString(stepType);
  const name = IfcTypeEnumToString(enumVal);
  if (name !== 'Unknown') return name;
  // Fallback for types not in the enum: simple prefix normalisation
  const lower = stepType.toLowerCase();
  if (lower.startsWith('ifc')) {
    return 'Ifc' + lower.charAt(3).toUpperCase() + lower.slice(4);
  }
  return stepType;
}
