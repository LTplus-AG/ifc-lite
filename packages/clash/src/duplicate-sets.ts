/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Coincident-set grouping for duplicate results — the reader-facing view over
 * the pairwise `ClashResult` that `findDuplicates` produces. Split out of
 * `grouping.ts` (which owns the generic BCF-topic groupings) to keep both
 * under the ~400-line module limit; re-exported through the package index.
 */

import { DUPLICATES_RULE } from './duplicates.js';
import { qualifiedKey } from './exclude.js';
import { makeGroup, sortGroups } from './grouping.js';
import { createUnionFind } from './union-find.js';
import type { Clash, ClashElementRef, ClashGroup, ClashResult } from './types.js';

/**
 * Group a duplicate result into coincident **sets** — one finding per set of
 * objects occupying the same place, rather than one per pair.
 *
 * `findDuplicates` reports pairwise. N coincident copies of one object therefore
 * produce N(N−1)/2 rows and each copy is named in N−1 of them, so three
 * triplicated columns read as nine findings with every object mentioned twice.
 * No row is literally repeated, but the list badly overstates the problem.
 *
 * The partition here is the **connected components of the pair graph**: every
 * reported clash is an edge between two model-qualified elements, and each
 * component is one "these N objects are coincident" finding. Unlike
 * `groupClashes({ by: 'cluster' })` this needs no epsilon and cannot fuse two
 * unrelated duplicate sets that merely stand within a cluster radius of each
 * other — it uses only the pairs the detector actually reported.
 *
 * Two properties worth stating plainly:
 *
 * - **Transitivity is approximated, knowingly.** A≈B and B≈C under
 *   `positionTolerance` (the default corner-distance gate) does not imply A≈C,
 *   yet connected components put all three in one
 *   set. We accept that: a chain of near-coincident objects is a single
 *   coordination issue, and the strict alternative (maximal cliques) is
 *   exponential and would put the same object back into several findings —
 *   the exact complaint this grouping exists to answer.
 * - **Sets may span models.** Identity is `(model, key, ref)`, so the same
 *   object delivered in two files groups correctly, and two files that happen to
 *   reuse a key for different objects do not. `ref` is in there because a key
 *   can repeat *within* one model too — a file with duplicated GlobalIds, which
 *   is exactly the defect a duplicate hunt is looking for; on `(model, key)`
 *   alone those two elements collapsed into one node and the set they form
 *   counted "1 coincident object". Adding `ref` only ever splits nodes, never
 *   merges them.
 *
 * Components are computed per `rule`, so a mixed result never fuses a duplicate
 * pair with a discipline clash — and only components of the `duplicates` rule
 * are titled "coincident". Any other rule's component is titled as connected
 * clashes, which is all its pair graph proves: those members intersect, they
 * do not occupy the same place. Severity is the most severe member severity: a
 * set containing any exact-duplicate (`major`) pair surfaces as `major`.
 *
 * `ClashResult` is untouched — the panel, grouping modes and BCF export keep
 * consuming the pairwise shape; this is a reporting view over it.
 */
export function groupDuplicateSets(result: ClashResult): ClashGroup[] {
  const byRule = new Map<string, Clash[]>();
  for (const clash of result.clashes) {
    const bucket = byRule.get(clash.rule);
    if (bucket) {
      bucket.push(clash);
    } else {
      byRule.set(clash.rule, [clash]);
    }
  }

  const groups: ClashGroup[] = [];

  for (const bucket of byRule.values()) {
    // Number the participating elements in first-seen order; every clash is one
    // edge between two of those nodes.
    const nodeOf = new Map<string, number>();
    const idOf = (ref: ClashElementRef): number => {
      const k = `${qualifiedKey(ref.model, ref.key)}#${ref.ref}`;
      const existing = nodeOf.get(k);
      if (existing !== undefined) return existing;
      const assigned = nodeOf.size;
      nodeOf.set(k, assigned);
      return assigned;
    };
    const edges = bucket.map((clash) => [idOf(clash.a), idOf(clash.b)] as const);

    const { find, union } = createUnionFind(nodeOf.size);
    for (const [a, b] of edges) {
      union(a, b);
    }

    // Collect each component's member clashes and its distinct element count —
    // the latter is what the reader cares about ("these 3 objects are the same"),
    // and it is NOT the member count once a set grows past a pair.
    const components = new Map<number, { members: Clash[]; nodes: Set<number>; tags: Set<string> }>();
    for (let i = 0; i < bucket.length; i += 1) {
      const clash = bucket[i];
      const root = find(edges[i][0]);
      let comp = components.get(root);
      if (!comp) {
        comp = { members: [], nodes: new Set(), tags: new Set() };
        components.set(root, comp);
      }
      comp.members.push(clash);
      comp.nodes.add(edges[i][0]);
      comp.nodes.add(edges[i][1]);
      comp.tags.add(clash.a.tag);
      comp.tags.add(clash.b.tag);
    }

    for (const comp of components.values()) {
      const count = comp.nodes.size;
      const tag = comp.tags.size === 1 ? `${[...comp.tags][0]} ` : '';
      const members = [...comp.members].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      // "Coincident" is a statement the `duplicates` rule actually made. For
      // any other rule the members of a component merely clash transitively —
      // intersecting-but-distinct elements — so the title must not upgrade
      // that to coincidence (#2530 review: an SDK caller passing a discipline
      // result here would otherwise get "7 coincident IfcPipeSegment objects").
      const rule = comp.members[0].rule;
      const title = rule === DUPLICATES_RULE.id
        ? `${count} coincident ${tag}objects`
        : `${count} ${tag}objects in connected ${rule} clashes`;
      groups.push(makeGroup(members, title, undefined, 'duplicate-set'));
    }
  }

  return sortGroups(groups);
}
