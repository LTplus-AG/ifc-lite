/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * List-scope class enumeration.
 *
 * The New List scope selector offers one chip per element class present in
 * the loaded model(s). The previous implementation drove the chips from a
 * hardcoded curated list of IfcTypeEnum members, so any present class that
 * wasn't on that list (IfcDuctSegment, IfcPipeSegment, and every other
 * class the curator forgot) was silently unlistable (#1662). This derives
 * the offered classes from what the model actually contains instead, so a
 * newly-present class appears automatically without editing a taxonomy.
 *
 * Only classes that map to a distinct IfcTypeEnum are offered — the scope is
 * targeted by enum (`getEntitiesByType`), and classes with no dedicated enum
 * all collapse into the `Unknown` bucket, which can't be selected without
 * over-selecting. Those are still reachable through the "All elements"
 * (no-type) scope. Relationships, property/quantity definitions and type
 * objects are excluded: they are not list-able elements.
 */

import { IfcTypeEnum } from '@ifc-lite/data';
import type { EntityTable } from '@ifc-lite/data';

/** One selectable scope class: an IFC type present in the model, with count. */
export interface ScopeTypeOption {
  type: IfcTypeEnum;
  /** Friendly label (curated plural where known, else the IFC class name). */
  label: string;
  /** Total instances across all provided stores. */
  count: number;
}

/**
 * Friendly plural labels for the common classes, so familiar chips still read
 * "Walls" / "MEP Segments" rather than the raw IFC class name. Classes absent
 * from this map fall back to their canonical `IfcClassName` (e.g.
 * "IfcDuctSegment") — unknown to the curator, but never hidden.
 */
const SCOPE_TYPE_LABELS: Partial<Record<IfcTypeEnum, string>> = {
  [IfcTypeEnum.IfcWall]: 'Walls',
  [IfcTypeEnum.IfcWallStandardCase]: 'Walls (Standard)',
  [IfcTypeEnum.IfcDoor]: 'Doors',
  [IfcTypeEnum.IfcWindow]: 'Windows',
  [IfcTypeEnum.IfcSlab]: 'Slabs',
  [IfcTypeEnum.IfcColumn]: 'Columns',
  [IfcTypeEnum.IfcBeam]: 'Beams',
  [IfcTypeEnum.IfcStair]: 'Stairs',
  [IfcTypeEnum.IfcRamp]: 'Ramps',
  [IfcTypeEnum.IfcRoof]: 'Roofs',
  [IfcTypeEnum.IfcCovering]: 'Coverings',
  [IfcTypeEnum.IfcCurtainWall]: 'Curtain Walls',
  [IfcTypeEnum.IfcRailing]: 'Railings',
  [IfcTypeEnum.IfcSpace]: 'Spaces',
  [IfcTypeEnum.IfcSpatialZone]: 'Spatial Zones',
  [IfcTypeEnum.IfcZone]: 'Zones',
  [IfcTypeEnum.IfcSystem]: 'Systems',
  [IfcTypeEnum.IfcDistributionSystem]: 'Distribution Systems',
  [IfcTypeEnum.IfcBuildingStorey]: 'Storeys',
  [IfcTypeEnum.IfcDistributionElement]: 'MEP Distribution',
  [IfcTypeEnum.IfcFlowTerminal]: 'MEP Terminals',
  [IfcTypeEnum.IfcFlowSegment]: 'MEP Segments',
  [IfcTypeEnum.IfcFlowFitting]: 'MEP Fittings',
};

/**
 * Preferred ordering for the familiar classes, so the common chips keep their
 * established layout. Present classes not listed here sort after, by label.
 */
const SCOPE_TYPE_ORDER: IfcTypeEnum[] = [
  IfcTypeEnum.IfcWall,
  IfcTypeEnum.IfcWallStandardCase,
  IfcTypeEnum.IfcDoor,
  IfcTypeEnum.IfcWindow,
  IfcTypeEnum.IfcSlab,
  IfcTypeEnum.IfcColumn,
  IfcTypeEnum.IfcBeam,
  IfcTypeEnum.IfcStair,
  IfcTypeEnum.IfcRamp,
  IfcTypeEnum.IfcRoof,
  IfcTypeEnum.IfcCovering,
  IfcTypeEnum.IfcCurtainWall,
  IfcTypeEnum.IfcRailing,
  IfcTypeEnum.IfcSpace,
  IfcTypeEnum.IfcSpatialZone,
  IfcTypeEnum.IfcZone,
  IfcTypeEnum.IfcSystem,
  IfcTypeEnum.IfcDistributionSystem,
  IfcTypeEnum.IfcBuildingStorey,
  IfcTypeEnum.IfcDistributionElement,
  IfcTypeEnum.IfcFlowTerminal,
  IfcTypeEnum.IfcFlowSegment,
  IfcTypeEnum.IfcFlowFitting,
];

/**
 * Whether a present class is a valid list-scope target. Products, spatial
 * structure and groupings qualify; relationships, property/quantity
 * definitions and type objects do not. `Unknown` never qualifies — a class
 * with no distinct enum can't be targeted without pulling in every other
 * unmapped class.
 *
 * @param type canonical IfcTypeEnum for the class
 * @param name canonical `IfcClassName` (from `getTypeName`)
 */
export function isScopeTargetType(type: IfcTypeEnum, name: string): boolean {
  if (type === IfcTypeEnum.Unknown) return false;
  // Type objects (IfcWallType, IfcSurfaceStyle, …) — templates, not elements.
  if (name.endsWith('Type') || name.endsWith('Style')) return false;
  // Relationships (IfcRelAggregates, …).
  if (name.startsWith('IfcRel')) return false;
  // Property / quantity definitions (IfcPropertySet, IfcQuantityArea,
  // IfcElementQuantity, …) — data records, not elements.
  if (name.startsWith('IfcProperty') || name.startsWith('IfcQuantity')) return false;
  if (name === 'IfcElementQuantity') return false;
  return true;
}

/** The narrow store surface `collectScopeTypes` reads (full IfcDataStore assignable). */
export interface ScopeTypeStore {
  entities: Pick<EntityTable, 'getByType' | 'getTypeEnum' | 'getTypeName'>;
  entityIndex: { byType: Map<string, number[]> };
}

/**
 * Enumerate the element classes present across the given stores, with total
 * instance counts, ready to render as scope chips. Sorted by the curated
 * order first, then alphabetically by label for any remaining classes.
 */
export function collectScopeTypes(stores: ScopeTypeStore[]): ScopeTypeOption[] {
  const byEnum = new Map<IfcTypeEnum, { label: string; count: number }>();

  for (const store of stores) {
    // Dedupe per store: several STEP names can share one enum (IfcDoor +
    // IfcDoorStandardCase), and getByType already merges them, so count once.
    const counted = new Set<IfcTypeEnum>();
    for (const ids of store.entityIndex.byType.values()) {
      if (ids.length === 0) continue;
      const sample = ids[0];
      const type = store.entities.getTypeEnum(sample);
      if (type === IfcTypeEnum.Unknown || counted.has(type)) continue;
      counted.add(type);
      const name = store.entities.getTypeName(sample);
      if (!isScopeTargetType(type, name)) continue;
      const count = store.entities.getByType(type).length;
      if (count === 0) continue;
      const label = SCOPE_TYPE_LABELS[type] ?? name;
      const entry = byEnum.get(type);
      if (entry) entry.count += count;
      else byEnum.set(type, { label, count });
    }
  }

  const orderIndex = new Map<IfcTypeEnum, number>();
  SCOPE_TYPE_ORDER.forEach((t, i) => orderIndex.set(t, i));

  return Array.from(byEnum, ([type, { label, count }]) => ({ type, label, count })).sort((a, b) => {
    const ai = orderIndex.get(a.type) ?? Number.MAX_SAFE_INTEGER;
    const bi = orderIndex.get(b.type) ?? Number.MAX_SAFE_INTEGER;
    if (ai !== bi) return ai - bi;
    return a.label.localeCompare(b.label);
  });
}
