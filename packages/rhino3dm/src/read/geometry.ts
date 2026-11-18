/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { RhinoVector3 } from '../types.js';
import { dispose } from '../runtime.js';
import type { RBrep, RCurve, RMesh, RPointCloud, ReadApi } from './rhino-api.js';
import { plural, type Report } from './report.js';
import { acceptXform, type Xform } from './xform.js';

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

const scaled = (p: number[], scale: number): RhinoVector3 => [p[0] * scale, p[1] * scale, p[2] * scale];

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
      positions[i * 3 + k] = (p?.[k] - first[k]) * scale;
      // Read back: a finite double beyond the f32 range is stored as Infinity.
      if (!Number.isFinite(positions[i * 3 + k])) return null;
    }
  }
  const origin = scaled(first, scale);
  return finite3(origin) ? { origin, positions } : null;
}

type Buffers = ReturnType<RMesh['toThreejsBuffers']>;

/** Several meshes' buffers as one, with each mesh's indices moved past the vertices before it. */
function joined(parts: Buffers[]): Buffers {
  const position = new Float32Array(parts.reduce((n, p) => n + p.position.length, 0));
  const normal = new Float32Array(parts.reduce((n, p) => n + p.normal.length, 0));
  const index = new Uint32Array(parts.reduce((n, p) => n + p.index.length, 0));
  let vertices = 0, normals = 0, indices = 0;
  for (const part of parts) {
    position.set(part.position, vertices * 3);
    normal.set(part.normal, normals);
    for (let i = 0; i < part.index.length; i++) index[indices + i] = part.index[i] + vertices;
    vertices += part.position.length / 3; normals += part.normal.length; indices += part.index.length;
  }
  return { position, normal, index };
}

/**
 * Triangles of one object's meshes, relative to the first vertex. The vertices
 * are doubles and `toThreejsBuffers` emits f32, so each mesh is moved to that
 * vertex before the call; the origin keeps the double. This edits the meshes
 * in the file, which is read once and then released.
 */
function meshPart(meshes: RMesh[], type: string, { scale, report }: GeometryContext): Part | null {
  let origin: number[] | undefined;
  const buffers: Buffers[] = [];
  for (const mesh of meshes) {
    if (!origin) {
      const vertices = mesh.vertices();
      try { if (vertices.count > 0) origin = vertices.point3dAt(0); } finally { dispose(vertices); }
      if (!origin) continue;
      if (!finite3(origin)) { report.skip(`${type}:invalid`); return null; }
    }
    mesh.translate([-origin[0], -origin[1], -origin[2]]);
    buffers.push(mesh.toThreejsBuffers(false));
  }
  const { position: positions, normal: normals, index: indices } = buffers.length === 1 ? buffers[0] : joined(buffers);
  if (!origin || indices.length === 0) { report.skip(`${type}:empty`); return null; }
  const vertexCount = positions.length / 3;
  let valid = normals.length === positions.length && indices.length % 3 === 0;
  for (let i = 0; valid && i < positions.length; i++) {
    positions[i] *= scale;
    valid = Number.isFinite(positions[i]) && Number.isFinite(normals[i]);
  }
  for (let i = 0; valid && i < indices.length; i++) valid = indices[i] < vertexCount;
  if (!valid) { report.skip(`${type}:invalid`); return null; }
  const scaledOrigin = scaled(origin, scale);
  if (!finite3(scaledOrigin)) { report.skip(`${type}:invalid`); return null; }
  return { kind: 'mesh', origin: scaledOrigin, positions, normals, indices };
}

/**
 * A Brep draws through the render meshes Rhino cached on its faces; rhino3dm.js
 * cannot mesh. The faces are joined in JS: `Mesh.append` per face is superlinear
 * (8,000 faces took 14.5 s against 0.2 s this way).
 */
function brepPart(faces: ReturnType<RBrep['faces']>, ctx: GeometryContext): Part | null {
  const meshes: RMesh[] = [];
  try {
    for (let i = 0; i < faces.count; i++) {
      const face = faces.get(i);
      try {
        const mesh = face.getMesh(ctx.api.MeshType.Any);
        if (mesh) meshes.push(mesh);
      } finally { dispose(face); }
    }
    if (meshes.length === 0) { ctx.report.skip('Brep:no-render-mesh'); return null; }
    if (meshes.length < faces.count) {
      ctx.report.warn('brep-partial', n => `${plural(n, 'Brep')} show only the faces that have a render mesh.`);
    }
    return meshPart(meshes, 'Brep', ctx);
  } finally { meshes.forEach(dispose); }
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
  const source = cloud.containsColors ? cloud.getColors() : [];
  if (source.length === cloud.count) {
    colors = new Uint8Array(source.length * 4);
    for (let i = 0; i < source.length; i++) {
      const c = source[i];
      colors[i * 4] = c.r; colors[i * 4 + 1] = c.g; colors[i * 4 + 2] = c.b; colors[i * 4 + 3] = c.a;
    }
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
      const accepted = acceptXform(xform);
      if (!accepted) { report.skip('InstanceReference:invalid'); return null; }
      return { kind: 'instance', definition: geometry.parentIdefId, xform: accepted };
    } finally { dispose(source); }
  }
  if (geometry instanceof api.Mesh) return meshPart([geometry], type, ctx);
  if (geometry instanceof api.Brep) {
    const faces = geometry.faces();
    try { return brepPart(faces, ctx); } finally { dispose(faces); }
  }
  if (geometry instanceof api.Extrusion) {
    const mesh = geometry.getMesh(api.MeshType.Any);
    if (!mesh) { report.skip('Extrusion:no-render-mesh'); return null; }
    try { return meshPart([mesh], type, ctx); } finally { dispose(mesh); }
  }
  if (geometry instanceof api.SubD) {
    if (ctx.subdLevel > 0) geometry.subdivide(ctx.subdLevel);
    const net = api.Mesh.createFromSubDControlNet(geometry, false);
    if (!net) { report.skip('SubD:invalid'); return null; }
    try {
      const part = meshPart([net], type, ctx);
      if (part) report.warn('subd', n => `${plural(n, 'SubD object')} shown as the control net at subdivision level ${ctx.subdLevel}, an approximation of the limit surface.`);
      return part;
    } finally { dispose(net); }
  }
  if (geometry instanceof api.PointCloud) return pointCloudPart(geometry, ctx);
  if (geometry instanceof api.TextDot) {
    const position = scaled(geometry.point, scale);
    if (!finite3(position)) { report.skip('TextDot:invalid'); return null; }
    return { kind: 'dot', position, text: geometry.text };
  }
  if (geometry instanceof api.Curve) return curvePart(geometry, type, ctx);
  report.skip(type);
  return null;
}
