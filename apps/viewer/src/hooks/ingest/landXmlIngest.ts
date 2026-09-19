/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { GeometryResult, MeshData } from '@ifc-lite/geometry';
import { createCoordinateInfo, createEmptyBounds, type Bounds3D } from '../../utils/localParsingUtils.js';
import { parseLandXmlTin, type LandXmlTinSurface } from './landXmlTin.js';

export interface LandXmlGeometryPayload {
  geometryResult: GeometryResult;
  schemaVersion: 'IFC4';
  warnings: string[];
  surfaceNames: string[];
}

export function isLandXmlFileName(name: string): boolean {
  return name.toLowerCase().endsWith('.xml');
}

interface WorldPoint {
  x: number;
  y: number;
  z: number;
}

export function connectedFaceComponents(
  faces: LandXmlTinSurface['faces'],
): Array<LandXmlTinSurface['faces']> {
  const faceIndexesByPoint = new Map<string, number[]>();
  faces.forEach((face, faceIndex) => {
    for (const pointId of face) {
      const indexes = faceIndexesByPoint.get(pointId) ?? [];
      indexes.push(faceIndex);
      faceIndexesByPoint.set(pointId, indexes);
    }
  });

  const visited = new Uint8Array(faces.length);
  const components: Array<LandXmlTinSurface['faces']> = [];
  for (let start = 0; start < faces.length; start++) {
    if (visited[start]) continue;
    const component: LandXmlTinSurface['faces'] = [];
    const pending = [start];
    const processedPointIds = new Set<string>();
    visited[start] = 1;
    while (pending.length > 0) {
      const faceIndex = pending.pop()!;
      const face = faces[faceIndex];
      component.push(face);
      for (const pointId of face) {
        if (processedPointIds.has(pointId)) continue;
        processedPointIds.add(pointId);
        for (const neighbour of faceIndexesByPoint.get(pointId) ?? []) {
          if (visited[neighbour]) continue;
          visited[neighbour] = 1;
          pending.push(neighbour);
        }
      }
    }
    components.push(component);
  }
  return components;
}

function xmlEncoding(bytes: Uint8Array): string {
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be';
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le';
  if (bytes[0] === 0x00 && bytes[1] === 0x3c && bytes[2] === 0x00 && bytes[3] === 0x3f) {
    return 'utf-16be';
  }
  if (bytes[0] === 0x3c && bytes[1] === 0x00 && bytes[2] === 0x3f && bytes[3] === 0x00) {
    return 'utf-16le';
  }
  const declaration = Array.from(bytes.subarray(0, 256), (byte) => (
    byte < 0x80 ? String.fromCharCode(byte) : ' '
  )).join('');
  return /<\?xml\s[^>]*encoding\s*=\s*(['"])([^'"]+)\1/i.exec(declaration)?.[2] || 'utf-8';
}

function decodeXml(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const encoding = xmlEncoding(bytes);
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(bytes);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot decode LandXML as ${encoding}: ${message}`);
  }
}

function buildSurfaceMesh(
  surface: LandXmlTinSurface,
  expressId: number,
  linearScale: number,
  elevationScale: number,
  originOverride?: [number, number, number],
): { mesh: MeshData | null; degenerateFaces: number; bounds: Bounds3D | null; unrenderedFaces: LandXmlTinSurface['faces'] } {
  const worldById = new Map<string, WorldPoint>();
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
  if (retainedFaces.length === 0) return { mesh: null, degenerateFaces, bounds: null, unrenderedFaces: [] };

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
      const retried = buildSurfaceMesh(surface, expressId, linearScale, elevationScale, [a.x, a.y, a.z]);
      return { ...retried, degenerateFaces: degenerateFaces + retried.degenerateFaces };
    }
    return { mesh: null, degenerateFaces, bounds: null, unrenderedFaces };
  }
  if (renderedFaces.length !== retainedFaces.length) {
    const compacted = buildSurfaceMesh(
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
    unrenderedFaces: [],
  };
}

/** Parse LandXML 1.2 TIN surfaces into the viewer's canonical mesh payload. */
export function parseLandXmlGeometry(buffer: ArrayBuffer): LandXmlGeometryPayload {
  const parsed = parseLandXmlTin(decodeXml(buffer));
  const warnings = [...parsed.warnings];
  const meshes: MeshData[] = [];
  const surfaceNames: string[] = [];
  const bounds = createEmptyBounds();
  for (const surface of parsed.surfaces) {
    let renderedComponents = 0;
    let degenerateFaces = 0;
    let unrepresentableFaces = 0;
    for (const faces of connectedFaceComponents(surface.faces)) {
      const pending = [faces];
      while (pending.length > 0) {
        const currentFaces = pending.pop()!;
        const result = buildSurfaceMesh(
          { ...surface, faces: currentFaces },
          meshes.length + 1,
          parsed.units.linearScaleToMeters,
          parsed.units.elevationScaleToMeters,
        );
        degenerateFaces += result.degenerateFaces;
        if (result.mesh) {
          renderedComponents++;
          meshes.push(result.mesh);
        }
        if (result.bounds) {
          bounds.min.x = Math.min(bounds.min.x, result.bounds.min.x);
          bounds.min.y = Math.min(bounds.min.y, result.bounds.min.y);
          bounds.min.z = Math.min(bounds.min.z, result.bounds.min.z);
          bounds.max.x = Math.max(bounds.max.x, result.bounds.max.x);
          bounds.max.y = Math.max(bounds.max.y, result.bounds.max.y);
          bounds.max.z = Math.max(bounds.max.z, result.bounds.max.z);
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
    if (degenerateFaces > 0) {
      warnings.push(`Skipped ${degenerateFaces} degenerate face(s) in surface "${surface.name}"`);
    }
    if (unrepresentableFaces > 0) {
      warnings.push(`Skipped ${unrepresentableFaces} face(s) in surface "${surface.name}" because their coordinate span exceeds render precision`);
    }
    if (renderedComponents === 0) {
      warnings.push(`Skipped surface "${surface.name}" because it has no non-degenerate faces`);
      continue;
    }
    surfaceNames.push(surface.name);
  }
  if (meshes.length === 0) throw new Error('LandXML document contains no non-degenerate TIN faces');

  const stats = meshes.reduce((total, mesh) => ({
    totalVertices: total.totalVertices + mesh.positions.length / 3,
    totalTriangles: total.totalTriangles + mesh.indices.length / 3,
  }), { totalVertices: 0, totalTriangles: 0 });
  const maxAbs = Math.max(
    Math.abs(bounds.min.x), Math.abs(bounds.min.y), Math.abs(bounds.min.z),
    Math.abs(bounds.max.x), Math.abs(bounds.max.y), Math.abs(bounds.max.z),
  );
  const hasLargeCoordinates = maxAbs > 10_000;
  const originShift = hasLargeCoordinates
    ? {
      x: (bounds.min.x + bounds.max.x) / 2,
      y: (bounds.min.y + bounds.max.y) / 2,
      z: (bounds.min.z + bounds.max.z) / 2,
    }
    : { x: 0, y: 0, z: 0 };
  if (hasLargeCoordinates) {
    // Keep every uploaded batch in the same camera-safe render frame. Mesh
    // positions are already local to their f64 origin, so moving the origins
    // retains their precision while avoiding a survey-scale f32 model
    // translation in the vertex shader. coordinateInfo records the removed
    // Y-up offset so measurements, federation and exports recover world space.
    for (const mesh of meshes) {
      const origin = mesh.origin ?? [0, 0, 0];
      mesh.origin = [
        origin[0] - originShift.x,
        origin[1] - originShift.y,
        origin[2] - originShift.z,
      ];
    }
  }
  return {
    geometryResult: {
      meshes,
      totalVertices: stats.totalVertices,
      totalTriangles: stats.totalTriangles,
      coordinateInfo: createCoordinateInfo(bounds, originShift, hasLargeCoordinates),
    },
    schemaVersion: 'IFC4',
    warnings,
    surfaceNames,
  };
}
