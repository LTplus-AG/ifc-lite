/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { RhinoVector3 } from '../types.js';
import { dispose } from '../runtime.js';
import type { RBrep, RCurve, RMesh, RPointCloud, ReadApi } from './rhino-api.js';
import type { Report } from './report.js';
import { plural } from './report.js';
import { isUsable, type Xform } from './xform.js';

/** One object's geometry in its own space, already in metres. */
export type Part =
  | { kind: 'mesh'; origin: RhinoVector3; positions: Float32Array; normals: Float32Array; indices: Uint32Array }
  | { kind: 'curve'; origin: RhinoVector3; positions: Float32Array; closed: boolean }
  | { kind: 'points'; origin: RhinoVector3; positions: Float32Array; colors: Uint8Array | null }
  | { kind: 'dot'; position: RhinoVector3; text: string }
  | { kind: 'instance'; definition: string; xform: Xform };

export interface GeometryContext { api: ReadApi; scale: number; subdLevel: number; report: Report }

/** Samples per curve span, and the most samples one curve gets. */
const SAMPLES_PER_SPAN = 32;
const MAX_CURVE_SAMPLES = 8192;

function finite3(p: number[] | undefined): p is RhinoVector3 {
  return !!p && Number.isFinite(p[0]) && Number.isFinite(p[1]) && Number.isFinite(p[2]);
}

/** Points as f32 offsets from the first one, which stays f64. Null for no points or a value f32 cannot hold. */
function relative(points: number[][], scale: number): { origin: RhinoVector3; positions: Float32Array } | null {
  const first = points[0];
  if (!finite3(first)) return null;
  const positions = new Float32Array(points.length * 3);
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    for (let k = 0; k < 3; k++) {
      const value = positions[i * 3 + k] = (p?.[k] - first[k]) * scale;
      if (!Number.isFinite(value)) return null;
    }
  }
  return { origin: [first[0] * scale, first[1] * scale, first[2] * scale], positions };
}

/**
 * Triangles of a mesh, relative to its first vertex. The vertices are doubles
 * and `toThreejsBuffers` emits f32, so the mesh is moved to its first vertex
 * before the call; the origin keeps the double. This edits the mesh in the
 * file, which is read once and then released.
 */
function meshPart(mesh: RMesh, type: string, { scale, report }: GeometryContext): Part | null {
  const vertices = mesh.vertices();
  let origin: number[] | undefined;
  try { if (vertices.count > 0) origin = vertices.point3dAt(0); } finally { dispose(vertices); }
  if (!origin) { report.skip(`${type}:empty`); return null; }
  if (!finite3(origin)) { report.skip(`${type}:invalid`); return null; }
  mesh.translate([-origin[0], -origin[1], -origin[2]]);
  const { position: positions, normal: normals, index: indices } = mesh.toThreejsBuffers(false);
  if (indices.length === 0) { report.skip(`${type}:empty`); return null; }
  const vertexCount = positions.length / 3;
  let valid = normals.length === positions.length && indices.length % 3 === 0;
  for (let i = 0; valid && i < positions.length; i++) {
    positions[i] *= scale;
    valid = Number.isFinite(positions[i]) && Number.isFinite(normals[i]);
  }
  for (let i = 0; valid && i < indices.length; i++) valid = indices[i] < vertexCount;
  if (!valid) { report.skip(`${type}:invalid`); return null; }
  return { kind: 'mesh', origin: [origin[0] * scale, origin[1] * scale, origin[2] * scale], positions, normals, indices };
}

/** A Brep draws through the render meshes Rhino cached on its faces; rhino3dm.js cannot mesh. */
function brepPart(faces: ReturnType<RBrep['faces']>, ctx: GeometryContext): Part | null {
  const merged = new ctx.api.Mesh();
  try {
    let meshed = 0;
    for (let i = 0; i < faces.count; i++) {
      const face = faces.get(i);
      let mesh: RMesh | null = null;
      try {
        mesh = face.getMesh(ctx.api.MeshType.Any);
        if (mesh) { merged.append(mesh); meshed++; }
      } finally { dispose(mesh); dispose(face); }
    }
    if (meshed === 0) { ctx.report.skip('Brep:no-render-mesh'); return null; }
    if (meshed < faces.count) {
      ctx.report.warn('brep-partial', n => `${plural(n, 'Brep')} show only the faces that have a render mesh.`);
    }
    return meshPart(merged, 'Brep', ctx);
  } finally { dispose(merged); }
}

function curvePart(curve: RCurve, type: string, { scale, report }: GeometryContext): Part | null {
  const points: number[][] = [];
  const polyline = curve.tryGetPolyline();
  if (polyline) {
    try { for (let i = 0; i < polyline.count; i++) points.push(polyline.get(i)); } finally { dispose(polyline); }
  } else {
    const [t0, t1] = curve.domain;
    const segments = Math.min(Math.max(curve.spanCount, 1) * SAMPLES_PER_SPAN, MAX_CURVE_SAMPLES);
    for (let i = 0; i <= segments; i++) points.push(curve.pointAt(t0 + (t1 - t0) * (i / segments)));
  }
  const line = points.length >= 2 ? relative(points, scale) : null;
  if (!line) { report.skip(`${type}:invalid`); return null; }
  return { kind: 'curve', ...line, closed: curve.isClosed };
}

function pointCloudPart(cloud: RPointCloud, { scale, report }: GeometryContext): Part | null {
  const points = cloud.count > 0 ? relative(cloud.getPoints(), scale) : null;
  if (!points) { report.skip(cloud.count > 0 ? 'PointCloud:invalid' : 'PointCloud:empty'); return null; }
  let colors: Uint8Array | null = null;
  if (cloud.containsColors) {
    const source = cloud.getColors();
    colors = new Uint8Array(source.length * 4);
    source.forEach((c, i) => colors!.set([c.r, c.g, c.b, c.a], i * 4));
    if (colors.length !== points.positions.length / 3 * 4) colors = null;
  }
  return { kind: 'points', ...points, colors };
}

/**
 * Turn one Rhino geometry into a plain part, or count why it is not drawn and
 * return null. `type` is the Rhino class name, which is also the skip key.
 */
export function extractGeometry(geometry: object, type: string, ctx: GeometryContext): Part | null {
  const { api, scale, report } = ctx;
  if (geometry instanceof api.InstanceReference) {
    const source = geometry.xform;
    try {
      // toFloatArray(true) rounds to f32; the mRC properties are the doubles.
      const xform: Xform = [];
      for (let row = 0; row < 4; row++) for (let col = 0; col < 4; col++) xform.push(source[`m${row}${col}`]);
      for (const i of [3, 7, 11]) xform[i] *= scale;
      if (!isUsable(xform)) { report.skip('InstanceReference:invalid'); return null; }
      return { kind: 'instance', definition: geometry.parentIdefId, xform };
    } finally { dispose(source); }
  }
  if (geometry instanceof api.Mesh) return meshPart(geometry, type, ctx);
  if (geometry instanceof api.Brep) {
    const faces = geometry.faces();
    try { return brepPart(faces, ctx); } finally { dispose(faces); }
  }
  if (geometry instanceof api.Extrusion) {
    const mesh = geometry.getMesh(api.MeshType.Any);
    if (!mesh) { report.skip('Extrusion:no-render-mesh'); return null; }
    try { return meshPart(mesh, type, ctx); } finally { dispose(mesh); }
  }
  if (geometry instanceof api.SubD) {
    if (ctx.subdLevel > 0) geometry.subdivide(ctx.subdLevel);
    const net = api.Mesh.createFromSubDControlNet(geometry, false);
    if (!net) { report.skip('SubD:invalid'); return null; }
    try {
      const part = meshPart(net, type, ctx);
      if (part) report.warn('subd', n => `${plural(n, 'SubD object')} shown as the control net at subdivision level ${ctx.subdLevel}, an approximation of the limit surface.`);
      return part;
    } finally { dispose(net); }
  }
  if (geometry instanceof api.PointCloud) return pointCloudPart(geometry, ctx);
  if (geometry instanceof api.TextDot) {
    const point = geometry.point;
    if (!finite3(point)) { report.skip('TextDot:invalid'); return null; }
    return { kind: 'dot', position: [point[0] * scale, point[1] * scale, point[2] * scale], text: geometry.text };
  }
  if (geometry instanceof api.Curve) return curvePart(geometry, type, ctx);
  report.skip(type);
  return null;
}
