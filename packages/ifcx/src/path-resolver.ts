/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Path Resolver for Federated IFCX
 *
 * Handles resolution of IFCX paths including:
 * - Direct UUID references: "93791d5d-5beb-437b-b8ec-2f1f0ba4bf3b"
 * - Hierarchical paths: "uuid/ChildName/GrandchildName"
 */

import type { ComposedNode, IfcxNode } from './types.js';
import type { IfcxLayer } from './layer-stack.js';

/**
 * Parsed path components.
 */
export interface ParsedPath {
  /** Root UUID or path segment */
  root: string;
  /** Child path segments (empty for direct UUID) */
  segments: string[];
  /** Whether root looks like a UUID */
  isUuid: boolean;
}

/**
 * Entry in the path index.
 */
export interface PathEntry {
  /** Canonical UUID for this path */
  uuid: string;
  /** All known hierarchical paths to this node */
  hierarchicalPaths: string[];
  /** Layer IDs where this path is defined */
  definedInLayers: string[];
  /** Strongest (lowest index) layer ID */
  primaryLayer: string;
}

/**
 * Index for fast path lookups across layers.
 */
export class PathIndex {
  /** Direct UUID lookup */
  private byUuid = new Map<string, PathEntry>();

  /** Hierarchical path string lookup */
  private byHierarchy = new Map<string, string>(); // hierarchical path -> uuid

  /** Parent UUID -> (child name -> child UUID) */
  private childNameIndex = new Map<string, Map<string, string>>();

  /**
   * Build index from layers.
   */
  buildIndex(layers: IfcxLayer[]): void {
    this.clear();

    // First pass: collect all direct path definitions
    for (const layer of layers) {
      for (const [path, nodes] of layer.nodesByPath) {
        // Skip non-UUID paths for now (they're hierarchical references)
        if (path.includes('/')) continue;

        let entry = this.byUuid.get(path);
        if (!entry) {
          entry = {
            uuid: path,
            hierarchicalPaths: [],
            definedInLayers: [],
            primaryLayer: layer.id,
          };
          this.byUuid.set(path, entry);
        }
        entry.definedInLayers.push(layer.id);

        // Collect children for building hierarchical index
        for (const node of nodes) {
          if (node.children) {
            let childMap = this.childNameIndex.get(path);
            if (!childMap) {
              childMap = new Map();
              this.childNameIndex.set(path, childMap);
            }
            for (const [childName, childPath] of Object.entries(node.children)) {
              if (childPath && typeof childPath === 'string') {
                childMap.set(childName, childPath);
              }
            }
          }
        }
      }
    }

    // Second pass: build hierarchical path index
    this.buildHierarchicalIndex();
  }

  /**
   * Build hierarchical path index by walking children relationships.
   */
  private buildHierarchicalIndex(): void {
    // For each root node, build full hierarchical paths
    for (const [uuid, entry] of this.byUuid) {
      this.indexHierarchicalPaths(uuid, uuid, []);
    }
  }

  /**
   * Recursively index hierarchical paths for a node.
   */
  private indexHierarchicalPaths(
    rootUuid: string,
    currentUuid: string,
    pathSegments: string[]
  ): void {
    const children = this.childNameIndex.get(currentUuid);
    if (!children) return;

    for (const [childName, childUuid] of children) {
      const newSegments = [...pathSegments, childName];
      const hierarchicalPath = `${rootUuid}/${newSegments.join('/')}`;

      // Map hierarchical path to UUID
      this.byHierarchy.set(hierarchicalPath, childUuid);

      // Add to entry's hierarchical paths
      const entry = this.byUuid.get(childUuid);
      if (entry) {
        entry.hierarchicalPaths.push(hierarchicalPath);
      }

      // Recurse
      this.indexHierarchicalPaths(rootUuid, childUuid, newSegments);
    }
  }

  /**
   * Resolve a path to its canonical UUID.
   * Accepts both direct UUIDs and hierarchical paths.
   */
  resolvePath(path: string): string | null {
    // Try direct UUID first
    if (this.byUuid.has(path)) {
      return path;
    }

    // Try hierarchical path
    const resolved = this.byHierarchy.get(path);
    if (resolved) {
      return resolved;
    }

    // Try parsing and walking
    const parsed = parsePath(path);
    if (parsed.segments.length > 0) {
      return this.walkPath(parsed.root, parsed.segments);
    }

    return null;
  }

  /**
   * Walk a path through children relationships.
   */
  private walkPath(root: string, segments: string[]): string | null {
    let current = root;

    for (const segment of segments) {
      const children = this.childNameIndex.get(current);
      if (!children) return null;

      const next = children.get(segment);
      if (!next) return null;

      current = next;
    }

    return current;
  }

  /**
   * Get entry for a UUID.
   */
  getEntry(uuid: string): PathEntry | undefined {
    return this.byUuid.get(uuid);
  }

  /**
   * Get all UUIDs in the index.
   */
  getAllUuids(): string[] {
    return Array.from(this.byUuid.keys());
  }

  /**
   * Get children of a node.
   */
  getChildren(uuid: string): Map<string, string> | undefined {
    return this.childNameIndex.get(uuid);
  }

  /**
   * Check if a path exists.
   */
  hasPath(path: string): boolean {
    return this.resolvePath(path) !== null;
  }

  /**
   * Clear the index.
   */
  clear(): void {
    this.byUuid.clear();
    this.byHierarchy.clear();
    this.childNameIndex.clear();
  }

  /**
   * Get index statistics.
   */
  getStats(): {
    uuidCount: number;
    hierarchicalCount: number;
    childRelationships: number;
  } {
    let childRelationships = 0;
    for (const children of this.childNameIndex.values()) {
      childRelationships += children.size;
    }

    return {
      uuidCount: this.byUuid.size,
      hierarchicalCount: this.byHierarchy.size,
      childRelationships,
    };
  }
}

/**
 * Parse an IFCX path into components.
 *
 * Examples:
 *   "93791d5d-5beb-437b-b8ec-2f1f0ba4bf3b"
 *     -> { root: "93791d5d-...", segments: [], isUuid: true }
 *
 *   "93791d5d-5beb-437b-b8ec-2f1f0ba4bf3b/My_Wall/Window"
 *     -> { root: "93791d5d-...", segments: ["My_Wall", "Window"], isUuid: true }
 */
export function parsePath(path: string): ParsedPath {
  const parts = path.split('/');
  const root = parts[0];
  const segments = parts.slice(1).filter((s) => s.length > 0);

  // UUID pattern (simplified - 8-4-4-4-12 hex)
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(root);

  return {
    root,
    segments,
    isUuid,
  };
}

/**
 * Create a new path index.
 */
export function createPathIndex(): PathIndex {
  return new PathIndex();
}
