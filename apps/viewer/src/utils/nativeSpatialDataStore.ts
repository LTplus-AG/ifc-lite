/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  IfcTypeEnumFromString,
  IfcTypeEnumToString,
  isBuildingLikeSpatialType,
  isStoreyLikeSpatialType,
  type SpatialHierarchy,
  type SpatialNode,
} from '@ifc-lite/data';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { NativeMetadataEntitySummary, NativeMetadataSnapshot, NativeMetadataSpatialNode } from '@/store/types';

function normalizeSummary(summary: Partial<NativeMetadataEntitySummary> & { typeName?: string; summary?: Partial<NativeMetadataEntitySummary> }): NativeMetadataEntitySummary | null {
  const source = summary.summary ? { ...summary.summary, ...summary } : summary;
  const expressId = typeof source.expressId === 'number' ? source.expressId : null;
  const type = typeof source.type === 'string'
    ? source.type
    : typeof source.typeName === 'string'
      ? source.typeName
      : null;
  if (expressId === null || !type) {
    return null;
  }
  return {
    expressId,
    type,
    name: typeof source.name === 'string' ? source.name : `${type} #${expressId}`,
    globalId: typeof source.globalId === 'string' ? source.globalId : null,
    kind: source.kind === 'spatial' ? 'spatial' : 'element',
    hasChildren: Boolean(source.hasChildren),
    elementCount: typeof source.elementCount === 'number' ? source.elementCount : undefined,
    elevation: typeof source.elevation === 'number' ? source.elevation : undefined,
  };
}

function normalizeSpatialNode(
  node: NativeMetadataSpatialNode | (Partial<NativeMetadataSpatialNode> & { typeName?: string; summary?: Partial<NativeMetadataEntitySummary> }),
): (NativeMetadataSpatialNode & { elements: NativeMetadataEntitySummary[] }) | null {
  const summary = normalizeSummary(node as Partial<NativeMetadataEntitySummary> & { typeName?: string; summary?: Partial<NativeMetadataEntitySummary> });
  if (!summary) {
    return null;
  }
  const children = Array.isArray(node.children)
    ? node.children
        .map((child) => normalizeSpatialNode(child as Partial<NativeMetadataSpatialNode> & { typeName?: string; summary?: Partial<NativeMetadataEntitySummary> }))
        .filter((child): child is NativeMetadataSpatialNode & { elements: NativeMetadataEntitySummary[] } => child !== null)
    : [];
  const elements = Array.isArray((node as { elements?: unknown[] }).elements)
    ? ((node as { elements?: unknown[] }).elements ?? [])
        .map((entry) => normalizeSummary(entry as Partial<NativeMetadataEntitySummary> & { typeName?: string; summary?: Partial<NativeMetadataEntitySummary> }))
        .filter((entry): entry is NativeMetadataEntitySummary => entry !== null)
    : [];
  return {
    ...summary,
    children,
    elements,
  };
}

function buildEntityLookup() {
  const ids: number[] = [];
  const typeEnums: number[] = [];
  const flags: number[] = [];
  const nameById = new Map<number, string>();
  const typeNameById = new Map<number, string>();
  const byType = new Map<string, number[]>();

  const addSummary = (summary: NativeMetadataEntitySummary) => {
    if (!summary.type) {
      return;
    }
    if (nameById.has(summary.expressId)) {
      return;
    }
    ids.push(summary.expressId);
    typeEnums.push(IfcTypeEnumFromString(summary.type));
    flags.push(0);
    nameById.set(summary.expressId, summary.name);
    typeNameById.set(summary.expressId, summary.type);
    const typeKey = summary.type.toUpperCase();
    const existing = byType.get(typeKey);
    if (existing) {
      existing.push(summary.expressId);
    } else {
      byType.set(typeKey, [summary.expressId]);
    }
  };

  return {
    addSummary,
    buildEntities() {
      return {
        count: ids.length,
        expressId: Uint32Array.from(ids),
        typeEnum: Uint32Array.from(typeEnums),
        flags: Uint8Array.from(flags),
        getName(expressId: number) {
          return nameById.get(expressId);
        },
        getTypeName(expressId: number) {
          return typeNameById.get(expressId) ?? 'Unknown';
        },
        getByType(type: string | number) {
          const key = typeof type === 'string'
            ? type.toUpperCase()
            : IfcTypeEnumToString(type).toUpperCase();
          return byType.get(key) ?? [];
        },
      };
    },
    buildByType() {
      return byType;
    },
  };
}

function buildPathResolver(project: SpatialNode) {
  return (elementId: number): SpatialNode[] => {
    const path: SpatialNode[] = [];
    const visit = (node: SpatialNode): boolean => {
      path.push(node);
      if (node.elements.includes(elementId)) {
        return true;
      }
      for (const child of node.children) {
        if (visit(child)) {
          return true;
        }
      }
      path.pop();
      return false;
    };
    visit(project);
    return path;
  };
}

export function buildIfcDataStoreFromNativeMetadata(snapshot: NativeMetadataSnapshot): IfcDataStore | null {
  const root = snapshot.spatialTree ? normalizeSpatialNode(snapshot.spatialTree) : null;
  if (!root) {
    return null;
  }

  const byStorey = new Map<number, number[]>();
  const byBuilding = new Map<number, number[]>();
  const bySite = new Map<number, number[]>();
  const bySpace = new Map<number, number[]>();
  const storeyElevations = new Map<number, number>();
  const storeyHeights = new Map<number, number>();
  const elementToStorey = new Map<number, number>();
  const elementToSpace = new Map<number, number>();
  const entityLookup = buildEntityLookup();

  const buildNode = (
    node: NativeMetadataSpatialNode & { elements: NativeMetadataEntitySummary[] },
    currentStoreyId: number | null,
    currentSpaceId: number | null,
  ): SpatialNode => {
    entityLookup.addSummary(node);
    const typeEnum = IfcTypeEnumFromString(node.type);
    const nextStoreyId = isStoreyLikeSpatialType(typeEnum) ? node.expressId : currentStoreyId;
    const nextSpaceId = node.type === 'IfcSpace' ? node.expressId : currentSpaceId;
    const elements = node.elements.map((summary) => {
      entityLookup.addSummary(summary);
      if (nextStoreyId !== null) {
        // Direct storey containment wins — only set if absent. Mirrors the
        // descendant-walk path in `spatialHierarchy.ts` where direct
        // IfcRelContainedInSpatialStructure entries take precedence over
        // inherited aggregate-descendant assignments.
        if (!elementToStorey.has(summary.expressId)) {
          elementToStorey.set(summary.expressId, nextStoreyId);
        }
        // NOTE: aggregate descendants of an element (e.g. IfcBuildingElementPart
        // children of an IfcWall) are NOT represented locally in the native
        // metadata snapshot — `NativeMetadataSpatialNode.children` only contains
        // spatial sub-nodes and `node.elements` is a flat list of
        // directly-contained elements (no `children` field on
        // `NativeMetadataEntitySummary`). They are fetched lazily through
        // `getNativeMetadataChildren`. The aggregate-descendant-walk fix that
        // `spatialHierarchy.ts` performs via `relationships.getRelated` cannot
        // be replicated here without an additional native bootstrap payload
        // change (see issue #540 follow-up).
      }
      if (nextSpaceId !== null) {
        if (!elementToSpace.has(summary.expressId)) {
          elementToSpace.set(summary.expressId, nextSpaceId);
        }
      }
      return summary.expressId;
    });

    const childNodes = node.children.map((child) => buildNode(child, nextStoreyId, nextSpaceId));
    const spatialNode: SpatialNode = {
      expressId: node.expressId,
      type: typeEnum,
      name: node.name,
      elevation: node.elevation ?? undefined,
      children: childNodes,
      elements,
    };

    if (isStoreyLikeSpatialType(typeEnum)) {
      byStorey.set(node.expressId, elements);
      if (typeof node.elevation === 'number') {
        storeyElevations.set(node.expressId, node.elevation);
      }
    } else if (isBuildingLikeSpatialType(typeEnum)) {
      byBuilding.set(node.expressId, elements);
    } else if (node.type === 'IfcSite') {
      bySite.set(node.expressId, elements);
    } else if (node.type === 'IfcSpace') {
      bySpace.set(node.expressId, elements);
    }

    return spatialNode;
  };

  const project = buildNode(root, null, null);
  const getPath = buildPathResolver(project);
  const hierarchy: SpatialHierarchy = {
    project,
    byStorey,
    byBuilding,
    bySite,
    bySpace,
    storeyElevations,
    storeyHeights,
    elementToStorey,
    getStoreyElements(storeyId: number) {
      return byStorey.get(storeyId) ?? [];
    },
    getStoreyByElevation(z: number) {
      let closestStoreyId: number | null = null;
      let closestDistance = Number.POSITIVE_INFINITY;
      for (const [storeyId, elevation] of storeyElevations) {
        const distance = Math.abs(elevation - z);
        if (distance < closestDistance) {
          closestDistance = distance;
          closestStoreyId = storeyId;
        }
      }
      return closestStoreyId;
    },
    getContainingSpace(elementId: number) {
      return elementToSpace.get(elementId) ?? null;
    },
    getPath,
  };

  const entities = entityLookup.buildEntities();
  return {
    fileSize: 0,
    schemaVersion: snapshot.schemaVersion,
    entityCount: snapshot.entityCount,
    parseTime: 0,
    source: new Uint8Array(0),
    entityIndex: {
      byId: new Map(),
      byType: entityLookup.buildByType(),
    },
    strings: {} as IfcDataStore['strings'],
    entities: entities as unknown as IfcDataStore['entities'],
    properties: undefined as unknown as IfcDataStore['properties'],
    quantities: undefined as unknown as IfcDataStore['quantities'],
    relationships: undefined as unknown as IfcDataStore['relationships'],
    spatialHierarchy: hierarchy,
  } as IfcDataStore;
}
