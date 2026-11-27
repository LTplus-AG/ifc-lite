// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Backward closure over the spatial-structure relations, for `buildSubset`'s
 * context-root seeding (#4124).
 *
 * `buildSubset` used to force-keep every `IfcProject` / `IfcSite` /
 * `IfcBuilding` / `IfcBuildingStorey` as a context root, unconditionally. That
 * both keeps every storey whether or not anything selected sits under it, AND
 * never keeps an `IfcSpace` / `IfcSpatialZone` / IFC4X3 facility class, so a
 * product contained in one of those has an unkept `RelatingStructure` and
 * loses its containment relation (the same orphaning symptom #4113 fixed for
 * storeys, from a different cause).
 *
 * The fix is a BACKWARD closure: from each id already kept, climb
 * `IfcRelContainedInSpatialStructure` / `IfcRelReferencedInSpatialStructure` to
 * its `RelatingStructure`, and `IfcRelAggregates` to its `RelatingObject`,
 * transitively, up to `IfcProject`. That keeps exactly the ancestors of what
 * was actually selected, and needs no type list at all.
 */
import { IfcTypeEnumFromString, isSpatialStructureType } from '@ifc-lite/data';
import { slotRef } from './schema-converter-structural-source.js';
import { withoutComments } from './step-comment-skip.js';
import {
  splitTopLevelArgs,
  STRUCTURE_RELATIONS,
  STRUCTURE_RELATION_ATTRS,
  type StepRecord,
} from './step-subset-relations.js';

/**
 * Related-child id → its relating-parent id(s), across the three structure
 * relation types.
 *
 * `IfcRelAggregates` ALSO expresses plain element decomposition (an
 * `IfcElementAssembly` and its parts), which reuses this same relation type
 * and six-attribute shape but is not a spatial ancestor: keeping the whole
 * assembly because one of its parts was independently selected is a different
 * bug, not this one (`step-subset.test.ts` pins the opposite behaviour).
 * A row is only added for this table when the relating object's OWN type is a
 * spatial-structure type, so a decomposition parent can never enter it.
 *
 * Silently skips a record `splitTopLevelArgs` cannot read cleanly, or that
 * does not split into the six attributes every one of these types has: this
 * map only ever ADDS candidate ancestors for `buildSubset` to keep, so
 * skipping is the fail-closed direction, unlike `step-subset-relations.ts`'s own
 * keep-whole-or-drop-whole fallback for the same shape.
 */
export function structureParents(
  instances: ReadonlyMap<number, StepRecord>,
  relations: ReadonlySet<string> = new Set(Object.keys(STRUCTURE_RELATIONS)),
): Map<number, number[]> {
  const parents = new Map<number, number[]>();
  for (const inst of instances.values()) {
    const slots = STRUCTURE_RELATIONS[inst.type];
    if (slots === undefined || !relations.has(inst.type)) continue;
    const [relatingIdx, relatedIdx] = slots;
    const args = splitTopLevelArgs(inst.body);
    if (args === null || args.length !== STRUCTURE_RELATION_ATTRS) continue;
    // Comments around a reference are trivia (slotRef / withoutComments).
    const parentId = slotRef(args[relatingIdx]);
    if (parentId === null) continue;
    if (inst.type === 'IFCRELAGGREGATES') {
      const parentType = IfcTypeEnumFromString(instances.get(parentId)?.type ?? '');
      if (!isSpatialStructureType(parentType)) continue;
    }
    const setText = withoutComments(args[relatedIdx]);
    if (!setText.startsWith('(') || !setText.endsWith(')')) continue;
    const members = splitTopLevelArgs(setText.slice(1, -1));
    if (members === null) continue;
    for (const member of members) {
      const childId = slotRef(member);
      if (childId === null) continue;
      const existing = parents.get(childId);
      if (existing) existing.push(parentId);
      else parents.set(childId, [parentId]);
    }
  }
  return parents;
}

/**
 * Every ancestor of `seeds`, reached by climbing {@link structureParents}
 * transitively. Order is unspecified; callers forward-close the result.
 */
export function spatialAncestors(seeds: Iterable<number>, instances: ReadonlyMap<number, StepRecord>): number[] {
  const parents = structureParents(instances);
  const visited = new Set<number>();
  const ancestors: number[] = [];
  const stack = [...seeds];
  while (stack.length) {
    const id = stack.pop()!;
    for (const parentId of parents.get(id) ?? []) {
      if (visited.has(parentId)) continue;
      visited.add(parentId);
      ancestors.push(parentId);
      stack.push(parentId);
    }
  }
  return ancestors;
}
