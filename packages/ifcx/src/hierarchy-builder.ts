/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Hierarchy Builder for IFCX
 * Builds spatial hierarchy from composed nodes
 */

import type { ComposedNode, IfcClass } from './types.js';
import { ATTR, SPATIAL_TYPES } from './types.js';
import { nodeName } from './names.js';
import { collectIncomingEdgeNames, collectSiblingEdgeNames } from './traversal.js';
import { IDENTITY, worldMatrix, worldZ, type Matrix4 } from './placement.js';
import { IfcTypeEnum, IfcTypeEnumFromString, findStoreyByElevation } from '@ifc-lite/data';
import type { SpatialHierarchy, SpatialNode } from '@ifc-lite/data';

/**
 * Build spatial hierarchy from composed IFCX nodes.
 *
 * IFCX hierarchy comes from children relationships:
 * - Project -> Site -> Building -> Storey -> Elements
 *
 * We identify spatial structure elements by their bsi::ifc::class codes.
 */
export function buildHierarchy(
  composed: Map<string, ComposedNode>,
  pathToId: Map<string, number>
): SpatialHierarchy {
  // Find project root
  const projectNode = findProjectRoot(composed);
  if (!projectNode) {
    return createEmptyHierarchy();
  }

  // Build spatial tree
  const incomingEdgeNames = collectIncomingEdgeNames(composed);
  const siblingEdgeNames = collectSiblingEdgeNames(composed);
  const projectSpatial = buildSpatialNode(projectNode, pathToId, incomingEdgeNames, siblingEdgeNames, IDENTITY);

  // Build lookup maps
  const byStorey = new Map<number, number[]>();
  const byBuilding = new Map<number, number[]>();
  const bySite = new Map<number, number[]>();
  const bySpace = new Map<number, number[]>();
  const storeyElevations = new Map<number, number>();
  const storeyHeights = new Map<number, number>();
  const elementToStorey = new Map<number, number>();

  // Traverse and populate maps
  populateMaps(
    projectSpatial,
    null,
    null,
    null,
    pathToId,
    byStorey,
    byBuilding,
    bySite,
    bySpace,
    storeyElevations,
    elementToStorey
  );

  // Note: storeyHeights remains empty - uses on-demand property extraction

  return {
    project: projectSpatial,
    byStorey,
    byBuilding,
    bySite,
    bySpace,
    storeyElevations,
    storeyHeights,
    elementToStorey,
    // Helper methods
    getStoreyElements(storeyId: number): number[] {
      return byStorey.get(storeyId) || [];
    },
    getStoreyByElevation(z: number): number | null {
      // Canonical resolver (#1841). This used to always snap to the nearest
      // storey while the STEP parser path returned null beyond 1m, so an IFCX
      // model answered differently from the same building loaded as IFC4.
      return findStoreyByElevation(storeyElevations, z);
    },
    getContainingSpace(elementId: number): number | null {
      // Check if element is directly in a space
      for (const [spaceId, elements] of bySpace) {
        if (elements.includes(elementId)) {
          return spaceId;
        }
      }
      return null;
    },
    getPath(elementId: number): SpatialNode[] {
      const path: SpatialNode[] = [];

      function findPath(node: SpatialNode): boolean {
        if (node.expressId === elementId) {
          path.push(node);
          return true;
        }

        if (node.elements.includes(elementId)) {
          path.push(node);
          return true;
        }

        for (const child of node.children) {
          if (findPath(child)) {
            path.unshift(node);
            return true;
          }
        }

        return false;
      }

      findPath(projectSpatial);
      return path;
    },
  };
}

/**
 * Find the IfcProject node in composed nodes.
 */
function findProjectRoot(composed: Map<string, ComposedNode>): ComposedNode | null {
  for (const node of composed.values()) {
    const ifcClass = node.attributes.get(ATTR.CLASS) as IfcClass | undefined;
    if (ifcClass?.code === 'IfcProject') {
      return node;
    }
  }
  return null;
}

/**
 * Build a SpatialNode from a ComposedNode.
 */
function buildSpatialNode(
  node: ComposedNode,
  pathToId: Map<string, number>,
  incomingEdgeNames: ReadonlyMap<string, string[]>,
  siblingEdgeNames: ReadonlyMap<string, ReadonlySet<string>>,
  parentWorld: Matrix4,
): SpatialNode {
  const world = worldMatrix(node, parentWorld);
  const ifcClass = node.attributes.get(ATTR.CLASS) as IfcClass | undefined;
  const expressId = pathToId.get(node.path) ?? 0;
  const typeEnum = IfcTypeEnumFromString(ifcClass?.code ?? '');
  const elementIds = new Set<number>();

  // No source attribute means the spatial node genuinely has no Name —
  // stay '' rather than fabricating one from a slice of the internal IFCX
  // path (a plausible-looking short name no source data backs, which also
  // pre-empts treeDataBuilder.ts's own "Name absent" fallback to the type,
  // e.g. "IfcBuildingStorey", since that only fires on a falsy name).
  const name = nodeName(node, incomingEdgeNames.get(node.path) ?? [], siblingEdgeNames.get(node.path)) ?? '';
  // Keep LongName as a distinct descriptor (Name "01" / LongName "Main
  // Residence") so the hierarchy panel can show both (issue #1634); drop it when
  // it just duplicates the primary label.
  const rawLongName = node.attributes.get('bsi::ifc::prop::LongName');
  const longName =
    typeof rawLongName === 'string' && rawLongName.trim() && rawLongName.trim() !== name
      ? rawLongName.trim()
      : undefined;

  const spatialNode: SpatialNode = {
    expressId,
    type: typeEnum,
    name,
    longName,
    children: [],
    elements: [],
  };

  // Extract elevation for storeys
  if (ifcClass?.code === 'IfcBuildingStorey') {
    const elevation = node.attributes.get('bsi::ifc::prop::Elevation');
    // Elevation is optional; without it the storey's Z through its placement chain stands in, as the STEP
    // builder does, so the storey orders and levels the same whether the file says an Elevation or not.
    const placed = worldZ(world);
    spatialNode.elevation = typeof elevation === 'number' ? elevation : Number.isFinite(placed) ? placed : undefined;
  }

  // Process children
  for (const [, child] of node.children) {
    const childClass = child.attributes.get(ATTR.CLASS) as IfcClass | undefined;

    if (childClass && SPATIAL_TYPES.has(childClass.code)) {
      // Spatial child - recurse
      spatialNode.children.push(buildSpatialNode(child, pathToId, incomingEdgeNames, siblingEdgeNames, world));
    } else {
      if (ifcClass?.code === 'IfcSpace' && isSpaceBoundaryRelationshipClass(childClass?.code)) {
        collectSpaceBoundaryElementIds(child, pathToId, elementIds);
        continue;
      }

      collectElementIds(child, pathToId, elementIds, new Set());
      if (ifcClass?.code === 'IfcSpace') {
        collectSpaceBoundaryElementIds(child, pathToId, elementIds);
      }
    }
    // Geometry-only children (Body, Axis, etc.) are skipped
  }

  spatialNode.elements = [...elementIds];
  return spatialNode;
}

/**
 * Populate lookup maps by traversing the spatial hierarchy.
 */
function populateMaps(
  node: SpatialNode,
  currentStorey: number | null,
  currentBuilding: number | null,
  currentSite: number | null,
  pathToId: Map<string, number>,
  byStorey: Map<number, number[]>,
  byBuilding: Map<number, number[]>,
  bySite: Map<number, number[]>,
  bySpace: Map<number, number[]>,
  storeyElevations: Map<number, number>,
  elementToStorey: Map<number, number>
): void {
  // Update current context based on node type
  if (node.type === IfcTypeEnum.IfcBuildingStorey) {
    currentStorey = node.expressId;
    if (node.elevation !== undefined) {
      storeyElevations.set(node.expressId, node.elevation);
    }
    byStorey.set(node.expressId, []);
    // The storey's spaces are child nodes, not elements it contains, so they would sit on no storey. The STEP
    // builder maps them to it all the same (a selected space must resolve its storey, and a room list
    // reads a room's level through it); IFCX does too.
    for (const child of node.children) {
      if (child.type === IfcTypeEnum.IfcSpace || child.type === IfcTypeEnum.IfcSpatialZone) elementToStorey.set(child.expressId, node.expressId);
    }
  } else if (node.type === IfcTypeEnum.IfcBuilding) {
    currentBuilding = node.expressId;
    byBuilding.set(node.expressId, []);
  } else if (node.type === IfcTypeEnum.IfcSite) {
    currentSite = node.expressId;
    bySite.set(node.expressId, []);
  } else if (node.type === IfcTypeEnum.IfcSpace) {
    bySpace.set(node.expressId, []);
  }

  // Add elements to appropriate maps
  for (const elementId of node.elements) {
    if (currentStorey !== null) {
      pushUnique(byStorey, currentStorey, elementId);
      elementToStorey.set(elementId, currentStorey);
    }
    if (currentBuilding !== null) {
      pushUnique(byBuilding, currentBuilding, elementId);
    }
    if (currentSite !== null) {
      pushUnique(bySite, currentSite, elementId);
    }
    if (node.type === IfcTypeEnum.IfcSpace) {
      pushUnique(bySpace, node.expressId, elementId);
    }
  }

  // Recurse to children
  for (const child of node.children) {
    populateMaps(
      child,
      currentStorey,
      currentBuilding,
      currentSite,
      pathToId,
      byStorey,
      byBuilding,
      bySite,
      bySpace,
      storeyElevations,
      elementToStorey
    );
  }
}

/**
 * Create an empty hierarchy when no project is found.
 */
function createEmptyHierarchy(): SpatialHierarchy {
  const emptyProject: SpatialNode = {
    expressId: 0,
    type: IfcTypeEnum.IfcProject,
    name: 'Unknown Project',
    children: [],
    elements: [],
  };

  return {
    project: emptyProject,
    byStorey: new Map(),
    byBuilding: new Map(),
    bySite: new Map(),
    bySpace: new Map(),
    storeyElevations: new Map(),
    storeyHeights: new Map(),
    elementToStorey: new Map(),
    getStoreyElements: () => [],
    getStoreyByElevation: () => null,
    getContainingSpace: () => null,
    getPath: () => [],
  };
}

function collectElementIds(
  node: ComposedNode,
  pathToId: Map<string, number>,
  elementIds: Set<number>,
  visited: Set<string>
): void {
  if (visited.has(node.path)) return;
  visited.add(node.path);

  const ifcClass = node.attributes.get(ATTR.CLASS) as IfcClass | undefined;
  if (ifcClass?.code) {
    if (SPATIAL_TYPES.has(ifcClass.code) || isSpaceBoundaryRelationshipClass(ifcClass.code)) return;
    const elementId = pathToId.get(node.path);
    if (elementId !== undefined) {
      elementIds.add(elementId);
    }
  }

  for (const child of node.children.values()) {
    collectElementIds(child, pathToId, elementIds, visited);
  }
}

function collectSpaceBoundaryElementIds(
  node: ComposedNode,
  pathToId: Map<string, number>,
  elementIds: Set<number>
): void {
  const boundary = node.attributes.get(ATTR.SPACE_BOUNDARY) as {
    relatedelement?: { ref?: string };
  } | undefined;
  const relatedElementPath = boundary?.relatedelement?.ref;
  if (!relatedElementPath) return;

  const elementId = pathToId.get(relatedElementPath);
  if (elementId !== undefined) {
    elementIds.add(elementId);
  }
}

function isSpaceBoundaryRelationshipClass(typeCode: string | undefined): boolean {
  return typeof typeCode === 'string' && typeCode.startsWith('IfcRelSpaceBoundary');
}

function pushUnique(map: Map<number, number[]>, key: number, value: number): void {
  const list = map.get(key);
  if (!list) {
    map.set(key, [value]);
    return;
  }
  if (!list.includes(value)) {
    list.push(value);
  }
}
