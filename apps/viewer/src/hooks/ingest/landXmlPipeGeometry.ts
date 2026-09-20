/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Bounded, source-faithful pipe route meshes for the LandXML adapter. */

import type { MeshData } from '@ifc-lite/geometry';
import type { Bounds3D } from '../../utils/localParsingUtils.js';
import type { LandXmlPipeNetworkDocument, LandXmlPipePosition } from './landXmlSemantics.js';

const SIDES = 10;
const MAX_PIPE_MESHES = 10_000;

interface Point { x: number; y: number; z: number }
export interface PipeComponent { mesh: MeshData; bounds: Bounds3D; sourceId: string; name: string }

function point(position: LandXmlPipePosition): Point | null {
  const elevation = position.elevation?.meters;
  return elevation === undefined ? null : { x: position.eastingMeters, y: elevation, z: -position.northingMeters };
}

function radius(part: { diameter?: { meters: number }; span?: { meters: number }; width?: { meters: number }; height?: { meters: number } }): number | null {
  const diameter = part.diameter?.meters ?? part.span?.meters ?? part.width?.meters ?? part.height?.meters;
  return diameter === undefined || !Number.isFinite(diameter) || diameter <= 0 ? null : diameter / 2;
}

function addSegment(points: Point[], start: Point, end: Point, pipeRadius: number): void {
  const dx = end.x - start.x, dy = end.y - start.y, dz = end.z - start.z;
  const length = Math.hypot(dx, dy, dz);
  if (!Number.isFinite(length) || length <= Number.EPSILON) return;
  const axis = { x: dx / length, y: dy / length, z: dz / length };
  const helper = Math.abs(axis.y) < 0.9 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
  const uLength = Math.hypot(axis.y * helper.z - axis.z * helper.y, axis.z * helper.x - axis.x * helper.z, axis.x * helper.y - axis.y * helper.x);
  const u = { x: (axis.y * helper.z - axis.z * helper.y) / uLength, y: (axis.z * helper.x - axis.x * helper.z) / uLength, z: (axis.x * helper.y - axis.y * helper.x) / uLength };
  const v = { x: axis.y * u.z - axis.z * u.y, y: axis.z * u.x - axis.x * u.z, z: axis.x * u.y - axis.y * u.x };
  for (const endpoint of [start, end]) for (let side = 0; side < SIDES; side++) {
    const angle = side * Math.PI * 2 / SIDES, cosine = Math.cos(angle), sine = Math.sin(angle);
    points.push({ x: endpoint.x + pipeRadius * (u.x * cosine + v.x * sine), y: endpoint.y + pipeRadius * (u.y * cosine + v.y * sine), z: endpoint.z + pipeRadius * (u.z * cosine + v.z * sine) });
  }
}

function meshForRoute(route: Point[], pipeRadius: number, expressId: number): { mesh: MeshData; bounds: Bounds3D } | null {
  const rings: Point[] = [];
  for (let index = 1; index < route.length; index++) addSegment(rings, route[index - 1], route[index], pipeRadius);
  if (rings.length === 0) return null;
  const origin = route.reduce((total, item) => ({ x: total.x + item.x / route.length, y: total.y + item.y / route.length, z: total.z + item.z / route.length }), { x: 0, y: 0, z: 0 });
  const positions = new Float32Array(rings.length * 3), normals = new Float32Array(rings.length * 3), indices: number[] = [];
  let min = { x: Infinity, y: Infinity, z: Infinity }, max = { x: -Infinity, y: -Infinity, z: -Infinity };
  rings.forEach((item, index) => {
    positions[index * 3] = item.x - origin.x; positions[index * 3 + 1] = item.y - origin.y; positions[index * 3 + 2] = item.z - origin.z;
    const normalLength = Math.hypot(positions[index * 3], positions[index * 3 + 1], positions[index * 3 + 2]) || 1;
    normals[index * 3] = positions[index * 3] / normalLength; normals[index * 3 + 1] = positions[index * 3 + 1] / normalLength; normals[index * 3 + 2] = positions[index * 3 + 2] / normalLength;
    min = { x: Math.min(min.x, item.x), y: Math.min(min.y, item.y), z: Math.min(min.z, item.z) }; max = { x: Math.max(max.x, item.x), y: Math.max(max.y, item.y), z: Math.max(max.z, item.z) };
  });
  for (let segment = 0; segment < rings.length / (SIDES * 2); segment++) for (let side = 0; side < SIDES; side++) {
    const start = segment * SIDES * 2, next = (side + 1) % SIDES;
    indices.push(start + side, start + next, start + SIDES + next, start + side, start + SIDES + next, start + SIDES + side);
  }
  return { mesh: { expressId, positions, normals, indices: new Uint32Array(indices), color: [0.2, 0.48, 0.8, 1], origin: [origin.x, origin.y, origin.z] }, bounds: { min, max } };
}

/** Build one pickable mesh per validated pipe, including declared pass-through routes. */
export function buildLandXmlPipeComponents(document: LandXmlPipeNetworkDocument | null, firstExpressId: number): PipeComponent[] {
  if (!document) return [];
  const result: PipeComponent[] = [];
  for (const network of document.networks) {
    const structures = new Map(network.structures.map((structure) => [structure.sourceId, structure]));
    for (const pipe of network.pipes) {
      if (result.length >= MAX_PIPE_MESHES) return result;
      const start = structures.get(pipe.connectivity.startStructureSourceId), end = structures.get(pipe.connectivity.endStructureSourceId), pipeRadius = radius(pipe.part);
      const route = [start && point(start.center), pipe.geometry.point && point(pipe.geometry.point), end && point(end.center)].filter((item): item is Point => item !== null && item !== undefined);
      if (!pipeRadius || route.length < 2) continue;
      const built = meshForRoute(route, pipeRadius, firstExpressId + result.length);
      if (built) result.push({ ...built, sourceId: pipe.sourceId, name: pipe.name });
    }
  }
  return result;
}
