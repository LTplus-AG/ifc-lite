/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { applyDxfPlacement, projectTo2D, projectTo2DBasis, type Point2D, type SectionPlaneConfig } from '@ifc-lite/drawing-2d';
import type { ViewerState } from '@/store';
import type { DxfUnderlayState } from '@/store/slices/drawing2DSlice';
import { referenceRenderCorners } from '@/lib/appearance/reference-runtime/frame';
import { placementFrameKey, placementFrameCoordinateInfo } from '@/lib/model-placement/persistence';
import { totalYupOffset, viewerToIfcAxes } from '@/lib/geo/coordinate-frame';

export type DxfPlanePoint = readonly [number, number, number];
/** Absolute IFC metre frame, frozen at import; absence means legacy site plan. */
export interface DxfReferenceFrame {
  version: 1;
  kind: 'plane-reference';
  originIfc: DxfPlanePoint;
  uIfc: DxfPlanePoint;
  vIfc: DxfPlanePoint;
  frameKey: string;
}
export function isDxfReferenceFrame(value: unknown): value is DxfReferenceFrame {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  const point = (p: unknown): p is DxfPlanePoint => Array.isArray(p) && p.length === 3 && p.every(n => typeof n === 'number' && Number.isFinite(n));
  if (v.version !== 1 || v.kind !== 'plane-reference' || typeof v.frameKey !== 'string' || !v.frameKey || !point(v.originIfc) || !point(v.uIfc) || !point(v.vIfc)) return false;
  const dot = v.uIfc.reduce((sum, n, i) => sum + n * (v.vIfc as DxfPlanePoint)[i], 0);
  return Math.abs(Math.hypot(...v.uIfc) - 1) < 1e-8 && Math.abs(Math.hypot(...v.vIfc) - 1) < 1e-8 && Math.abs(dot) < 1e-8;
}
export function captureDxfReferenceFrame(state: ViewerState, plane: SectionPlaneConfig): DxfReferenceFrame {
  if (plane.customPlane) throw new Error('Choose Down, Front or Side to register a DXF drawing reference.');
  const offset = totalYupOffset(placementFrameCoordinateInfo(state));
  const render = { x: 0, y: 0, z: 0, [plane.axis]: plane.position };
  const origin = viewerToIfcAxes({ x: render.x + offset.x, y: render.y + offset.y, z: render.z + offset.z });
  // CAD X follows the unflipped drawing U; CAD Y points up in engineering space.
  const u: DxfPlanePoint = plane.axis === 'x' ? [0, -1, 0] : [1, 0, 0];
  const v: DxfPlanePoint = plane.axis === 'y' ? [0, 1, 0] : [0, 0, 1];
  return { version: 1, kind: 'plane-reference', originIfc: [origin.x, origin.y, origin.z], uIfc: u, vIfc: v, frameKey: placementFrameKey(state) };
}
/** Reuses the reference runtime's engineering-frame and RTC checks. */
export function dxfReferenceRenderBasis(frame: DxfReferenceFrame, state: ViewerState) {
  const o = frame.originIfc;
  const add = (v: DxfPlanePoint): DxfPlanePoint => [o[0]+v[0],o[1]+v[1],o[2]+v[2]];
  return referenceRenderCorners({ frameKey: frame.frameKey, cornersIfcWorld: [o, add(frame.uIfc), add(frame.vIfc), o] }, state);
}
export function dxfReferenceStatus(entry: DxfUnderlayState, state: ViewerState, plane: SectionPlaneConfig): 'ready' | 'edge-on' | 'frame-mismatch' {
  if (!entry.referenceFrame) return !plane.customPlane && plane.axis === 'y' ? 'ready' : 'edge-on';
  const basis = dxfReferenceRenderBasis(entry.referenceFrame, state);
  if (!basis) return 'frame-mismatch';
  const a = projectDxfReferencePoint(basis[0], plane), b = projectDxfReferencePoint(basis[1], plane), c = projectDxfReferencePoint(basis[2], plane);
  return Math.abs((b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x)) > 1e-10 ? 'ready' : 'edge-on';
}
export function projectDxfReferencePoint(p: DxfPlanePoint, plane: SectionPlaneConfig): Point2D {
  const point = {x:p[0],y:p[1],z:p[2]}, custom = plane.customPlane;
  return custom ? projectTo2DBasis(point, custom.origin, custom.tangent, custom.bitangent) : projectTo2D(point, plane.axis, plane.flipped);
}
export function dxfReferencePointToRender(point: Point2D, entry: DxfUnderlayState, basis: NonNullable<ReturnType<typeof dxfReferenceRenderBasis>>): DxfPlanePoint {
  const p = applyDxfPlacement(point, entry.placement), [o,u,v] = basis;
  const coordinate = (i: number) => o[i]+(u[i]-o[i])*p.x+(v[i]-o[i])*p.y;
  return [coordinate(0), coordinate(1), coordinate(2)];
}

export function dxfPlaneDrawingMapper(entry: DxfUnderlayState, state: ViewerState, plane: SectionPlaneConfig) {
  if (!entry.referenceFrame || dxfReferenceStatus(entry, state, plane) !== 'ready') return null;
  const basis = dxfReferenceRenderBasis(entry.referenceFrame, state);
  return basis ? (point: Point2D) => projectDxfReferencePoint(dxfReferencePointToRender(point, entry, basis), plane) : null;
}

/** Convert a final drawing-space translation to the registered plane's U/V. */
export function dxfDrawingDeltaToPlacement(entry: DxfUnderlayState, state: ViewerState, plane: SectionPlaneConfig, delta: Point2D): Point2D | null {
  if (!entry.referenceFrame) return delta;
  const basis = dxfReferenceRenderBasis(entry.referenceFrame, state);
  if (!basis) return null;
  const [o,u,v] = basis.map(p => projectDxfReferencePoint(p, plane));
  const ux=u.x-o.x, uy=u.y-o.y, vx=v.x-o.x, vy=v.y-o.y;
  const determinant=ux*vy-uy*vx;
  if (Math.abs(determinant)<1e-10) return null;
  return {x:(delta.x*vy-delta.y*vx)/determinant,y:(ux*delta.y-uy*delta.x)/determinant};
}
