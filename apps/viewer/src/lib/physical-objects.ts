/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * "How many physical objects are visible?" — the denominator, and the count.
 *
 * The obvious denominator is `geometryResult.meshes.length`, but that counts
 * things that PRODUCED a mesh. An object that is in the file and never
 * generated geometry is then absent from the denominator too, so the ratio is
 * definitionally 1: the badge would read "1203 of 1203 visible" while a wall
 * silently failed to slice. Counting from the entity index instead makes the
 * gap between "in the model" and "on screen" observable.
 *
 * The mesh array is the wrong denominator in three separate ways, not one:
 * an element can produce MANY `MeshData` entries (one per material or CSG
 * part); a colour-merged batch carries many entities in one entry via
 * `entityIds`; and a fully-instanced entity produces NO entry at all
 * (`GeometryResult.instancedGeometryHashes`). So `meshes.length` is neither an
 * upper nor a lower bound on objects — it is a different quantity.
 *
 * ## What counts as a physical object
 *
 * An entity whose inheritance chain contains `IfcElement`, minus
 * `IfcFeatureElement` and `IfcVirtualElement` subtypes.
 *
 * `IfcElement` is the schema's own word for "an element of a construction
 * work" — a thing with physical presence. Everything excluded is excluded
 * because counting it would cry wolf, i.e. report objects as "not visible"
 * that were never meant to be drawn:
 *
 * - Spatial containers (`IfcSite`, `IfcBuilding`, `IfcBuildingStorey`,
 *   `IfcSpace`) descend from `IfcSpatialElement`, NOT `IfcElement`, so they
 *   fall out with no special case. They have no shape representation by
 *   design.
 * - `IfcSpace` in particular is a real object a user cares about, but the
 *   viewer ships with spaces hidden (`TYPE_VISIBILITY_SEMANTIC_DEFAULTS.spaces
 *   === false`). In the denominator, every default-loaded model with rooms
 *   would permanently read "N not visible" — an alarm that is never actionable
 *   and never wrong to ignore, which is the worst kind. It is a spatial
 *   element by schema and hidden by product decision, so both readings agree:
 *   out.
 * - `IfcFeatureElement` subtypes (`IfcOpeningElement`, `IfcVoidingFeature`, …)
 *   are voids subtracted from other elements, not objects. They are `IfcElement`
 *   subtypes by schema, and hidden by default (`openings === false`).
 * - `IfcVirtualElement` is a non-physical clearance/boundary volume, hidden by
 *   default for exactly that reason (issue #1133).
 * - `IfcAnnotation` and `IfcGrid` descend from `IfcProduct` but not
 *   `IfcElement`, so they fall out too — drafting aids, not objects.
 *
 * The rule deliberately keys on the schema inheritance chain rather than a
 * hardcoded leaf list, so a schema bump that adds a new `IfcElement` subtype
 * is counted without anyone remembering to edit a set here. The chain must be
 * the ACROSS-SCHEMAS one: the single-schema walk is pinned to IFC4 and returns
 * an empty chain for IFC4X3 infrastructure classes, which would silently read
 * as "not physical" (same trap documented on `isProductClass` in
 * `lib/compare/compareScope.ts`, the sibling `IfcProduct`-level predicate).
 */

import { getInheritanceChainAcrossSchemas } from '@ifc-lite/parser';

/** Ancestor that makes an entity a physical object. */
const PHYSICAL_ROOT = 'IFCELEMENT';

/** Ancestors that disqualify it again, checked after `PHYSICAL_ROOT`. */
const NON_PHYSICAL_ROOTS = new Set(['IFCFEATUREELEMENT', 'IFCVIRTUALELEMENT']);

/**
 * Cache keyed by the exact string handed in. The entity index has O(10)–O(100)
 * distinct type names for O(10^6) entities, and callers pass index keys, so
 * this collapses the schema walk to once per type name per session.
 */
const physicalTypeCache = new Map<string, boolean>();

/**
 * True when `typeName` (any case; STEP convention is uppercase) names a
 * physical object per the rule documented above.
 */
export function isPhysicalObjectType(typeName: string): boolean {
  const cached = physicalTypeCache.get(typeName);
  if (cached !== undefined) return cached;

  const chain = getInheritanceChainAcrossSchemas(typeName.toUpperCase());
  let physical = false;
  for (const ancestor of chain) {
    const upper = ancestor.toUpperCase();
    if (NON_PHYSICAL_ROOTS.has(upper)) {
      // A disqualifying ancestor wins outright — IfcOpeningElement is an
      // IfcElement too, so an early `true` on IFCELEMENT would be wrong.
      physical = false;
      break;
    }
    if (upper === PHYSICAL_ROOT) physical = true;
  }

  physicalTypeCache.set(typeName, physical);
  return physical;
}

/** The `entityIndex.byType` shape this module needs — uppercase type -> ids. */
export type EntityIdsByType = ReadonlyMap<string, readonly number[]>;

/**
 * Every physical-object expressId in the loaded model.
 *
 * `entityIndex.byType` holds EVERY parsed entity, including property atoms and
 * geometry primitives, so the type filter is what makes this a count of
 * objects rather than a count of STEP lines.
 */
export function collectPhysicalEntityIds(byType: EntityIdsByType | null | undefined): Set<number> {
  const ids = new Set<number>();
  if (!byType) return ids;
  for (const [typeName, entityIds] of byType) {
    if (!isPhysicalObjectType(typeName)) continue;
    for (const id of entityIds) ids.add(id);
  }
  return ids;
}

/** The visibility filters that decide whether a physical object is on screen. */
export interface VisibilityFilters {
  /** Explicitly hidden ids. */
  hiddenEntities: ReadonlySet<number>;
  /** Isolation set; `null` when no isolation is in force. */
  isolatedEntities: ReadonlySet<number> | null;
  /** Class-level filter from the Class tab; `null` when inactive. */
  classFilter: { ids: ReadonlySet<number> } | null;
  /**
   * X-Ray context: everything NOT in this set renders ghosted. `null` = no
   * ghosting. Ghosted entities are translucent, i.e. still drawn, so this
   * never moves an object from visible to hidden — it only splits the visible
   * count into solid and ghosted.
   */
  ghostExceptEntities?: ReadonlySet<number> | null;
}

export interface PhysicalObjectCounts {
  /** Physical objects present in the loaded model. */
  total: number;
  /** Of those, how many pass every visibility filter. */
  visible: number;
  /** `total - visible`. */
  hidden: number;
  /** Of the visible ones, how many render ghosted (translucent) rather than solid. */
  ghosted: number;
}

/**
 * Count physical objects by visibility.
 *
 * Mirrors the store's own `isEntityVisible` (hidden set, isolation, class
 * filter) so the badge and the renderer cannot disagree about what "visible"
 * means. Isolation is intersected with the physical set rather than used as
 * the count directly: isolating a storey isolates its non-physical children
 * too, and `isolatedEntities.size` would count those.
 */
export function countPhysicalObjects(
  physicalIds: ReadonlySet<number>,
  filters: VisibilityFilters,
): PhysicalObjectCounts {
  const { hiddenEntities, isolatedEntities, classFilter, ghostExceptEntities } = filters;

  let visible = 0;
  let ghosted = 0;
  for (const id of physicalIds) {
    if (hiddenEntities.has(id)) continue;
    if (isolatedEntities !== null && !isolatedEntities.has(id)) continue;
    if (classFilter !== null && !classFilter.ids.has(id)) continue;
    visible++;
    if (ghostExceptEntities != null && !ghostExceptEntities.has(id)) ghosted++;
  }

  const total = physicalIds.size;
  return { total, visible, hidden: total - visible, ghosted };
}
