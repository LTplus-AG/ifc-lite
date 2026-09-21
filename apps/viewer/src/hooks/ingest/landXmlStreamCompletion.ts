/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Final model ownership after worker components and source events converge. */

import type { MeshData } from '@ifc-lite/geometry';
import { createCoordinateInfo, createEmptyBounds, type Bounds3D } from '../../utils/localParsingUtils.js';
import { placeComponentsInKnownRenderFrame, meshRenderFrameBounds } from './landXmlRenderFrame.js';
import { sourceCoordinateInfo } from './landXmlSourceFrame.js';
import type { LandXmlTinDocument } from './landXmlSemantics.js';
import { buildLandXmlPipeComponents } from './landXmlPipeGeometry.js';
import { pipeRefusalWarnings } from './landXmlPipeWarnings.js';
import { fragmentLandXmlGeometryComponent } from './landXmlComponentFragmentation.js';
import type { LandXmlGeometryPayload, LandXmlGeometryPreflight } from './landXmlIngest.js';

/** One transferred mesh plus immutable source provenance. */
export interface LandXmlStreamedComponent {
  mesh: MeshData;
  surfaceName: string;
  surfaceSourceId: string | null;
  pipeSourceId: string | null;
  renderedFaceSourceIds: string[];
}

/** A preflighted local mesh slot intentionally rejected by its frozen frame. */
export interface LandXmlStreamedSkippedComponent {
  expressId: number;
  /** Present for terrain slots so completion can retain direct-parser counts. */
  surfaceSourceId?: string | null;
  renderedFaceSourceIds?: string[];
}

/** Bounded per-surface facts emitted before its credited component slots. */
export interface LandXmlStreamedSurfaceDiagnostics {
  surfaceSourceId: string;
  surfaceName: string;
  droppedDegenerateFaces: number;
  droppedPrecisionFaces: number;
  hasNoRenderableFaces: boolean;
}

export interface LandXmlStreamedPipeComponents {
  slots: Array<{ component: LandXmlStreamedComponent } | { skipped: LandXmlStreamedSkippedComponent }>;
}

function mergeBounds(target: Bounds3D, source: Bounds3D): void {
  target.min.x = Math.min(target.min.x, source.min.x);
  target.min.y = Math.min(target.min.y, source.min.y);
  target.min.z = Math.min(target.min.z, source.min.z);
  target.max.x = Math.max(target.max.x, source.max.x);
  target.max.y = Math.max(target.max.y, source.max.y);
  target.max.z = Math.max(target.max.z, source.max.z);
}

/** Complete a Blob load from the meshes acknowledged under stream credit. */
export function completeLandXmlStreamedGeometry(
  parsed: LandXmlTinDocument,
  components: readonly LandXmlStreamedComponent[],
  preflight: LandXmlGeometryPreflight,
  diagnostics: ReadonlyMap<string, LandXmlStreamedSurfaceDiagnostics> = new Map(),
  skippedComponents: readonly LandXmlStreamedSkippedComponent[] = [],
): LandXmlGeometryPayload {
  const meshes = components.map((component) => component.mesh);
  const warnings = [...parsed.warnings, ...pipeRefusalWarnings(parsed)];
  const bounds = createEmptyBounds();
  const originShift = preflight.frame?.originShift ?? { x: 0, y: 0, z: 0 };
  for (const mesh of meshes) {
    const meshBounds = meshRenderFrameBounds(mesh);
    if (meshBounds === null) throw new Error('LandXML stream transferred a mesh without finite render-frame bounds');
    mergeBounds(bounds, {
      min: { x: meshBounds.min.x + originShift.x, y: meshBounds.min.y + originShift.y, z: meshBounds.min.z + originShift.z },
      max: { x: meshBounds.max.x + originShift.x, y: meshBounds.max.y + originShift.y, z: meshBounds.max.z + originShift.z },
    });
  }
  const coordinateInfo = meshes.length === 0
    ? sourceCoordinateInfo(parsed)
    : createCoordinateInfo(bounds, originShift, preflight.frame?.hasLargeCoordinates ?? false);
  const provenance = components.map((component) => ({
    meshExpressId: component.mesh.expressId,
    surfaceSourceId: component.surfaceSourceId ?? '',
    renderedFaceSourceIds: component.renderedFaceSourceIds,
    ...(component.pipeSourceId ? { pipeSourceId: component.pipeSourceId } : {}),
  }));
  const surfaceCounts = parsed.surfaces.map((surface) => {
    const surfaceComponents = components.filter((component) => component.surfaceSourceId === surface.sourceId);
    const skippedFaces = skippedComponents
      .filter((component) => component.surfaceSourceId === surface.sourceId)
      .reduce((count, component) => count + (component.renderedFaceSourceIds?.length ?? 0), 0);
    const diagnostic = diagnostics.get(surface.sourceId);
    if (diagnostic !== undefined) {
      if (diagnostic.droppedDegenerateFaces > 0) {
        warnings.push(`Skipped ${diagnostic.droppedDegenerateFaces} degenerate face(s) in surface "${diagnostic.surfaceName}"`);
      }
      if (diagnostic.droppedPrecisionFaces > 0) {
        warnings.push(`Skipped ${diagnostic.droppedPrecisionFaces} face(s) in surface "${diagnostic.surfaceName}" because their coordinate span exceeds render precision`);
      }
      if (diagnostic.hasNoRenderableFaces) {
        warnings.push(`Skipped surface "${diagnostic.surfaceName}" because it has no non-degenerate faces`);
      }
    }
    return {
      surfaceSourceId: surface.sourceId, sourcePoints: surface.points.length, sourceFaces: surface.faces.length,
      hiddenFaces: surface.hiddenFaceCount,
      renderedFaces: surfaceComponents.reduce((count, component) => count + component.renderedFaceSourceIds.length, 0),
      droppedDegenerateFaces: diagnostic?.droppedDegenerateFaces ?? 0,
      droppedPrecisionFaces: diagnostic?.droppedPrecisionFaces ?? 0,
      droppedReframeFaces: skippedFaces,
    };
  });
  return {
    geometryResult: {
      meshes,
      totalVertices: meshes.reduce((total, mesh) => total + mesh.positions.length / 3, 0),
      totalTriangles: meshes.reduce((total, mesh) => total + mesh.indices.length / 3, 0),
      coordinateInfo,
    },
    schemaVersion: 'IFC4', warnings,
    surfaceNames: [...new Set(components.map((component) => component.surfaceName))],
    semanticDocument: { ...parsed, rendering: { meshProvenance: provenance, surfaceCounts } },
  };
}

/** Build pipe components only on the permanent semantic-document owner. */
export function buildLandXmlStreamedPipeComponents(
  parsed: LandXmlTinDocument,
  firstExpressId: number,
  preflight: LandXmlGeometryPreflight,
  placeInFrozenFrame: boolean,
): LandXmlStreamedPipeComponents {
  const components = buildLandXmlPipeComponents(parsed.pipeNetworks ?? null, firstExpressId).components
    .flatMap((pipe) => fragmentLandXmlGeometryComponent({
      ...pipe, surfaceName: pipe.name, surfaceSourceId: null, pipeSourceId: pipe.sourceId, renderedFaceSourceIds: [],
    }));
  // Fragmentation creates more than one render component for one source pipe;
  // assign the preflight slot before placement so a rejected middle fragment
  // cannot compact stable local IDs for later components.
  for (const [index, component] of components.entries()) component.mesh.expressId = firstExpressId + index;
  const placement = placeInFrozenFrame
    ? placeComponentsInKnownRenderFrame(
      components,
      preflight.frame ?? { originShift: { x: 0, y: 0, z: 0 }, hasLargeCoordinates: false },
      [],
    )
    : { placed: components, dropped: [] };
  const placed = new Set(placement.placed);
  return {
    slots: components.map((component) => placed.has(component)
      ? { component: {
        mesh: component.mesh,
        surfaceName: component.surfaceName,
        surfaceSourceId: component.surfaceSourceId,
        pipeSourceId: component.pipeSourceId,
        renderedFaceSourceIds: component.renderedFaceSourceIds,
      } }
      : { skipped: { expressId: component.mesh.expressId } }),
  };
}
