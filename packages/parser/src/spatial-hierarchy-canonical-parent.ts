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
/**
 * Upper bound on aggregate-graph node visits spent on back-edge cycle checks
 * for one file. The check only runs for children named by MORE THAN ONE
 * IfcRelAggregates (already malformed), and costs one descendant walk per
 * such child - O(V+E) each - so a crafted file with thousands of contested
 * children could otherwise burn O(C·(V+E)). Past the budget the resolver
 * falls back to plain first-declared-wins (the pre-#4285 behaviour) and says
 * so once, instead of stalling the parse.
 */
export const CYCLE_CHECK_VISIT_BUDGET = 2_000_000;

/**
 * Aggregated descendants of `childId` (transitive, forward `Aggregates`),
 * charged against `budget`. Returns null when the budget ran out mid-walk
 * (the partial set must not be used - a missing descendant reads as "no
 * cycle", which is the wrong side to err on).
 */
function aggregatedDescendants(
  childId: number,
  relationships: RelationshipGraph,
  budget: { visits: number },
): Set<number> | null {
  const visited = new Set<number>([childId]);
  const stack: number[] = [childId];
  while (stack.length > 0) {
    const current = stack.pop() as number;
    for (const kid of relationships.getRelated(current, RelationshipType.Aggregates, 'forward')) {
      if (--budget.visits < 0) return null;
      if (!visited.has(kid)) {
        visited.add(kid);
        stack.push(kid);
      }
    }
  }
  return visited;
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
 *     skipped first (see `aggregatedDescendants`, #4246): a mutual or
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
export function computeCanonicalParent(
  entities: EntityTable,
  relationships: RelationshipGraph,
  options: { cycleCheckVisitBudget?: number } = {},
): Map<number, number> {
  const canonicalParent = new Map<number, number>();
  const visitBudget = options.cycleCheckVisitBudget ?? CYCLE_CHECK_VISIT_BUDGET;
  const cycleBudget = { visits: visitBudget };
  let cycleBudgetExhausted = false;

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
        //
        // One descendant walk per contested child (not per candidate), under a
        // file-wide visit budget - see CYCLE_CHECK_VISIT_BUDGET.
        const descendants = cycleBudgetExhausted ? null : aggregatedDescendants(childId, relationships, cycleBudget);
        if (descendants === null) {
          if (!cycleBudgetExhausted) {
            cycleBudgetExhausted = true;
            log.warn(
              `Aggregation back-edge cycle checks stopped after ${visitBudget} graph visits; ` +
                'remaining multi-parent children resolve to their first-declared IfcRelAggregates edge',
            );
          }
        } else {
          const rejected: number[] = [];
          const nonCyclic = edges.find((edge) => {
            const cyclic = descendants.has(edge.target);
            if (cyclic) rejected.push(edge.target);
            return !cyclic;
          });
          if (nonCyclic && nonCyclic !== winner) {
            log.warn(
              `Ignored ${rejected.length} aggregation back-edge cycle(s): #${childId} kept parent #${nonCyclic.target}, ` +
                `not ${rejected.map((id) => `#${id}`).join(', ')} (each would have closed a cycle back through #${childId})`,
            );
            winner = nonCyclic;
          }
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

/**
 * Which spatial-structure nodes will `SpatialHierarchyBuilder.buildNode`
 * actually visit, starting from `projectId`? Mirrors `addSpatialChild`
 * exactly: a node is visited iff it is `projectId` itself, or its
 * `canonicalParent` entry points to an already-visited node - the same
 * check `addSpatialChild` makes before recursing (`canonicalParent.get
 * (childId) === expressId`). Computed as one forward walk over
 * `canonicalParent` (childId -> parentId) up front, so a storey's
 * reachability never depends on where in the traversal it happens to sit
 * (#4310): a node named only by an unreachable storey - one with no path
 * back to `projectId`, e.g. a malformed file where a storey has no
 * `IfcRelAggregates` edge at all - is never in this set, exactly as
 * `buildNode` would never recurse into it.
 */
export function computeReachableSpatialNodes(
  projectId: number,
  canonicalParent: Map<number, number>,
): Set<number> {
  const childrenOf = new Map<number, number[]>();
  for (const [childId, parentId] of canonicalParent) {
    let siblings = childrenOf.get(parentId);
    if (!siblings) {
      siblings = [];
      childrenOf.set(parentId, siblings);
    }
    siblings.push(childId);
  }

  const reachable = new Set<number>([projectId]);
  const stack: number[] = [projectId];
  while (stack.length > 0) {
    const current = stack.pop() as number;
    for (const childId of childrenOf.get(current) ?? []) {
      if (reachable.has(childId)) continue; // also guards a canonicalParent cycle from looping forever
      reachable.add(childId);
      stack.push(childId);
    }
  }
  return reachable;
}
