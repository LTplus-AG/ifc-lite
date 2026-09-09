/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Canonical-parent resolution for `SpatialHierarchyBuilder` (split out to stay
 * under the module-size budget, #4095).
 */

import type { EntityTable, RelationshipGraph } from '@ifc-lite/data';
import { IfcTypeEnum, RelationshipType, createLogger, isSpatialStructureType } from '@ifc-lite/data';

const log = createLogger('SpatialHierarchy');

/**
 * Is `candidateParent` reachable from `childId` by walking forward
 * `IfcRelAggregates` edges (i.e. is `childId` an ANCESTOR of `candidateParent`
 * in the raw, unresolved aggregation graph)? Used only to disqualify a tied
 * candidate parent that would close a cycle back through the child itself -
 * see the doc comment on `computeCanonicalParent` for why that specific shape
 * needs a check at all. Bounded to `childId`'s own (raw) aggregation
 * subtree, so it only costs anything on an already-malformed file where a
 * child has more than one candidate Aggregates parent - the common case
 * (one candidate) never calls this.
 */
function formsCycleThroughChild(
  childId: number,
  candidateParent: number,
  relationships: RelationshipGraph,
): boolean {
  const visited = new Set<number>([childId]);
  const stack: number[] = [childId];
  while (stack.length > 0) {
    const current = stack.pop() as number;
    for (const kid of relationships.getRelated(current, RelationshipType.Aggregates, 'forward')) {
      if (kid === candidateParent) return true;
      if (!visited.has(kid)) {
        visited.add(kid);
        stack.push(kid);
      }
    }
  }
  return false;
}

/**
 * Resolve each spatial-structure entity's ONE canonical parent, globally,
 * before any recursion starts - so the result cannot depend on traversal
 * order. Mirrors apps/server's `canonical_parent` (`spatial.rs`, #3973):
 *
 *  1. IfcRelAggregates always wins over mere containment. A child aggregated
 *     by more than one parent (a malformed file) resolves to the parent
 *     whose `IfcRelAggregates` was declared FIRST in the file - STEP does
 *     not require express ids to ascend with declaration position, so a
 *     lowest-express-id tie-break can disagree with declaration order (a
 *     legally-valid file can declare a high-id relationship before a
 *     low-id one). `relationships.inverse.getEdges` returns edges in
 *     declaration order: `RelationshipGraphBuilder.addEdge` is called by
 *     the parser while it scans `IfcRel*` records in file/byte order (see
 *     `columnar-parser.ts`'s relationship loop), and `buildCSR`'s counting
 *     sort is stable per key (`relationship-graph.ts`) - it scatters edges
 *     for the same child in the order they were appended, never
 *     reordering by id. So `edges[0]` for a given child is the
 *     first-declared parent edge; no id comparison is needed or correct -
 *     EXCEPT that a candidate closing a cycle back through the child is
 *     skipped first (see `formsCycleThroughChild`, #4246): a mutual or
 *     longer aggregation back-edge cannot win a tie against a candidate that
 *     doesn't orphan the child's own subtree from itself. Each time that
 *     happens, a warning is logged (always-visible, like the existing
 *     "No storeys/buildings found" warnings below) naming the child and the
 *     disqualified candidate - the only signal a caller gets that a
 *     malformed back-edge was found and repaired, short of building a
 *     dedicated report (out of scope here; see the #4208 semantic drop
 *     census for that shape of reporting - a different layer: per-STEP-class
 *     scan/retain counts collected during columnar categorization, not a
 *     graph-repair event like this one).
 *  2. Only when a child has NO aggregates edge at all does a containment edge
 *     (IfcRelContainedInSpatialStructure targeting a spatial-structure type -
 *     the Revit Family/Dynamo `IfcSpace`/`IfcSpatialZone` pattern, #1075)
 *     get to claim it, with the same first-declared tie-break.
 *
 * `SpatialHierarchyBuilder.buildNode`'s `addSpatialChild` then only recurses
 * into a child from its canonical parent - every other parent that also
 * names the child drops the edge instead of adding an empty-stub duplicate
 * (#4095).
 */
export function computeCanonicalParent(entities: EntityTable, relationships: RelationshipGraph): Map<number, number> {
  const canonicalParent = new Map<number, number>();

  const claimFirstDeclaredParent = (
    predicate: (childId: number) => boolean,
    relType: RelationshipType,
  ): void => {
    for (const childId of relationships.inverse.offsets.keys()) {
      if (canonicalParent.has(childId) || !predicate(childId)) continue;
      const edges = relationships.inverse.getEdges(childId, relType);
      if (edges.length === 0) continue;
      // `edges[0]` is the first-declared edge of this type for this child -
      // see the doc comment above for why the CSR preserves declaration
      // order here. This mirrors apps/server's `canonical_parent`
      // (`spatial.rs`), which does `entry(...).or_insert(...)` while
      // iterating relationships in file-scan order: first occurrence wins.
      let winner = edges[0];
      if (relType === RelationshipType.Aggregates && edges.length > 1) {
        // A child named as the target of more than one IfcRelAggregates is
        // already a malformed file, but one shape needs a special rule: a
        // BACK-EDGE, where a candidate parent P is itself a (possibly
        // indirect) AGGREGATED DESCENDANT of this very child - i.e. taking P
        // as childId's parent would close a cycle back through childId. That
        // is the STEP-authoring-tool mistake of declaring an aggregation
        // pair in both directions (#4246, the direct 2-node case; the same
        // shape generalizes to a longer A->B->C->A chain). If the back-edge
        // is declared before the real parent edge, plain first-declared-wins
        // picks P as childId's canonical parent; P's own resolution (walking
        // the SAME cycle) then independently lands back on a node inside the
        // cycle too, so the whole cycle points at itself and none of it is
        // reachable from IfcProject - orphaning whatever real subtree hung
        // off any node in the cycle.
        //
        // Skip any candidate edge that closes a cycle through childId and
        // take the first REMAINING candidate, still by declaration order -
        // this changes nothing when a child has only one candidate (the
        // overwhelmingly common case) or when none of its candidates close a
        // cycle (the genuine multiple-real-parents case, #4095, which this
        // loop never even sees more than one Aggregates edge for - #4095's
        // contested child has exactly one Aggregates edge naming it; its
        // OTHER "parent" only contains it). If EVERY candidate closes a
        // cycle (a more degenerate file than anything observed), fall
        // through to plain first-declared so the child is never left
        // without a parent.
        const nonCyclic = edges.find((edge) => !formsCycleThroughChild(childId, edge.target, relationships));
        if (nonCyclic && nonCyclic !== winner) {
          log.warn(
            `Ignored an aggregation back-edge cycle: #${childId} kept parent #${nonCyclic.target}, ` +
              `not the first-declared #${winner.target} (which would have closed a cycle back through #${childId})`,
          );
          winner = nonCyclic;
        }
      }
      // Inverse edges flip source/target, so `target` here is the original
      // relationship's `relating_id` (the parent).
      canonicalParent.set(childId, winner.target);
    }
  };

  // Pass 1: aggregation, unconditionally - it always wins.
  claimFirstDeclaredParent(() => true, RelationshipType.Aggregates);
  // Pass 2: promotion-by-containment, only for children aggregation left unclaimed.
  claimFirstDeclaredParent(
    (childId) => {
      const childType = entities.getTypeEnum(childId);
      return isSpatialStructureType(childType) && childType !== IfcTypeEnum.IfcProject;
    },
    RelationshipType.ContainsElements,
  );

  return canonicalParent;
}
