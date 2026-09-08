/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Union-find over `0..n-1`, shared by the spatial clustering in `grouping.ts`
 * and the coincident-set components in `duplicate-sets.ts`. Roots are always
 * the lowest index in the set, so the partition it produces does not depend on
 * the order of the unions. Not part of the public package surface.
 */
export function createUnionFind(n: number): { find: (i: number) => number; union: (i: number, j: number) => void } {
  const parent = new Array<number>(n);
  for (let i = 0; i < n; i += 1) {
    parent[i] = i;
  }
  const find = (i: number): number => {
    let root = i;
    while (parent[root] !== root) {
      root = parent[root];
    }
    // Path compression keeps repeated lookups flat; deterministic.
    let cur = i;
    while (parent[cur] !== root) {
      const next = parent[cur];
      parent[cur] = root;
      cur = next;
    }
    return root;
  };
  const union = (i: number, j: number): void => {
    const ri = find(i);
    const rj = find(j);
    if (ri !== rj) {
      // Attach the higher-index root under the lower to keep ids stable.
      if (ri < rj) {
        parent[rj] = ri;
      } else {
        parent[ri] = rj;
      }
    }
  };
  return { find, union };
}
