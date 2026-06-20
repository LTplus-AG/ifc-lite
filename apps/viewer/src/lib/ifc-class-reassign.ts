/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Schema data for the "Reassign IFC class" (retype) control.
 *
 * Sources the candidate target classes and their `PredefinedType` enum
 * domains from the bundled IFC schema (`@ifc-lite/data`). The universe is
 * restricted to non-abstract `IfcElement` subtypes — the building elements a
 * user actually reassigns between (the MCAD-proxy case from issue #1231) —
 * rather than every product in the schema.
 */

import {
  ENTITIES_IFC2X3,
  ENTITIES_IFC4,
  ENTITIES_IFC4X3,
  type IfcEntityInfo,
} from '@ifc-lite/data';

export type ReassignSchema = 'IFC2X3' | 'IFC4' | 'IFC4X3';

const SCHEMA_LISTS: Record<ReassignSchema, readonly IfcEntityInfo[]> = {
  IFC2X3: ENTITIES_IFC2X3,
  IFC4: ENTITIES_IFC4,
  IFC4X3: ENTITIES_IFC4X3,
};

/**
 * Curated quick-pick targets — the building-element subtypes that share the
 * `IfcElement` attribute layout, so a reassignment is a clean keyword swap.
 * These surface as one-click chips; the rest live in the searchable list.
 */
export const COMMON_REASSIGN_TARGETS: readonly string[] = [
  'IfcColumn',
  'IfcBeam',
  'IfcMember',
  'IfcPlate',
  'IfcWall',
  'IfcSlab',
  'IfcCovering',
  'IfcRailing',
  'IfcFooting',
  'IfcBuildingElementProxy',
];

/** Map a loaded model's schema string (any spelling) to a bundled schema. */
export function resolveReassignSchema(version?: string | null): ReassignSchema {
  const up = (version ?? '').toUpperCase();
  if (up.includes('2X3')) return 'IFC2X3';
  if (up.includes('4X3')) return 'IFC4X3';
  return 'IFC4';
}

const indexCache = new Map<ReassignSchema, Map<string, IfcEntityInfo>>();

function indexFor(schema: ReassignSchema): Map<string, IfcEntityInfo> {
  let idx = indexCache.get(schema);
  if (!idx) {
    idx = new Map();
    for (const e of SCHEMA_LISTS[schema]) idx.set(e.name.toUpperCase(), e);
    indexCache.set(schema, idx);
  }
  return idx;
}

function isSubtypeOf(
  info: IfcEntityInfo,
  ancestorUpper: string,
  byUpper: Map<string, IfcEntityInfo>,
): boolean {
  let cursor: IfcEntityInfo | undefined = info;
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor.name)) {
    if (cursor.name.toUpperCase() === ancestorUpper) return true;
    seen.add(cursor.name);
    cursor = cursor.parent ? byUpper.get(cursor.parent.toUpperCase()) : undefined;
  }
  return false;
}

const targetsCache = new Map<ReassignSchema, string[]>();

/** All non-abstract `IfcElement` subtypes for a schema, sorted A→Z. */
export function getReassignTargets(schema: ReassignSchema): string[] {
  let cached = targetsCache.get(schema);
  if (cached) return cached;
  const byUpper = indexFor(schema);
  const out: string[] = [];
  for (const e of SCHEMA_LISTS[schema]) {
    if (e.abstract) continue;
    if (!isSubtypeOf(e, 'IFCELEMENT', byUpper)) continue;
    out.push(e.name);
  }
  out.sort((a, b) => a.localeCompare(b));
  cached = out;
  targetsCache.set(schema, cached);
  return cached;
}

/** Is `className` a known, instantiable element class in this schema? */
export function isKnownReassignTarget(schema: ReassignSchema, className: string): boolean {
  const info = indexFor(schema).get(className.trim().toUpperCase());
  return !!info && !info.abstract;
}

/**
 * Is `className` an instantiable `IfcElement` subtype — i.e. a building
 * element that may be reassigned? Used to gate the UI control so it only
 * appears for occurrence elements (not type entities, spaces, or materials).
 */
export function isReassignableElement(schema: ReassignSchema, className: string): boolean {
  const byUpper = indexFor(schema);
  const info = byUpper.get(className.trim().toUpperCase());
  if (!info || info.abstract) return false;
  return isSubtypeOf(info, 'IFCELEMENT', byUpper);
}

/** The `PredefinedType` enum domain for a class, or `[]` if it has none. */
export function getPredefinedTypes(schema: ReassignSchema, className: string): string[] {
  const info = indexFor(schema).get(className.trim().toUpperCase());
  return info ? [...info.predefinedTypes] : [];
}
