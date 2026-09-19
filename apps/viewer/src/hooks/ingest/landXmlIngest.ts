/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { GeometryResult, MeshData } from '@ifc-lite/geometry';
import { calculateMeshBounds, createCoordinateInfo } from '../../utils/localParsingUtils.js';
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

function buildSurfaceMesh(
  surface: LandXmlTinSurface,
  expressId: number,
  linearScale: number,
  elevationScale: number,
): { mesh: MeshData | null; degenerateFaces: number } {
  const worldById = new Map<string, WorldPoint>();
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
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
    minX = Math.min(minX, world.x); minY = Math.min(minY, world.y); minZ = Math.min(minZ, world.z);
    maxX = Math.max(maxX, world.x); maxY = Math.max(maxY, world.y); maxZ = Math.max(maxZ, world.z);
  }

  // Survey coordinates routinely sit hundreds of kilometres from zero. Keep
  // them in f64 until this per-surface origin is removed, then store the local
  // residuals as f32. MeshData.origin restores the exact world placement.
  const origin: [number, number, number] = [
    (minX + maxX) / 2,
    (minY + maxY) / 2,
    (minZ + maxZ) / 2,
  ];
  const positions = new Float32Array(surface.points.length * 3);
  const indexById = new Map<string, number>();
  surface.points.forEach((point, index) => {
    const world = worldById.get(point.id)!;
    indexById.set(point.id, index);
    positions[index * 3] = world.x - origin[0];
    positions[index * 3 + 1] = world.y - origin[1];
    positions[index * 3 + 2] = world.z - origin[2];
  });

  const indices: number[] = [];
  const normalSums = new Float64Array(positions.length);
  let degenerateFaces = 0;
  for (const face of surface.faces) {
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
      degenerateFaces++;
      continue;
    }
    // LandXML does not promise a terrain-face winding. Point the normal up so
    // lighting is stable while retaining the same geometric triangle.
    if (ny < 0) {
      [b, c] = [c, b];
      nx = -nx; ny = -ny; nz = -nz;
    }
    indices.push(a, b, c);
    for (const index of [a, b, c]) {
      normalSums[index * 3] += nx;
      normalSums[index * 3 + 1] += ny;
      normalSums[index * 3 + 2] += nz;
    }
  }
  if (indices.length === 0) return { mesh: null, degenerateFaces };

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
  };
}

/** Parse LandXML 1.2 TIN surfaces into the viewer's canonical mesh payload. */
export function parseLandXmlGeometry(buffer: ArrayBuffer): LandXmlGeometryPayload {
  let xml: string;
  try {
    xml = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch (error) {
    throw new Error(`LandXML must be UTF-8: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = parseLandXmlTin(xml);
  const warnings = [...parsed.warnings];
  const meshes: MeshData[] = [];
  const surfaceNames: string[] = [];
  for (const surface of parsed.surfaces) {
    const result = buildSurfaceMesh(
      surface,
      meshes.length + 1,
      parsed.units.linearScaleToMeters,
      parsed.units.elevationScaleToMeters,
    );
    if (result.degenerateFaces > 0) {
      warnings.push(`Skipped ${result.degenerateFaces} degenerate face(s) in surface "${surface.name}"`);
    }
    if (!result.mesh) {
      warnings.push(`Skipped surface "${surface.name}" because it has no non-degenerate faces`);
      continue;
    }
    meshes.push(result.mesh);
    surfaceNames.push(surface.name);
  }
  if (meshes.length === 0) throw new Error('LandXML document contains no non-degenerate TIN faces');

  const { bounds, stats } = calculateMeshBounds(meshes);
  const maxAbs = Math.max(
    Math.abs(bounds.min.x), Math.abs(bounds.min.y), Math.abs(bounds.min.z),
    Math.abs(bounds.max.x), Math.abs(bounds.max.y), Math.abs(bounds.max.z),
  );
  return {
    geometryResult: {
      meshes,
      totalVertices: stats.totalVertices,
      totalTriangles: stats.totalTriangles,
      coordinateInfo: createCoordinateInfo(bounds, { x: 0, y: 0, z: 0 }, maxAbs > 10_000),
    },
    schemaVersion: 'IFC4',
    warnings,
    surfaceNames,
  };
}
