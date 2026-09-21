/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Bounded, source-faithful pipe route meshes for the LandXML adapter. */

import type { MeshData } from '@ifc-lite/geometry';
import type { Bounds3D } from '../../utils/localParsingUtils.js';
import type { LandXmlPipe, LandXmlPipeNetworkDocument, LandXmlPipePart, LandXmlPipePosition, LandXmlPipeStructure } from './landXmlSemantics.js';

const SIDES = 10;
const MAX_PIPE_MESHES = 10_000;
const MAX_PIPE_WARNINGS = 1_000;

interface Point { x: number; y: number; z: number }
interface CrossSection { points: Array<readonly [number, number]> }
export interface PipeComponent { mesh: MeshData; bounds: Bounds3D; sourceId: string; name: string }
export interface PipeGeometryResult { components: PipeComponent[]; warnings: string[] }

function isPoint(value: Point | string | null): value is Point {
  return typeof value === 'object' && value !== null;
}

function point(position: LandXmlPipePosition, elevation = position.elevation?.meters): Point | null {
  return elevation === undefined || !Number.isFinite(elevation)
    ? null
    : { x: position.eastingMeters, y: elevation, z: -position.northingMeters };
}

function section(part: LandXmlPipePart): CrossSection | string {
  const ellipse = (width: number, height: number): CrossSection | string => {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return 'cross-section dimensions must be positive finite metres';
    return { points: Array.from({ length: SIDES }, (_, side) => [width * Math.cos(side * Math.PI * 2 / SIDES) / 2, height * Math.sin(side * Math.PI * 2 / SIDES) / 2] as const) };
  };
  if (part.kind === 'circular') return part.diameter ? ellipse(part.diameter.meters, part.diameter.meters) : 'Circular pipe is missing diameter';
  if (part.kind === 'elliptical') return part.span && part.height ? ellipse(part.span.meters, part.height.meters) : 'Elliptical pipe is missing span or height';
  if (part.kind === 'rectangular') {
    if (!part.width || !part.height) return 'Rectangular pipe is missing width or height';
    const width = part.width.meters, height = part.height.meters;
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return 'cross-section dimensions must be positive finite metres';
    return { points: [[-width / 2, -height / 2], [width / 2, -height / 2], [width / 2, height / 2], [-width / 2, height / 2]] };
  }
  return 'Egg pipe cross-section is retained but not rendered';
}

function endpoint(structure: LandXmlPipeStructure | undefined, pipe: LandXmlPipe): Point | string | null {
  if (!structure) return null;
  const inverts = structure.inverts.filter((candidate) => candidate.pipeSourceId === pipe.sourceId);
  if (inverts.length > 1) {
    const elevation = inverts[0]!.elevation.meters;
    if (!inverts.every((candidate) => Math.abs(candidate.elevation.meters - elevation) <= 1e-9)) {
      return 'endpoint has conflicting authored Invert elevations';
    }
  }
  return point(structure.center, inverts[0]?.elevation.meters);
}

function addSegment(points: Point[], start: Point, end: Point, shape: CrossSection): void {
  const dx = end.x - start.x, dy = end.y - start.y, dz = end.z - start.z, length = Math.hypot(dx, dy, dz);
  if (!Number.isFinite(length) || length <= Number.EPSILON) return;
  const axis = { x: dx / length, y: dy / length, z: dz / length };
  const helper = Math.abs(axis.y) < 0.9 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
  const uLength = Math.hypot(axis.y * helper.z - axis.z * helper.y, axis.z * helper.x - axis.x * helper.z, axis.x * helper.y - axis.y * helper.x);
  const u = { x: (axis.y * helper.z - axis.z * helper.y) / uLength, y: (axis.z * helper.x - axis.x * helper.z) / uLength, z: (axis.x * helper.y - axis.y * helper.x) / uLength };
  const v = { x: axis.y * u.z - axis.z * u.y, y: axis.z * u.x - axis.x * u.z, z: axis.x * u.y - axis.y * u.x };
  for (const endpoint of [start, end]) for (const [width, height] of shape.points) {
    points.push({ x: endpoint.x + u.x * width + v.x * height, y: endpoint.y + u.y * width + v.y * height, z: endpoint.z + u.z * width + v.z * height });
  }
}

function meshForRoute(route: Point[], shape: CrossSection, expressId: number): { mesh: MeshData; bounds: Bounds3D } | null {
  const rings: Point[] = [];
  // Each declared segment owns its endpoint rings. LandXML Pipe/Center is a
  // pass-through point, not a tangent or radius contract, so no cap or
  // interpolated bend is fabricated at a joint.
  for (let index = 1; index < route.length; index++) addSegment(rings, route[index - 1], route[index], shape);
  if (rings.length === 0) return null;
  const origin = route.reduce((total, item) => ({ x: total.x + item.x / route.length, y: total.y + item.y / route.length, z: total.z + item.z / route.length }), { x: 0, y: 0, z: 0 });
  const positions = new Float32Array(rings.length * 3), normals = new Float32Array(rings.length * 3), indices: number[] = [];
  let min = { x: Infinity, y: Infinity, z: Infinity }, max = { x: -Infinity, y: -Infinity, z: -Infinity };
  rings.forEach((item, index) => { positions.set([item.x - origin.x, item.y - origin.y, item.z - origin.z], index * 3); min = { x: Math.min(min.x, item.x), y: Math.min(min.y, item.y), z: Math.min(min.z, item.z) }; max = { x: Math.max(max.x, item.x), y: Math.max(max.y, item.y), z: Math.max(max.z, item.z) }; });
  const sides = shape.points.length;
  for (let segment = 0; segment < rings.length / (sides * 2); segment++) for (let side = 0; side < sides; side++) {
    const start = segment * sides * 2, next = (side + 1) % sides;
    indices.push(start + side, start + next, start + sides + next, start + side, start + sides + next, start + sides + side);
  }
  const sums = new Float64Array(positions.length);
  for (let index = 0; index < indices.length; index += 3) {
    const [a, b, c] = [indices[index], indices[index + 1], indices[index + 2]];
    const ab = [positions[b * 3] - positions[a * 3], positions[b * 3 + 1] - positions[a * 3 + 1], positions[b * 3 + 2] - positions[a * 3 + 2]];
    const ac = [positions[c * 3] - positions[a * 3], positions[c * 3 + 1] - positions[a * 3 + 1], positions[c * 3 + 2] - positions[a * 3 + 2]];
    const normal = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
    for (const vertex of [a, b, c]) { sums[vertex * 3] += normal[0]; sums[vertex * 3 + 1] += normal[1]; sums[vertex * 3 + 2] += normal[2]; }
  }
  for (let index = 0; index < normals.length; index += 3) {
    const length = Math.hypot(sums[index], sums[index + 1], sums[index + 2]);
    // The cross-product can be much smaller than Number.EPSILON for a valid
    // authored micro-pipe. Normalize every representable finite vector rather
    // than turning its lighting normal into zero.
    if (!Number.isFinite(length) || length === 0) return null;
    normals[index] = sums[index] / length;
    normals[index + 1] = sums[index + 1] / length;
    normals[index + 2] = sums[index + 2] / length;
  }
  return { mesh: { expressId, positions, normals, indices: new Uint32Array(indices), color: [0.2, 0.48, 0.8, 1], origin: [origin.x, origin.y, origin.z] }, bounds: { min, max } };
}

/** Build pickable meshes only where every authored route coordinate is present. */
export function buildLandXmlPipeComponents(document: LandXmlPipeNetworkDocument | null, firstExpressId: number): PipeGeometryResult {
  const components: PipeComponent[] = [], warnings: string[] = [];
  if (!document) return { components, warnings };
  const pipeRefusals = new Map<string, string>();
  const knownPipeIds = new Set<string>();
  for (const network of document.networks) for (const pipe of network.pipes) knownPipeIds.add(pipe.sourceId);
  for (const refusal of document.refusals) {
    if (knownPipeIds.has(refusal.sourceId) && !pipeRefusals.has(refusal.sourceId)) pipeRefusals.set(refusal.sourceId, refusal.message);
  }
  const refuse = (pipe: LandXmlPipe, reason: string): void => { if (warnings.length < MAX_PIPE_WARNINGS) warnings.push(`Skipped LandXML pipe ${pipe.name} (${pipe.sourceId}): ${reason}`); };
  for (const network of document.networks) {
    const structures = new Map(network.structures.map((structure) => [structure.sourceId, structure]));
    for (const pipe of network.pipes) {
      if (components.length >= MAX_PIPE_MESHES) return { components, warnings };
      const sourceRefusal = pipeRefusals.get(pipe.sourceId);
      if (sourceRefusal) { refuse(pipe, `source semantic refusal: ${sourceRefusal}`); continue; }
      const shape = section(pipe.part);
      if (typeof shape === 'string') { refuse(pipe, shape); continue; }
      const start = endpoint(structures.get(pipe.connectivity.startStructureSourceId), pipe), end = endpoint(structures.get(pipe.connectivity.endStructureSourceId), pipe);
      const passThrough = pipe.geometry.kind === 'pass_through' && pipe.geometry.point ? point(pipe.geometry.point) : undefined;
      const endpointError = typeof start === 'string' ? start : typeof end === 'string' ? end : null;
      if (endpointError) { refuse(pipe, endpointError); continue; }
      if (!isPoint(start) || !isPoint(end) || (pipe.geometry.kind === 'pass_through' && !passThrough)) { refuse(pipe, 'route requires finite northing, easting, and elevation at every endpoint and pass-through Center'); continue; }
      const built = meshForRoute(passThrough ? [start, passThrough, end] : [start, end], shape, firstExpressId + components.length);
      if (built) components.push({ ...built, sourceId: pipe.sourceId, name: pipe.name }); else refuse(pipe, 'route segments must have non-zero finite length');
    }
  }
  return { components, warnings };
}
