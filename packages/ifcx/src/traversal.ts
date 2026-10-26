/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ComposedNode } from './types.js';

export interface TraversalFrame {
  node: ComposedNode;
  parent: TraversalFrame | null;
  edgeName: string | null;
  depth: number;
}

export function findTraversalRoots(composed: Map<string, ComposedNode>): ComposedNode[] {
  const childPaths = new Set<string>();
  for (const node of composed.values()) {
    for (const child of node.children.values()) {
      childPaths.add(child.path);
    }
  }

  return [...composed.values()].filter((node) => !childPaths.has(node.path));
}

export function findTraversalSeeds(composed: Map<string, ComposedNode>): ComposedNode[] {
  const seeds: ComposedNode[] = [];
  const reachable = new Set<string>();
  const roots = findTraversalRoots(composed);

  for (const root of roots) {
    seeds.push(root);
    markReachable(root, reachable, new Set([root.path]));
  }

  for (const node of composed.values()) {
    if (reachable.has(node.path)) continue;
    seeds.push(node);
    markReachable(node, reachable, new Set([node.path]));
  }

  return seeds;
}

export function walkComposedFrames(
  composed: Map<string, ComposedNode>,
  visit: (frame: TraversalFrame) => void
): void {
  for (const seed of findTraversalSeeds(composed)) {
    traverse(seed, null, null, new Set([seed.path]), visit);
  }
}

export function getFrameLineage(frame: TraversalFrame): TraversalFrame[] {
  const lineage: TraversalFrame[] = [];
  let current: TraversalFrame | null = frame;
  while (current) {
    lineage.unshift(current);
    current = current.parent;
  }
  return lineage;
}

export function getNodeLineage(frame: TraversalFrame): ComposedNode[] {
  return getFrameLineage(frame).map((entry) => entry.node);
}

export function collectIncomingEdgeNames(composed: Map<string, ComposedNode>): Map<string, string[]> {
  const incomingNames = new Map<string, string[]>();

  for (const node of composed.values()) {
    for (const [edgeName, child] of node.children) {
      const names = incomingNames.get(child.path) ?? [];
      if (!names.includes(edgeName)) {
        names.push(edgeName);
      }
      incomingNames.set(child.path, names);
    }
  }

  return incomingNames;
}

/**
 * For each node, the edge names of every sibling under every parent that holds it (its own included). A
 * generator that must keep sibling edge names unique appends `_001` to the second `Window`; this is what lets
 * the name reader tell that suffix from a name that really ends in digits.
 */
export function collectSiblingEdgeNames(composed: Map<string, ComposedNode>): Map<string, Set<string>> {
  const siblings = new Map<string, Set<string>>();
  for (const node of composed.values()) {
    const names = new Set(node.children.keys());
    for (const child of node.children.values()) {
      const set = siblings.get(child.path) ?? new Set<string>();
      for (const name of names) set.add(name);
      siblings.set(child.path, set);
    }
  }
  return siblings;
}

export function buildReachableAttributeIndex(
  composed: Map<string, ComposedNode>,
  attributeKey: string
): Map<string, boolean> {
  const memo = new Map<string, boolean>();
  const visiting = new Set<string>();

  const hasAttributeInReachableSubtree = (node: ComposedNode): boolean => {
    const cached = memo.get(node.path);
    if (cached !== undefined) return cached;
    if (visiting.has(node.path)) return false;

    visiting.add(node.path);
    let result = node.attributes.has(attributeKey);

    if (!result) {
      for (const child of node.children.values()) {
        if (hasAttributeInReachableSubtree(child)) {
          result = true;
          break;
        }
      }
    }

    visiting.delete(node.path);
    memo.set(node.path, result);
    return result;
  };

  for (const node of composed.values()) {
    hasAttributeInReachableSubtree(node);
  }

  return memo;
}

function markReachable(
  node: ComposedNode,
  reachable: Set<string>,
  path: Set<string>
): void {
  if (reachable.has(node.path)) return;
  reachable.add(node.path);

  for (const child of node.children.values()) {
    if (path.has(child.path)) continue;
    const childPath = new Set(path);
    childPath.add(child.path);
    markReachable(child, reachable, childPath);
  }
}

function traverse(
  node: ComposedNode,
  parent: TraversalFrame | null,
  edgeName: string | null,
  path: Set<string>,
  visit: (frame: TraversalFrame) => void
): void {
  const frame: TraversalFrame = {
    node,
    parent,
    edgeName,
    depth: parent ? parent.depth + 1 : 0,
  };

  visit(frame);

  for (const [childEdgeName, child] of node.children) {
    if (path.has(child.path)) continue;
    const childPath = new Set(path);
    childPath.add(child.path);
    traverse(child, frame, childEdgeName, childPath, visit);
  }
}
