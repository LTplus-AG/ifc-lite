/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Tarjan strongly-connected components over the local call graph. A function
 * is part of a recursion cycle when its SCC has more than one member, or when
 * it calls itself directly.
 *
 * SCCs rather than the pairwise DFS `findRecursiveFunctions` uses, because the
 * gate needs the cycle's MEMBERSHIP, not just a yes/no: the guard for a mutual
 * recursion routinely lives in a different member than the decode call.
 * `processors/boolean/mod.rs` is the measured case -- `process_with_depth_inner`
 * holds `if depth > MAX_BOOLEAN_DEPTH` and the `visited` insert, while
 * `process_operand_with_depth` holds the `decode_by_id`. Scoping the guard
 * search to one function at a time reports both halves as unguarded.
 *
 * @param {Map<string, Set<string>>} graph
 * @returns {Map<string, string[]>} function name -> the members of its cycle,
 *   for cycle members only. Non-recursive functions are absent.
 */
export function findRecursionCycles(graph) {
  let index = 0;
  const idx = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  /** @type {string[][]} */
  const components = [];

  // Iterative Tarjan: a recursive one would itself stack-overflow on a deep
  // call graph, which would be a poor look for this particular check.
  for (const root of graph.keys()) {
    if (idx.has(root)) continue;
    /** @type {Array<{ node: string, iter: Iterator<string> }>} */
    const work = [{ node: root, iter: (graph.get(root) ?? new Set()).values() }];
    idx.set(root, index);
    low.set(root, index);
    index++;
    stack.push(root);
    onStack.add(root);
    while (work.length) {
      const frame = work[work.length - 1];
      const next = frame.iter.next();
      if (!next.done) {
        const w = next.value;
        if (!idx.has(w)) {
          idx.set(w, index);
          low.set(w, index);
          index++;
          stack.push(w);
          onStack.add(w);
          work.push({ node: w, iter: (graph.get(w) ?? new Set()).values() });
        } else if (onStack.has(w)) {
          low.set(frame.node, Math.min(low.get(frame.node), idx.get(w)));
        }
        continue;
      }
      work.pop();
      const v = frame.node;
      if (work.length) {
        const parent = work[work.length - 1].node;
        low.set(parent, Math.min(low.get(parent), low.get(v)));
      }
      if (low.get(v) === idx.get(v)) {
        const component = [];
        for (;;) {
          const w = stack.pop();
          onStack.delete(w);
          component.push(w);
          if (w === v) break;
        }
        components.push(component);
      }
    }
  }

  const cycles = new Map();
  for (const component of components) {
    const isCycle = component.length > 1 || (graph.get(component[0])?.has(component[0]) ?? false);
    if (!isCycle) continue;
    for (const name of component) cycles.set(name, component);
  }
  return cycles;
}

