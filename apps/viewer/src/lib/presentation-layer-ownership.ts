/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { expandTypeNamesToDescendants } from '@ifc-lite/data';
import type { IfcDataStore } from '@ifc-lite/parser';

export const LAYER_TYPES = ['IfcPresentationLayerAssignment', 'IfcPresentationLayerWithStyle'];

/** References in parsed records are numbers; named authoring edits use STEP refs. */
export function references(value: unknown): number[] {
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

const plans = new Map<IfcDataStore['schemaVersion'], ReturnType<typeof buildOwnership>>();

function buildOwnership(schemaVersion: IfcDataStore['schemaVersion']) {
  const productTypes = expandTypeNamesToDescendants(['IfcProduct'], schemaVersion);
  const shapeTypes = expandTypeNamesToDescendants(['IfcRepresentation'], schemaVersion);
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
    // IFC2X3/IFC4 registries may put these directly under IfcCurve.
    ['IfcOffsetCurve2D', ['BasisCurve']],
    ['IfcOffsetCurve3D', ['BasisCurve']],
    ['IfcSurfaceCurve', ['Curve3D']],
    ['IfcCurveSegment', ['ParentCurve']],
    ['IfcTessellatedFaceSet', ['Coordinates']],
    ['IfcPolygonalFaceSet', ['Faces']],
    ['IfcFaceSurface', ['FaceSurface']],
    ['IfcPolyLoop', ['Polygon']],
    ['IfcEdge', ['EdgeStart', 'EdgeEnd']],
    ['IfcAnnotationFillArea', ['OuterBoundary', 'InnerBoundaries']],
    ['IfcBSplineCurve', ['ControlPointsList']],
    ['IfcBSplineSurface', ['ControlPointsList']],
    ['IfcLine', ['Pnt']],
    ['IfcHalfSpaceSolid', ['BaseSurface']],
    ['IfcPolygonalBoundedHalfSpace', ['PolygonalBoundary']],
  ] as const;
  for (const [root, attributes] of ownership) {
    for (const type of expandTypeNamesToDescendants([root], schemaVersion)) {
      const key = type.toUpperCase();
      containers.set(key, [...new Set([...(containers.get(key) ?? []), ...attributes])]);
    }
  }
  const productClasses = new Set(productTypes.map(type => type.toUpperCase()));
  const shapeClasses = new Set(shapeTypes.map(type => type.toUpperCase()));
  const shapeModelClasses = new Set(expandTypeNamesToDescendants(['IfcShapeModel'], schemaVersion)
    .map(type => type.toUpperCase()));
  const layeredClasses = new Set([...shapeTypes,
    ...expandTypeNamesToDescendants(['IfcRepresentationItem'], schemaVersion)]
    .map(type => type.toUpperCase()));
  const types = [...productTypes, ...shapeTypes, ...containers.keys(), ...LAYER_TYPES,
    'IfcProductDefinitionShape', 'IfcProductRepresentation', 'IfcRepresentationMap', 'IfcMappedItem',
    'IfcBooleanResult', 'IfcBooleanClippingResult', 'IfcCsgSolid', 'IfcShapeAspect'];
  const attributesFor = (type: string): readonly string[] => {
    if (productClasses.has(type)) return ['Representation'];
    if (shapeClasses.has(type)) return ['Items'];
    if (type === 'IFCPRODUCTDEFINITIONSHAPE' || type === 'IFCPRODUCTREPRESENTATION') return ['Representations'];
    if (type === 'IFCMAPPEDITEM') return ['MappingSource'];
    if (type === 'IFCREPRESENTATIONMAP') return ['MappedRepresentation'];
    if (type === 'IFCCSGSOLID') return ['TreeRootExpression'];
    if (type === 'IFCBOOLEANRESULT' || type === 'IFCBOOLEANCLIPPINGRESULT') return ['FirstOperand', 'SecondOperand'];
    return containers.get(type) ?? [];
  };
  return { productClasses, shapeModelClasses, layeredClasses, types, attributesFor };
}

/** The same ownership edges in both directions; never follow placements/styles. */
export function presentationOwnership(schemaVersion: IfcDataStore['schemaVersion']) {
  let plan = plans.get(schemaVersion);
  if (!plan) { plan = buildOwnership(schemaVersion); plans.set(schemaVersion, plan); }
  return plan;
}
