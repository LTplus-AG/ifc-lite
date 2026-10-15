/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { expandTypeNamesToDescendants } from '@ifc-lite/data';
import { iterateEffectiveEntityIds, type MutablePropertyView } from '@ifc-lite/mutations';
import { effectiveMetadataRecord, type IfcDataStore } from '@ifc-lite/parser';

export interface PresentationLayer {
  expressId: number;
  type: 'IfcPresentationLayerAssignment' | 'IfcPresentationLayerWithStyle';
  Name: string;
  Description?: string;
  Identifier?: string;
  /** Model-local product IDs. Actions affect whole products, not individual items. */
  productIds: number[];
}

const LAYER_TYPES = ['IfcPresentationLayerAssignment', 'IfcPresentationLayerWithStyle'];

/** References in parsed records are numbers; named authoring edits use STEP refs. */
function references(value: unknown): number[] {
  const result: number[] = [];
  const pending = [value];
  const visited = new Set<unknown[]>();
  while (pending.length > 0) {
    const item = pending.pop();
    if (Array.isArray(item)) {
      if (visited.has(item)) continue;
      visited.add(item);
      for (const child of item) pending.push(child);
    } else if (typeof item === 'number') {
      if (Number.isInteger(item) && item > 0 && item <= 0xffffffff) result.push(item);
    } else if (typeof item === 'string'
      && /^\s*(?:\(\s*)?#\d+(?:\s*,\s*#\d+)*(?:\s*\))?\s*$/.test(item)) {
      for (const match of item.matchAll(/#(\d+)/g)) {
        const id = Number(match[1]);
        if (Number.isInteger(id) && id > 0 && id <= 0xffffffff) result.push(id);
      }
    }
  }
  return result;
}

/**
 * Product-level membership of presentation layers (#7619). This deliberately
 * unions explicit assignments: item styling precedence and LayerOn/LayerFrozen
 * do not change membership or automatically change viewer visibility.
 *
 * Reverse edges describe shape ownership only. Walking arbitrary references
 * would associate unrelated products through shared contexts or placements.
 * Every relevant entity is decoded once per build, then all layer walks use
 * this index. Iterative, visited walks also bound cyclic mapped geometry.
 */
export function resolvePresentationLayers(
  store: IfcDataStore,
  view?: MutablePropertyView | null,
): PresentationLayer[] {
  const productTypes = expandTypeNamesToDescendants(['IfcProduct'], store.schemaVersion);
  const shapeTypes = expandTypeNamesToDescendants(['IfcRepresentation'], store.schemaVersion);
  const containers = new Map<string, readonly string[]>();
  const ownership = [
    ['IfcGeometricSet', ['Elements']],
    ['IfcManifoldSolidBrep', ['Outer', 'Voids']],
    ['IfcConnectedFaceSet', ['CfsFaces']],
    ['IfcFace', ['Bounds']],
    ['IfcFaceBound', ['Bound']],
    ['IfcShellBasedSurfaceModel', ['SbsmBoundary']],
    ['IfcFaceBasedSurfaceModel', ['FbsmFaces']],
    ['IfcCompositeCurve', ['Segments']],
    ['IfcCompositeCurveSegment', ['ParentCurve']],
    ['IfcTrimmedCurve', ['BasisCurve']],
    ['IfcPolyline', ['Points']],
    ['IfcIndexedPolyCurve', ['Points']],
    ['IfcEdgeLoop', ['EdgeList']],
    ['IfcOrientedEdge', ['EdgeElement']],
    ['IfcEdgeCurve', ['EdgeGeometry']],
    ['IfcVertexPoint', ['VertexGeometry']],
    ['IfcSweptDiskSolid', ['Directrix']],
    ['IfcSweptAreaSolid', ['SweptArea', 'EndSweptArea']],
    ['IfcFixedReferenceSweptAreaSolid', ['Directrix']],
    ['IfcSurfaceCurveSweptAreaSolid', ['Directrix']],
    ['IfcSectionedSolid', ['Directrix', 'CrossSections']],
    ['IfcSectionedSpine', ['SpineCurve', 'CrossSections']],
    ['IfcSweptSurface', ['SweptCurve']],
    ['IfcArbitraryClosedProfileDef', ['OuterCurve', 'InnerCurves']],
    ['IfcArbitraryOpenProfileDef', ['Curve']],
    ['IfcCompositeProfileDef', ['Profiles']],
    ['IfcDerivedProfileDef', ['ParentProfile']],
    ['IfcOffsetCurve', ['BasisCurve']],
    ['IfcSurfaceCurve', ['Curve3D']],
    ['IfcCurveSegment', ['ParentCurve']],
  ] as const;
  for (const [root, attributes] of ownership) {
    for (const type of expandTypeNamesToDescendants([root], store.schemaVersion)) {
      const key = type.toUpperCase();
      containers.set(key, [...new Set([...(containers.get(key) ?? []), ...attributes])]);
    }
  }
  const productClasses = new Set(productTypes.map(type => type.toUpperCase()));
  const shapeClasses = new Set(shapeTypes.map(type => type.toUpperCase()));
  const shapeModelClasses = new Set(expandTypeNamesToDescendants(['IfcShapeModel'], store.schemaVersion)
    .map(type => type.toUpperCase()));
  const layeredClasses = new Set([...shapeTypes,
    ...expandTypeNamesToDescendants(['IfcRepresentationItem'], store.schemaVersion)]
    .map(type => type.toUpperCase()));
  const types = [...productTypes, ...shapeTypes, ...containers.keys(), ...LAYER_TYPES,
    'IfcProductDefinitionShape', 'IfcProductRepresentation', 'IfcRepresentationMap', 'IfcMappedItem',
    'IfcBooleanResult', 'IfcBooleanClippingResult', 'IfcCsgSolid', 'IfcShapeAspect'];
  const parents = new Map<number, Set<number>>();
  const products = new Set<number>();
  const layers: Array<PresentationLayer & { assignedItems: number[] }> = [];
  const validSeeds = new Map<number, boolean>();
  const records = new Map<number, ReturnType<typeof effectiveMetadataRecord>>();
  const readRecord = (id: number): ReturnType<typeof effectiveMetadataRecord> => {
    if (!records.has(id)) records.set(id, effectiveMetadataRecord(store, id, view ?? undefined));
    return records.get(id) ?? null;
  };
  const addEdges = (parent: number, value: unknown): void => {
    for (const child of references(value)) {
      const owners = parents.get(child) ?? new Set<number>();
      owners.add(parent);
      parents.set(child, owners);
    }
  };

  for (const entry of iterateEffectiveEntityIds(store, view, types)) {
    const record = readRecord(entry.expressId);
    if (!record) continue;
    const attrs = new Map(record.names.map((name, index) => [name, record.attributes[index]]));
    const type = record.type.toUpperCase();
    const id = entry.expressId;
    if (LAYER_TYPES.some(layer => layer.toUpperCase() === type)) {
      const text = (name: string): string | undefined => {
        const value = attrs.get(name);
        return typeof value === 'string' && value.length > 0 ? value : undefined;
      };
      const layerType = type === 'IFCPRESENTATIONLAYERWITHSTYLE'
        ? 'IfcPresentationLayerWithStyle' : 'IfcPresentationLayerAssignment';
      layers.push({ expressId: id, type: layerType,
        Name: text('Name') ?? `${layerType} #${id}`,
        Description: text('Description'), Identifier: text('Identifier'),
        assignedItems: references(attrs.get('AssignedItems')), productIds: [] });
    } else if (productClasses.has(type)) {
      products.add(id);
      addEdges(id, attrs.get('Representation'));
    } else if (shapeClasses.has(type)) {
      addEdges(id, attrs.get('Items'));
    } else if (type === 'IFCPRODUCTDEFINITIONSHAPE' || type === 'IFCPRODUCTREPRESENTATION') {
      addEdges(id, attrs.get('Representations'));
    } else if (type === 'IFCMAPPEDITEM') {
      addEdges(id, attrs.get('MappingSource'));
    } else if (type === 'IFCREPRESENTATIONMAP') {
      addEdges(id, attrs.get('MappedRepresentation'));
    } else if (type === 'IFCSHAPEASPECT') {
      // Shape aspects point back to their owning resource. Their shape models
      // need not also appear in that resource's main representation list.
      const ownerIds = references(attrs.get('PartOfProductDefinitionShape'));
      if (ownerIds.length !== 1) continue;
      const ownerId = ownerIds[0];
      const ownerType = readRecord(ownerId)?.type.toUpperCase();
      if (ownerType !== 'IFCPRODUCTDEFINITIONSHAPE' && ownerType !== 'IFCREPRESENTATIONMAP') continue;
      for (const shapeId of references(attrs.get('ShapeRepresentations'))) {
        const shapeType = readRecord(shapeId)?.type.toUpperCase();
        if (shapeType && shapeModelClasses.has(shapeType)) addEdges(ownerId, shapeId);
      }
    } else if (type === 'IFCCSGSOLID') {
      addEdges(id, attrs.get('TreeRootExpression'));
    } else if (type === 'IFCBOOLEANRESULT' || type === 'IFCBOOLEANCLIPPINGRESULT') {
      addEdges(id, attrs.get('FirstOperand'));
      addEdges(id, attrs.get('SecondOperand'));
    } else {
      for (const attribute of containers.get(type) ?? []) addEdges(id, attrs.get(attribute));
    }
  }

  return layers.map(({ assignedItems, ...layer }) => {
    const visited = new Set<number>();
    const found = new Set<number>();
    const pending = assignedItems.filter(id => {
      let valid = validSeeds.get(id);
      if (valid === undefined) {
        const record = readRecord(id);
        valid = !!record && layeredClasses.has(record.type.toUpperCase());
        validSeeds.set(id, valid);
      }
      return valid;
    });
    while (pending.length > 0) {
      const id = pending.pop()!;
      if (visited.has(id) || view?.isDeleted(id)) continue;
      visited.add(id);
      if (products.has(id)) found.add(id);
      for (const parent of parents.get(id) ?? []) pending.push(parent);
    }
    layer.productIds = [...found].sort((a, b) => a - b);
    return layer;
  });
}
