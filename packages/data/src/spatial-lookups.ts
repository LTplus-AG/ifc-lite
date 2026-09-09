/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { SpatialNode } from './types.js';

/** Live lookup closures shared by parsed, worker-hydrated and server hierarchies. */
export function spatialLookups(project: SpatialNode, bySpace: ReadonlyMap<number, number[]>,
  elementToContainer?: ReadonlyMap<number, number>) {
  return {
    getContainingSpace(elementId: number): number | null {
      if (elementToContainer) {
        const container = elementToContainer.get(elementId);
        return container !== undefined && bySpace.has(container) ? container : null;
      }
      // Older transport payloads lack the reverse index; consult live lists.
      for (const [id, elements] of bySpace) if (elements.includes(elementId)) return id;
      return null;
    },
    getPath(elementId: number): SpatialNode[] {
      const pending = [{ node: project, parent: -1 }];
      const visited = new Set<SpatialNode>();
      const stack = [0];
      while (stack.length) {
        const index = stack.pop()!;
        const { node } = pending[index];
        if (visited.has(node)) continue;
        visited.add(node);
        if (node.expressId === elementId || node.elements.includes(elementId)) {
          const path: SpatialNode[] = [];
          for (let cursor = index; cursor >= 0; cursor = pending[cursor].parent) path.push(pending[cursor].node);
          return path.reverse();
        }
        for (let child = node.children.length - 1; child >= 0; child--) {
          stack.push(pending.length);
          pending.push({ node: node.children[child], parent: index });
        }
      }
      return [];
    },
  };
}
