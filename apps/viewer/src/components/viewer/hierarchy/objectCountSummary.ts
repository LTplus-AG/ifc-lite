/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * "How many objects are here?" — the one number the hierarchy browser puts on
 * a spatial row, and the breakdown that explains it on hover.
 *
 * ## What the headline counts
 *
 * A physical object THAT HAS A SHAPE. Two conditions, and both are needed:
 *
 * - The schema test, `isPhysicalObjectType` in `lib/physical-objects.ts` —
 *   `IfcElement` minus feature and virtual elements. That single definition is
 *   reused, never restated here, because a second copy is how two counts come
 *   to disagree. It excludes groups, zones, systems, spatial containers and
 *   annotations by inheritance rather than by a hand-maintained list.
 * - The shape test, membership of the streamed mesh set. `IfcAnnotation` shows
 *   that geometry alone is not enough (a dimension line has a representation
 *   and is not a building object); a placement-only `IfcBuildingElementProxy`
 *   shows that the schema alone is not enough either (an object by class that
 *   cannot be seen, isolated, measured or exported).
 *
 * ## Before any geometry has streamed
 *
 * The shape test is unanswerable — nothing can be known to be meshless yet, so
 * the count is every physical object and `geometryKnown` is false. The caller
 * says so on hover rather than presenting a provisional number as final. The
 * count then only narrows as meshes arrive; it never jumps around, and it never
 * passes a group or a container at any point in the load.
 *
 * ## What the breakdown lines are for
 *
 * `withoutGeometry` is a model-quality signal, not a disclaimer: an element
 * with a placement and no representation is usually an export defect, and it is
 * invisible today. `spacesNotCounted` makes a deliberate decision visible — a
 * space is a spatial element, so neither it nor its contents roll up into a
 * storey's object count; the storey counts what it directly contains. Both
 * numbers are reported only when non-zero, so the line appearing is itself the
 * signal.
 */

import { isPhysicalObjectType } from '@/lib/physical-objects';

export interface ObjectCountSummary {
  /** The headline: physical objects that have a shape. */
  counted: number;
  /** Rows the container lists when expanded — everything it contains. */
  rows: number;
  /** Counted objects by IFC class, descending, so the hover can name the mix. */
  typeCounts: Array<[string, number]>;
  /** Physical objects with no shape at all — an export defect, usually. */
  withoutGeometry: number;
  /** Space-like children deliberately left out of the count. */
  spacesNotCounted: number;
  /** False while geometry is still streaming, when the shape test cannot run. */
  geometryKnown: boolean;
}

export const EMPTY_OBJECT_COUNT: ObjectCountSummary = {
  counted: 0,
  rows: 0,
  typeCounts: [],
  withoutGeometry: 0,
  spacesNotCounted: 0,
  geometryKnown: true,
};

/**
 * Summarise one container's directly contained entities.
 *
 * `hasShape` is `null` while no geometry has streamed — the caller's way of
 * saying the shape test cannot be run yet, which is different from saying
 * every entity failed it.
 */
export function summarizeObjects(
  ids: readonly number[],
  getTypeName: (id: number) => string | undefined,
  hasShape: ((id: number) => boolean) | null,
  spacesNotCounted = 0,
): ObjectCountSummary {
  const byType = new Map<string, number>();
  let counted = 0;
  let withoutGeometry = 0;

  for (const id of ids) {
    const typeName = getTypeName(id);
    if (!typeName || !isPhysicalObjectType(typeName)) continue;
    if (hasShape !== null && !hasShape(id)) {
      withoutGeometry++;
      continue;
    }
    counted++;
    byType.set(typeName, (byType.get(typeName) ?? 0) + 1);
  }

  const typeCounts = [...byType.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return {
    counted,
    rows: ids.length,
    typeCounts,
    withoutGeometry,
    spacesNotCounted,
    geometryKnown: hasShape !== null,
  };
}

/** Add `b` into `a`, for a unified storey spanning federated models. */
export function mergeObjectCounts(a: ObjectCountSummary, b: ObjectCountSummary): ObjectCountSummary {
  const byType = new Map<string, number>(a.typeCounts);
  for (const [type, n] of b.typeCounts) byType.set(type, (byType.get(type) ?? 0) + n);
  return {
    counted: a.counted + b.counted,
    rows: a.rows + b.rows,
    typeCounts: [...byType.entries()].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0])),
    withoutGeometry: a.withoutGeometry + b.withoutGeometry,
    spacesNotCounted: a.spacesNotCounted + b.spacesNotCounted,
    // One model still streaming makes the whole total provisional.
    geometryKnown: a.geometryKnown && b.geometryKnown,
  };
}
