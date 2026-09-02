/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Owning-`IFCPROJECT` resolution for a multi-project IFC file.
 *
 * Split out of unit-extractor.ts: this module's containment walk is a
 * self-contained concern (spatial-graph traversal) that {@link
 * resolveEntityLengthUnitScale} in unit-extractor.ts composes with unit
 * extraction, but does not itself need any of unit-extractor.ts's unit
 * tables or IFCUNITASSIGNMENT parsing.
 */

import type { EntityRef } from './types.js';
import { RelationshipType } from '@ifc-lite/data';

/** Minimal relationship-graph surface {@link resolveOwningIfcProjectId} needs. */
export interface RelatedLookup {
  getRelated(entityId: number, relType: RelationshipType, direction: 'forward' | 'inverse'): number[];
}

/** Upper bound on the containment walk in {@link resolveOwningIfcProjectId}, so a
 *  malformed file with a containment cycle that the visited-set guard doesn't
 *  catch on its first pass still terminates. Real spatial hierarchies (site →
 *  building → storey → element, occasionally one assembly level deeper) never
 *  come close to this depth. */
const MAX_OWNING_PROJECT_WALK_STEPS = 64;

/**
 * Resolve the express id of the `IFCPROJECT` that owns `expressId`, for files
 * that legitimately contain more than one `IFCPROJECT` — the shape
 * `MergedExporter`'s documented `auto` unit-reconciliation mode produces for
 * a federated merge of differently-unit'd models (see issue #1332). An
 * ordinary IFC file has exactly one `IFCPROJECT` by EXPRESS invariant, so
 * this is a no-op fast path there.
 *
 * `extractLengthUnitScale`/`extractProjectUnits` resolve the file's FIRST
 * `IFCPROJECT` only unless given an explicit `projectId`; every entity
 * belonging to a LATER project in a multi-project file was silently read
 * against the first project's units. Callers needing per-entity correctness
 * (both {@link resolveEntityLengthUnitScale} in unit-extractor.ts and
 * `@ifc-lite/ids`'s area/volume resolution, which needs the project id
 * itself rather than just a length scale) resolve this id first and pass it
 * on to `extractLengthUnitScale`/`extractProjectUnits`'s `projectId`
 * parameter.
 *
 * Walks the entity's real spatial containment up to its own project:
 * `IfcRelContainedInSpatialStructure` (element → structure), then
 * `IfcRelAggregates` (child → parent, repeated to the project), with an
 * `IfcRelDefinesByType` (type → one of the objects it defines) hop for a
 * type entity that has no containment of its own. Containment is tried
 * first since it's the one-hop case for the common "element straight into
 * its storey" shape.
 *
 * @returns The owning project's express id, or `undefined` when the file has
 *   zero or one `IFCPROJECT` (nothing to resolve) or the walk can't reach one
 *   (e.g. a resource-level entity with no containment, a cyclic/malformed
 *   graph). Callers should fall back to the file's default project on
 *   `undefined`, matching prior single-project behaviour.
 */
export function resolveOwningIfcProjectId(
  entityIndex: { byId: { get(expressId: number): EntityRef | undefined }; byType: Map<string, number[]> },
  relationships: RelatedLookup | undefined,
  expressId: number
): number | undefined {
  const projectIds = entityIndex.byType.get('IFCPROJECT') || [];
  if (projectIds.length <= 1) return undefined;
  if (!relationships) return undefined;

  const projectIdSet = new Set(projectIds);
  const visited = new Set<number>();
  let current: number | undefined = expressId;

  for (let step = 0; current !== undefined && step < MAX_OWNING_PROJECT_WALK_STEPS; step++) {
    if (projectIdSet.has(current)) return current;
    if (visited.has(current)) return undefined; // containment cycle
    visited.add(current);

    const containers = relationships.getRelated(current, RelationshipType.ContainsElements, 'inverse');
    if (containers.length > 0) {
      current = containers[0];
      continue;
    }
    const parents = relationships.getRelated(current, RelationshipType.Aggregates, 'inverse');
    if (parents.length > 0) {
      current = parents[0];
      continue;
    }
    // Resource-level entity with no containment of its own (e.g. a type
    // like IfcWallType): hop to an object it defines and keep walking.
    const definedObjects = relationships.getRelated(current, RelationshipType.DefinesByType, 'forward');
    if (definedObjects.length > 0) {
      current = definedObjects[0];
      continue;
    }
    return undefined;
  }
  return undefined;
}
