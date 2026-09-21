/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { GeometryResult, MeshData } from '@ifc-lite/geometry';
import { createCoordinateInfo, createEmptyBounds, type Bounds3D } from '../../utils/localParsingUtils.js';
import { placeAndAssignLandXmlComponents, type LandXmlGeometryComponent } from './landXmlComponentPlacement.js';
import { deriveLandXmlRenderFrameFromMeasurement, type LandXmlRenderFramePlan } from './landXmlRenderFrame.js';
import { sourceCoordinateInfo } from './landXmlSourceFrame.js';
import type { LandXmlTinDocument, LandXmlTinSurface } from './landXmlSemantics.js';
import { buildLandXmlPipeComponents } from './landXmlPipeGeometry.js';
import { pipeRefusalWarnings } from './landXmlPipeWarnings.js';
import { fragmentLandXmlGeometryComponent } from './landXmlComponentFragmentation.js';
export {
  fragmentLandXmlGeometryComponent, MAX_LANDXML_COMPONENT_MESSAGE_BYTES,
  MAX_LANDXML_COMPONENT_TRANSFER_BYTES,
} from './landXmlComponentFragmentation.js';
export { connectedFaceComponents } from './landXmlFaceComponents.js';
import { connectedFaceComponents } from './landXmlFaceComponents.js';
import { precisionFaceBatches } from './landXmlPrecisionBatches.js';
export type { LandXmlTinDocument, LandXmlTinSurface } from './landXmlSemantics.js';
export type LandXmlSourceBuffer = ArrayBuffer | SharedArrayBuffer;
export interface LandXmlGeometryPayload {
  geometryResult: GeometryResult;
  schemaVersion: 'IFC4';
  warnings: string[];
  surfaceNames: string[];
  /** Durable source records, independent of all mesh/component partitioning. */
  semanticDocument: LandXmlTinDocument;
}
export {
  buildLandXmlStreamedPipeComponents, completeLandXmlStreamedGeometry,
  type LandXmlStreamedComponent,
  type LandXmlStreamedSkippedComponent,
  type LandXmlStreamedSurfaceDiagnostics,
} from './landXmlStreamCompletion.js';
export function buildLandXmlSurfaceMesh(
  surface: LandXmlTinSurface,
  expressId: number,
  linearScale: number,
  elevationScale: number,
  originOverride?: [number, number, number],
): { mesh: MeshData | null; degenerateFaces: number; bounds: Bounds3D | null; renderedFaces: LandXmlTinSurface['faces']; unrenderedFaces: LandXmlTinSurface['faces'] } {
  const worldById = new Map<string, { x: number; y: number; z: number }>();
  for (const point of surface.points) {
    // LandXML: northing/easting/elevation (Z-up). Viewer: X east, Y up,
    // Z south. This is the same Z-up -> Y-up convention used by IFC and the
    // point-cloud ingest path.
    const world = {
      x: point.easting * linearScale,
      y: point.elevation * elevationScale,
      z: -point.northing * linearScale,
    };
    worldById.set(point.id, world);
  }

  let degenerateFaces = 0;
  const retainedFaces = surface.faces.filter((face) => {
    const a = worldById.get(face[0])!;
    const b = worldById.get(face[1])!;
    const c = worldById.get(face[2])!;
    const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
    const acx = c.x - a.x, acy = c.y - a.y, acz = c.z - a.z;
    const length = Math.hypot(
      aby * acz - abz * acy,
      abz * acx - abx * acz,
      abx * acy - aby * acx,
    );
    if (Number.isFinite(length) && length > Number.EPSILON) return true;
    degenerateFaces++;
    return false;
  });
  if (retainedFaces.length === 0) return { mesh: null, degenerateFaces, bounds: null, renderedFaces: [], unrenderedFaces: [] };

  const referencedPointIds = new Set(retainedFaces.flatMap((face) => face));
  const retainedPoints = surface.points.filter((point) => referencedPointIds.has(point.id));
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const point of retainedPoints) {
    const world = worldById.get(point.id)!;
    minX = Math.min(minX, world.x); minY = Math.min(minY, world.y); minZ = Math.min(minZ, world.z);
    maxX = Math.max(maxX, world.x); maxY = Math.max(maxY, world.y); maxZ = Math.max(maxZ, world.z);
  }

  // Survey coordinates routinely sit hundreds of kilometres from zero. Keep
  // them in f64 until this per-surface origin is removed, then store the local
  // residuals as f32. MeshData.origin restores the exact world placement.
  const origin: [number, number, number] = originOverride ?? [
    (minX + maxX) / 2,
    (minY + maxY) / 2,
    (minZ + maxZ) / 2,
  ];
  const positions = new Float32Array(retainedPoints.length * 3);
  const indexById = new Map<string, number>();
  retainedPoints.forEach((point, index) => {
    const world = worldById.get(point.id)!;
    indexById.set(point.id, index);
    positions[index * 3] = world.x - origin[0];
    positions[index * 3 + 1] = world.y - origin[1];
    positions[index * 3 + 2] = world.z - origin[2];
  });

  const indices: number[] = [];
  const renderedFaces: LandXmlTinSurface['faces'] = [];
  const unrenderedFaces: LandXmlTinSurface['faces'] = [];
  const normalSums = new Float64Array(positions.length);
  for (const face of retainedFaces) {
    let a = indexById.get(face[0])!;
    let b = indexById.get(face[1])!;
    let c = indexById.get(face[2])!;
    const ax = positions[a * 3], ay = positions[a * 3 + 1], az = positions[a * 3 + 2];
    const bx = positions[b * 3], by = positions[b * 3 + 1], bz = positions[b * 3 + 2];
    const cx = positions[c * 3], cy = positions[c * 3 + 1], cz = positions[c * 3 + 2];
    const abx = bx - ax, aby = by - ay, abz = bz - az;
    const acx = cx - ax, acy = cy - ay, acz = cz - az;
    let nx = aby * acz - abz * acy;
    let ny = abz * acx - abx * acz;
    let nz = abx * acy - aby * acx;
    const length = Math.hypot(nx, ny, nz);
    if (!Number.isFinite(length) || length <= Number.EPSILON) {
      unrenderedFaces.push(face);
      continue;
    }
    // LandXML does not promise a terrain-face winding. Point the normal up so
    // lighting is stable while retaining the same geometric triangle.
    if (ny < 0) {
      [b, c] = [c, b];
      nx = -nx; ny = -ny; nz = -nz;
    }
    indices.push(a, b, c);
    renderedFaces.push(face);
    for (const index of [a, b, c]) {
      normalSums[index * 3] += nx;
      normalSums[index * 3 + 1] += ny;
      normalSums[index * 3 + 2] += nz;
    }
  }
  if (indices.length === 0) {
    if (!originOverride) {
      // Disconnected components can be far enough apart that centering their
      // combined extent collapses every small triangle in f32. Anchor a retry
      // at the first real face; any still-collapsed components are compacted
      // by the normal post-cast path below.
      const firstFace = retainedFaces[0];
      const a = worldById.get(firstFace[0])!;
      const retried = buildLandXmlSurfaceMesh(surface, expressId, linearScale, elevationScale, [a.x, a.y, a.z]);
      return { ...retried, degenerateFaces: degenerateFaces + retried.degenerateFaces };
    }
    return { mesh: null, degenerateFaces, bounds: null, renderedFaces: [], unrenderedFaces };
  }
  if (renderedFaces.length !== retainedFaces.length) {
    const compacted = buildLandXmlSurfaceMesh(
      { ...surface, faces: renderedFaces },
      expressId,
      linearScale,
      elevationScale,
    );
    return {
      ...compacted,
      degenerateFaces: degenerateFaces + compacted.degenerateFaces,
      unrenderedFaces: [...unrenderedFaces, ...compacted.unrenderedFaces],
    };
  }

  const normals = new Float32Array(normalSums.length);
  for (let i = 0; i < normalSums.length; i += 3) {
    const length = Math.hypot(normalSums[i], normalSums[i + 1], normalSums[i + 2]);
    if (length > Number.EPSILON) {
      normals[i] = normalSums[i] / length;
      normals[i + 1] = normalSums[i + 1] / length;
      normals[i + 2] = normalSums[i + 2] / length;
    } else {
      normals[i + 1] = 1;
    }
  }
  return {
    mesh: {
      expressId,
      positions,
      normals,
      indices: new Uint32Array(indices),
      color: [0.42, 0.62, 0.32, 1],
      origin,
    },
    degenerateFaces,
    bounds: {
      min: { x: minX, y: minY, z: minZ },
      max: { x: maxX, y: maxY, z: maxZ },
    },
    renderedFaces,
    unrenderedFaces: [],
  };
}

export interface LandXmlSurfaceComponentBuild {
  components: LandXmlGeometryComponent[];
  droppedDegenerateFaces: number;
  droppedPrecisionFaces: number;
}

export interface LandXmlGeometryPreflight {
  componentCount: number;
  frame: LandXmlRenderFramePlan | null;
}

const MAX_LANDXML_SURFACE_COMPONENT_TRIANGLES = 3_000;

function mergeLandXmlBounds(target: Bounds3D, source: Bounds3D): void {
  target.min.x = Math.min(target.min.x, source.min.x);
  target.min.y = Math.min(target.min.y, source.min.y);
  target.min.z = Math.min(target.min.z, source.min.z);
  target.max.x = Math.max(target.max.x, source.max.x);
  target.max.y = Math.max(target.max.y, source.max.y);
  target.max.z = Math.max(target.max.z, source.max.z);
}

/** The direct and cursor paths must reproduce one source-ordered envelope. */
export function preflightLandXmlGeometry(parsed: LandXmlTinDocument): LandXmlGeometryPreflight {
  const renderableSurfaces = parsed.surfaces.filter((surface) => (
    surface.renderState === 'rendered' && surface.faceVisibility.some(Boolean)
  ));
  if (renderableSurfaces.length > 0 && parsed.units === null) {
    throw new Error('LandXML has renderable TIN topology but no Units declaration');
  }
  let componentCount = 0;
  // Object indirection keeps the measurement callback's mutation visible to
  // TypeScript's control-flow analysis after the surface loops complete.
  const dominant: { value: LandXmlGeometryComponent | null } = { value: null };
  const sourceBounds = createEmptyBounds();
  const measure = (component: LandXmlGeometryComponent): void => {
    componentCount++;
    mergeLandXmlBounds(sourceBounds, component.bounds);
    if (dominant.value === null || component.mesh.indices.length > dominant.value.mesh.indices.length) dominant.value = component;
  };
  for (const surface of renderableSurfaces) {
    const built = buildLandXmlSurfaceComponents(surface, parsed.units!, componentCount + 1);
    for (const component of built.components) measure(component);
  }
  const pipes = buildLandXmlPipeComponents(parsed.pipeNetworks ?? null, componentCount + 1);
  for (const component of pipes.components) {
    for (const fragment of fragmentLandXmlGeometryComponent({
      ...component, surfaceName: component.name, surfaceSourceId: null, pipeSourceId: component.sourceId, renderedFaceSourceIds: [],
    })) measure(fragment);
  }
  return { componentCount, frame: dominant.value === null ? null : deriveLandXmlRenderFrameFromMeasurement(sourceBounds, dominant.value.bounds) };
}

/** Build one surface's exact render components without assigning global ids. */
export function buildLandXmlSurfaceComponents(
  surface: LandXmlTinSurface,
  units: NonNullable<LandXmlTinDocument['units']>,
  firstExpressId: number,
): LandXmlSurfaceComponentBuild {
  const components: LandXmlGeometryComponent[] = [];
  let degenerateFaces = 0;
  let unrepresentableFaces = 0;
  const faceSourceId = new Map(surface.faces.map((face, index) => [face, surface.faceSourceIds[index]]));
  const visibleFaces = surface.faces.filter((_, index) => surface.faceVisibility[index]);
  for (const connectedFaces of connectedFaceComponents(visibleFaces)) {
    for (const precisionFaces of precisionFaceBatches(
      surface,
      connectedFaces,
      units.linearScaleToMeters,
      units.elevationScaleToMeters,
    )) {
      const pending: LandXmlTinSurface['faces'][] = [];
      for (let end = precisionFaces.length; end > 0; end -= MAX_LANDXML_SURFACE_COMPONENT_TRIANGLES) {
        pending.push(precisionFaces.slice(Math.max(0, end - MAX_LANDXML_SURFACE_COMPONENT_TRIANGLES), end));
      }
      while (pending.length > 0) {
        const currentFaces = pending.pop()!;
        const result = buildLandXmlSurfaceMesh(
          { ...surface, faces: currentFaces },
          firstExpressId + components.length,
          units.linearScaleToMeters,
          units.elevationScaleToMeters,
        );
        degenerateFaces += result.degenerateFaces;
        if (result.mesh && result.bounds) {
          components.push(...fragmentLandXmlGeometryComponent({
            mesh: result.mesh, bounds: result.bounds, frameGroup: surface.sourceId,
            surfaceName: surface.name, surfaceSourceId: surface.sourceId, pipeSourceId: null,
            renderedFaceSourceIds: result.renderedFaces.map((face) => faceSourceId.get(face)).filter((id): id is string => id !== undefined),
          }));
        }
        if (result.unrenderedFaces.length === 0) continue;
        if (result.unrenderedFaces.length < currentFaces.length) {
          pending.push(result.unrenderedFaces);
        } else if (currentFaces.length > 1) {
          const middle = Math.ceil(currentFaces.length / 2);
          pending.push(currentFaces.slice(0, middle), currentFaces.slice(middle));
        } else {
          unrepresentableFaces++;
        }
      }
    }
  }
  return { components, droppedDegenerateFaces: degenerateFaces, droppedPrecisionFaces: unrepresentableFaces };
}

/** Adapt Rust-parsed LandXML 1.2 TIN semantics into the viewer's mesh payload. */
export function parseLandXmlGeometry(
  parsed: LandXmlTinDocument,
  preflight?: LandXmlGeometryPreflight,
): LandXmlGeometryPayload {
  const warnings = [...parsed.warnings, ...pipeRefusalWarnings(parsed)];
  const renderableSurfaces = parsed.surfaces.filter((surface) => (
    surface.renderState === 'rendered' && surface.faceVisibility.some(Boolean)
  ));
  if (renderableSurfaces.length > 0 && parsed.units === null) {
    throw new Error('LandXML has renderable TIN topology but no Units declaration');
  }
  if (renderableSurfaces.length === 0 && !parsed.pipeNetworks) {
    return {
      geometryResult: {
        meshes: [], totalVertices: 0, totalTriangles: 0,
        coordinateInfo: sourceCoordinateInfo(parsed),
      },
      schemaVersion: 'IFC4',
      warnings,
      surfaceNames: [],
      semanticDocument: { ...parsed, rendering: { meshProvenance: [], surfaceCounts: parsed.surfaces.map((surface) => ({
        surfaceSourceId: surface.sourceId,
        sourcePoints: surface.points.length,
        sourceFaces: surface.faces.length,
        hiddenFaces: surface.hiddenFaceCount,
        renderedFaces: 0,
        droppedDegenerateFaces: 0,
        droppedPrecisionFaces: 0,
        droppedReframeFaces: 0,
      })) } },
    };
  }
  // Direct ingestion deliberately uses the same discard-after-measurement
  // frame policy as the two-pass Blob cursor path.
  const placementPreflight = preflight ?? preflightLandXmlGeometry(parsed);
  const components: LandXmlGeometryComponent[] = [];
  const droppedBySurface = new Map<string, { degenerate: number; precision: number }>();
  for (const surface of renderableSurfaces) {
    const built = buildLandXmlSurfaceComponents(surface, parsed.units!, components.length + 1);
    components.push(...built.components);
    if (built.droppedDegenerateFaces > 0) {
      warnings.push(`Skipped ${built.droppedDegenerateFaces} degenerate face(s) in surface "${surface.name}"`);
    }
    if (built.droppedPrecisionFaces > 0) {
      warnings.push(`Skipped ${built.droppedPrecisionFaces} face(s) in surface "${surface.name}" because their coordinate span exceeds render precision`);
    }
    if (built.components.length === 0) {
      warnings.push(`Skipped surface "${surface.name}" because it has no non-degenerate faces`);
    }
    droppedBySurface.set(surface.sourceId, { degenerate: built.droppedDegenerateFaces, precision: built.droppedPrecisionFaces });
  }
  const pipeGeometry = buildLandXmlPipeComponents(parsed.pipeNetworks ?? null, components.length + 1);
  warnings.push(...pipeGeometry.warnings);
  for (const pipe of pipeGeometry.components) {
    components.push(...fragmentLandXmlGeometryComponent({
      ...pipe, surfaceName: pipe.name, surfaceSourceId: null, pipeSourceId: pipe.sourceId, renderedFaceSourceIds: [],
    }));
  }
  if (components.length !== placementPreflight.componentCount) {
    throw new Error('LandXML second pass did not reproduce its preflight component envelope');
  }
  if (components.length === 0) {
    return {
      geometryResult: { meshes: [], totalVertices: 0, totalTriangles: 0, coordinateInfo: sourceCoordinateInfo(parsed) },
      schemaVersion: 'IFC4', warnings, surfaceNames: [],
      semanticDocument: { ...parsed, rendering: { meshProvenance: [], surfaceCounts: parsed.surfaces.map((surface) => ({ surfaceSourceId: surface.sourceId, sourcePoints: surface.points.length, sourceFaces: surface.faces.length, hiddenFaces: surface.hiddenFaceCount, renderedFaces: 0, droppedDegenerateFaces: 0, droppedPrecisionFaces: 0, droppedReframeFaces: 0 })) } },
    };
  }

  const { components: placed, dropped: reframeDropped, geometry: geometryResult } = placeAndAssignLandXmlComponents(
    components,
    warnings,
    placementPreflight.frame ?? undefined,
  );
  const surfaceNames = [...new Set(placed.map((component) => component.surfaceName))];
  return {
    geometryResult,
    schemaVersion: 'IFC4',
    warnings,
    surfaceNames,
    semanticDocument: {
      ...parsed,
      rendering: {
        meshProvenance: placed.map((component) => ({ meshExpressId: component.mesh.expressId, surfaceSourceId: component.surfaceSourceId ?? '', renderedFaceSourceIds: component.renderedFaceSourceIds, ...(component.pipeSourceId ? { pipeSourceId: component.pipeSourceId } : {}) })),
        surfaceCounts: parsed.surfaces.map((surface) => {
          const componentsForSurface = placed.filter((component) => component.surfaceSourceId === surface.sourceId);
          const renderedFaces = componentsForSurface.reduce((count, component) => count + component.renderedFaceSourceIds.length, 0);
          const droppedReframeFaces = reframeDropped
            .filter((component) => component.surfaceSourceId === surface.sourceId)
            .reduce((count, component) => count + component.renderedFaceSourceIds.length, 0);
          const dropped = droppedBySurface.get(surface.sourceId) ?? { degenerate: 0, precision: 0 };
          return { surfaceSourceId: surface.sourceId, sourcePoints: surface.points.length, sourceFaces: surface.faces.length,
            hiddenFaces: surface.hiddenFaceCount, renderedFaces, droppedDegenerateFaces: dropped.degenerate,
            droppedPrecisionFaces: dropped.precision, droppedReframeFaces };
        }),
      },
    },
  };
}
