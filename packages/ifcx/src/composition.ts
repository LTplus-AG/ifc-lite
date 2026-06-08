/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IFCX Composition Engine
 * Flattens ECS-style nodes into a composed tree structure
 */

import type { IfcxFile, IfcxNode, ComposedNode } from './types.js';

interface PreComposedNode {
  path: string;
  children: Record<string, string | null>;
  inherits: Record<string, string | null>;
  attributes: Record<string, unknown>;
}

/**
 * Compose IFCX nodes into a flattened tree structure.
 *
 * Algorithm:
 * 1. Group all nodes by path (multiple nodes can reference same path)
 * 2. Merge attributes (later wins - layer semantics)
 * 3. Resolve inherits references (type-level data)
 * 4. Build parent-child tree from children references
 */
export function composeIfcx(file: IfcxFile): Map<string, ComposedNode> {
  // Phase 1: Group nodes by path
  const nodesByPath = new Map<string, IfcxNode[]>();
  for (const node of file.data) {
    const existing = nodesByPath.get(node.path) || [];
    existing.push(node);
    nodesByPath.set(node.path, existing);
  }

  // Phase 2: Flatten to pre-composition nodes
  const preComposed = new Map<string, PreComposedNode>();
  for (const [path, nodes] of nodesByPath) {
    preComposed.set(path, flattenNodes(path, nodes));
  }

  // Phase 3: Resolve inherits and build tree
  const composed = new Map<string, ComposedNode>();
  for (const [path] of preComposed) {
    if (!composed.has(path)) {
      composeNode(path, preComposed, composed, new Set());
    }
  }

  return composed;
}

/**
 * Flatten multiple nodes with the same path into a single pre-composed node.
 * Later nodes override earlier ones (layer semantics).
 */
function flattenNodes(path: string, nodes: IfcxNode[]): PreComposedNode {
  const result: PreComposedNode = {
    path,
    children: {},
    inherits: {},
    attributes: {},
  };

  // Later nodes override earlier (layer semantics)
  for (const node of nodes) {
    if (node.children) {
      for (const [key, value] of Object.entries(node.children)) {
        if (value === null) {
          // null means remove this child
          delete result.children[key];
        } else {
          result.children[key] = value;
        }
      }
    }
    if (node.inherits) {
      for (const [key, value] of Object.entries(node.inherits)) {
        if (value === null) {
          // null means remove this inheritance
          delete result.inherits[key];
        } else {
          result.inherits[key] = value;
        }
      }
    }
    if (node.attributes) {
      Object.assign(result.attributes, node.attributes);
    }
  }

  return result;
}

/**
 * Compose a single node by resolving its inherits and children.
 */
function composeNode(
  path: string,
  preComposed: Map<string, PreComposedNode>,
  composed: Map<string, ComposedNode>,
  visited: Set<string>
): ComposedNode {
  // Already composed?
  if (composed.has(path)) {
    return composed.get(path)!;
  }

  // Cycle detection: break the cycle gracefully instead of aborting the parse.
  // (Mirrors federated-composition.ts and traversal.ts, which both tolerate cycles.)
  if (visited.has(path)) {
    const stub: ComposedNode = { path, attributes: new Map(), children: new Map() };
    composed.set(path, stub);
    console.warn(`[ifcx] Circular reference detected, breaking cycle at: ${path}`);
    return stub;
  }
  visited.add(path);

  const pre = preComposed.get(path);
  const node: ComposedNode = {
    path,
    attributes: new Map(),
    children: new Map(),
  };

  if (!pre) {
    composed.set(path, node);
    return node;
  }

  // Resolve inherits first (type-level data)
  for (const inheritPath of Object.values(pre.inherits)) {
    if (inheritPath) {
      const inherited = composeNode(inheritPath, preComposed, composed, new Set(visited));
      // Copy inherited attributes (can be overridden)
      for (const [key, value] of inherited.attributes) {
        node.attributes.set(key, value);
      }
      // Copy inherited children
      for (const [key, child] of inherited.children) {
        node.children.set(key, child);
      }
    }
  }

  // Apply own attributes (override inherited)
  for (const [key, value] of Object.entries(pre.attributes)) {
    node.attributes.set(key, value);
  }

  // Resolve children
  for (const [name, childPath] of Object.entries(pre.children)) {
    if (childPath) {
      const child = composeNode(childPath, preComposed, composed, new Set(visited));
      node.children.set(name, child);
    }
  }

  composed.set(path, node);
  return node;
}

/**
 * Find root nodes (nodes with no parent reference).
 */
export function findRoots(composed: Map<string, ComposedNode>): ComposedNode[] {
  const roots: ComposedNode[] = [];
  const childPaths = new Set<string>();

  // Collect all child paths
  for (const node of composed.values()) {
    for (const child of node.children.values()) {
      childPaths.add(child.path);
    }
  }

  // Roots are nodes not referenced as children
  for (const node of composed.values()) {
    if (!childPaths.has(node.path)) {
      roots.push(node);
    }
  }

  return roots;
}

/**
 * Get all descendant nodes of a given node.
 */
export function getDescendants(node: ComposedNode): ComposedNode[] {
  const descendants: ComposedNode[] = [];
  const visited = new Set<string>();

  function traverse(n: ComposedNode): void {
    if (visited.has(n.path)) return;
    visited.add(n.path);

    for (const child of n.children.values()) {
      if (visited.has(child.path)) continue;
      descendants.push(child);
      visited.add(child.path);
      traverse(child);
    }
  }

  traverse(node);
  return descendants;
}
