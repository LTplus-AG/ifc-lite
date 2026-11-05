/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { tryPackRteDrawableDelta } from './relative-to-eye.js';
import type { Camera } from './camera.js';
import type { PickClipState, PickOptions, PickResult, Vec3 } from './types.js';
import type { LineVertices } from './section-2d-line-buffer.js';
import type { SymbolicFillInput } from './symbolic-fill-pipeline.js';
import { triangulateFillTo } from './symbolic-overlay-geometry.js';
import { clipSegmentInterval, clipStatePlanes } from './clip-half-spaces.js';
import { pointClipped, rayTriangleIntersect } from './scene-raycaster.js';
import { isEntityVisible } from './entity-visibility.js';
import { viewBasis } from './math.js';
import { PERSPECTIVE_OVERLAY_DEPTH_LIFT, ORTHOGRAPHIC_DEPTH_NUDGE_PER_LEVEL,
  ORTHOGRAPHIC_MAX_DEPTH_NUDGE_METRES, MAX_DEPTH_NUDGE_HASH } from './shaders/depth-nudge.wgsl.js';

type Point = readonly [number, number, number];
const point = (p: Point): Vec3 => ({ x: p[0], y: p[1], z: p[2] });
const tuple = (p: Vec3): Point => [p.x, p.y, p.z];
const mix = (a: Point, b: Point, t: number): Point => a.map((v, i) => v + (b[i] - v) * t) as [number, number, number];

/** Retained from the actual atlas layout, never estimated from string length. */
export interface AnnotationPickGlyph {
  ownerId: number;
  anchor: Point;
  right: Point;
  offsetSize: readonly [number, number, number, number];
  capHeight: number;
  targetPx: number;
  billboard: boolean;
  sectionClipped: boolean;
  anchored: boolean;
}

interface Candidate { depth: number; result: PickResult }
export interface AnnotationPickSnapshot {
  hits: Candidate[];
  depth(point: Vec3): number;
  isCurrent(): boolean;
}
export type AnnotationPickProvider = (
  x: number, y: number, width: number, height: number, options?: PickOptions, clip?: PickClipState | null,
) => AnnotationPickSnapshot | null;

/** Overlay pipelines don't write depth: the last drawable hit wins, subject to mesh occlusion. */
export function resolveAnnotationPick(snapshot: AnnotationPickSnapshot | null, mesh: PickResult | null, meshPoint = mesh?.worldXYZ): PickResult | null {
  if (!snapshot) return mesh;
  if (!snapshot.isCurrent()) return mesh;
  const depth = meshPoint ? snapshot.depth(meshPoint) : mesh ? Infinity : 0;
  for (let i = snapshot.hits.length - 1; i >= 0; i--) {
    if (snapshot.hits[i].depth >= depth) return snapshot.hits[i].result;
  }
  return mesh;
}

/** Upload-owned geometry for the shared CPU/GPU annotation pick route (#8783). */
export class AnnotationPicker {
  private lines: Array<{ a: Point; b: Point; ownerId: number; clipped: boolean; origin: Point }> = [];
  private fills: Array<{ vertices: number[]; origin: Point; ownerId: number; clipped: boolean; anchored: boolean }> = [];
  private glyphs: readonly AnnotationPickGlyph[] = [];
  private revision = 0;

  clear(): void { this.lines = []; this.fills = []; this.glyphs = []; this.revision++; }

  setLines(vertices: LineVertices | null, clipped: boolean): void {
    this.lines = [];
    this.revision++;
    if (!vertices || vertices instanceof Float32Array) return;
    for (const partition of 'localVertices' in vertices ? [vertices] : vertices) {
      const { localVertices: v, ownerIds, origin } = partition;
      if (!ownerIds) continue;
      for (let i = 0; i + 5 < v.length; i += 6) {
        const ownerId = ownerIds[i / 6];
        if (!ownerId) continue;
        this.lines.push({ ownerId, clipped, origin,
          a: [origin[0] + v[i], origin[1] + v[i + 1], origin[2] + v[i + 2]],
          b: [origin[0] + v[i + 3], origin[1] + v[i + 4], origin[2] + v[i + 5]] });
      }
    }
  }

  setFills(fills: readonly SymbolicFillInput[]): void {
    this.fills = [];
    this.revision++;
    for (const fill of fills) {
      if (!fill.ownerId || !(fill.color[3] > 0)) continue;
      const vertices: number[] = [];
      triangulateFillTo(vertices, fill);
      this.fills.push({ vertices, origin: fill.origin ?? [0, 0, 0], anchored: !!fill.origin, ownerId: fill.ownerId, clipped: fill.sectionClipped === true });
    }
  }

  setGlyphs(glyphs: readonly AnnotationPickGlyph[]): void { this.glyphs = glyphs; this.revision++; }

  pick(camera: Camera, x: number, y: number, width: number, height: number, options?: PickOptions, clip?: PickClipState | null): AnnotationPickSnapshot | null {
    // No camera work, allocation or scene walk for annotation-free models.
    if (!(this.lines.length || this.fills.length || this.glyphs.length)) return null;
    if (!(width > 0 && height > 0) || x < 0 || y < 0 || x >= width || y >= height) return null;
    const revision = this.revision;
    const frame = camera.getRelativeToEyeFrame();
    if (!frame.isAvailable()) return null;
    const eye = frame.getCameraWorld(), m = frame.getViewProjection().m;
    const project = (p: Point): [number, number, number, number] => {
      const a = p[0] - eye[0], b = p[1] - eye[1], c = p[2] - eye[2];
      return [m[0]*a+m[4]*b+m[8]*c+m[12], m[1]*a+m[5]*b+m[9]*c+m[13],
        m[2]*a+m[6]*b+m[10]*c+m[14], m[3]*a+m[7]*b+m[11]*c+m[15]];
    };
    const depth = (p: Vec3): number => { const q = project(tuple(p)); return q[2] / q[3]; };
    const scratch = new Float32Array(8);
    const drawable = (origin: Point) => tryPackRteDrawableDelta(origin, eye, scratch, 0);
    const ray = camera.unprojectToRay(x, y, width, height);
    const hits: Candidate[] = [];
    const planes = clipStatePlanes(clip).map(p => ({ n: p.normal, limit: p.distance }));
    const visible = (id: number) => isEntityVisible(id, options?.hiddenIds, options?.isolatedIds);
    // Match the shader's projection-dependent decal lift.
    const range = 1 / Math.hypot(m[2], m[6], m[10]);
    const levels = Math.min(MAX_DEPTH_NUDGE_HASH, Math.max(0, Math.floor(ORTHOGRAPHIC_MAX_DEPTH_NUDGE_METRES / (range * ORTHOGRAPHIC_DEPTH_NUDGE_PER_LEVEL)))) + 1;
    const lift = camera.getProjectionMode() === 'orthographic'
      ? Math.max(PERSPECTIVE_OVERLAY_DEPTH_LIFT, (levels + 1) * ORTHOGRAPHIC_DEPTH_NUDGE_PER_LEVEL)
      : PERSPECTIVE_OVERLAY_DEPTH_LIFT;
    const add = (id: number, p: Vec3, lifted: boolean) => {
      const q = project(tuple(p)), z = q[2] / q[3];
      if (q[3] > 0 && z > 0 && z <= 1) hits.push({ depth: Math.min(1, z + (lifted ? lift : 0)), result: { expressId: id, worldXYZ: p } });
    };
    const triangle = (a: Point, b: Point, c: Point): Vec3 | null => {
      // Subtract the local origin BEFORE triangle intersection for national-grid coordinates.
      const local = (v: Point): Vec3 => ({ x: v[0]-a[0], y: v[1]-a[1], z: v[2]-a[2] });
      const t = rayTriangleIntersect(local(tuple(ray.origin)), ray.direction, { x: 0, y: 0, z: 0 }, local(b), local(c));
      return t === null ? null : { x: ray.origin.x + t*ray.direction.x, y: ray.origin.y + t*ray.direction.y, z: ray.origin.z + t*ray.direction.z };
    };
    for (const fill of this.fills) {
      if (!visible(fill.ownerId) || (fill.anchored && !drawable(fill.origin))) continue;
      const v = fill.vertices, o = fill.origin;
      const vertex = (i: number): Point => [v[i]+o[0], v[i+1]+o[1], v[i+2]+o[2]];
      for (let i = 0; i + 20 < v.length; i += 21) {
        const hit = triangle(vertex(i), vertex(i+7), vertex(i+14));
        if (hit && !(fill.clipped && pointClipped(clip, hit.x, hit.y, hit.z))) { add(fill.ownerId, hit, false); break; }
      }
    }
    for (const line of this.lines) {
      if (!visible(line.ownerId) || !drawable(line.origin)) continue;
      const interval = line.clipped ? clipSegmentInterval(point(line.a), point(line.b), planes) : [0, 1];
      if (!interval) continue;
      let a = mix(line.a, line.b, interval[0]), b = mix(line.a, line.b, interval[1]);
      let qa = project(a), qb = project(b);
      // Clip in homogeneous space before perspective division, including the near plane.
      let lo = 0, hi = 1;
      for (const f of [(q: number[]) => q[2], (q: number[]) => q[3]-q[2],
        (q: number[]) => q[3]+q[0], (q: number[]) => q[3]-q[0],
        (q: number[]) => q[3]+q[1], (q: number[]) => q[3]-q[1]]) {
        const va = f(qa), vb = f(qb);
        if (va < 0 && vb < 0) { lo = 1; hi = 0; break; }
        if (va < 0) lo = Math.max(lo, va/(va-vb));
        if (vb < 0) hi = Math.min(hi, va/(va-vb));
      }
      if (lo > hi) continue;
      const end = mix(a,b,hi); a = mix(a,b,lo); b = end;
      qa = project(a); qb = project(b);
      if (!(qa[3] > 0 && qb[3] > 0)) continue;
      const ax = (qa[0]/qa[3]+1)*width/2, ay = (1-qa[1]/qa[3])*height/2;
      const dx = (qb[0]/qb[3]+1)*width/2-ax, dy = (1-qb[1]/qb[3])*height/2-ay;
      const t = Math.max(0, Math.min(1, ((x-ax)*dx+(y-ay)*dy)/(dx*dx+dy*dy || 1)));
      if (Math.hypot(x-ax-t*dx, y-ay-t*dy) > 4) continue;
      const worldT = (t/qb[3])/((1-t)/qa[3]+t/qb[3]);
      add(line.ownerId, point(mix(a,b,worldT)), true);
    }
    const basis = this.glyphs.length ? viewBasis(camera.getPosition(), camera.getTarget(), camera.getUp()) : null;
    for (const glyph of this.glyphs) {
      if (!visible(glyph.ownerId) || (glyph.anchored && !drawable(glyph.anchor)) || (glyph.sectionClipped && pointClipped(clip, ...glyph.anchor))) continue;
      const right = glyph.billboard ? tuple(basis!.right) : glyph.right;
      const up: Point = glyph.billboard ? tuple(basis!.up) : [0,1,0];
      const a = project(glyph.anchor), b = project(glyph.anchor.map((v,i) => v+up[i]) as [number,number,number]);
      const unitPx = Math.hypot(b[0]/Math.max(Math.abs(b[3]),1e-4)-a[0]/Math.max(Math.abs(a[3]),1e-4),
        b[1]/Math.max(Math.abs(b[3]),1e-4)-a[1]/Math.max(Math.abs(a[3]),1e-4))*height/2;
      const scale = Math.max(.02, Math.min(1, glyph.targetPx/Math.max(Math.max(glyph.capHeight,1e-4)*unitPx,.01)));
      const [ox,oy,w,h] = glyph.offsetSize;
      const corner = (u: number,v: number): Point => glyph.anchor.map((n,i) => n+scale*(right[i]*(ox+w*u)+up[i]*(oy+h*v))) as [number,number,number];
      const p = triangle(corner(0,0),corner(1,0),corner(0,1)) ?? triangle(corner(1,0),corner(1,1),corner(0,1));
      if (p) add(glyph.ownerId,p,true);
    }
    return { hits, depth, isCurrent: () => revision === this.revision };
  }
}
