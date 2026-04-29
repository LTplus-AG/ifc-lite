/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Build simple "instant preview" meshes for newly-added elements so
 * the user sees them in 3D the moment the builder commits — without
 * waiting for an export+re-parse round-trip.
 *
 * Coordinate-system note (matches the rest of the viewer):
 *   - Builder params are in **IFC storey-local** metres (Z-up).
 *   - The renderer is **Y-up** with `viewer.y = ifc.z + storeyElevation`,
 *     `viewer.x = ifc.x`, `viewer.z = -ifc.y`.
 *   - We emit positions directly in renderer-frame so the mesh slots
 *     into the standard mesh-list pipeline.
 *
 * What we don't try to do here: cut openings, host walls, model door
 * leaves correctly, tessellate non-convex polygons. The preview is a
 * faithful extrusion of the user's parametric input, not a final
 * presentation render — when the user exports, the IFC pipeline emits
 * the proper sub-graph and a re-parse yields the canonical geometry.
 */

import type { MeshData } from '@ifc-lite/geometry';
import type {
  AddElementType,
  AddElementWallParams,
  AddElementSlabParams,
  AddElementBeamParams,
  AddElementColumnParams,
  AddElementDoorParams,
  AddElementWindowParams,
  AddElementSpaceParams,
  AddElementRoofParams,
  AddElementPlateParams,
  AddElementMemberParams,
} from './addElementSlice';

type Vec3 = [number, number, number];

/** Per-type colour palette for the preview mesh. RGBA, 0..1. */
const COLORS: Record<AddElementType, [number, number, number, number]> = {
  wall:   [0.85, 0.85, 0.82, 1.0],
  slab:   [0.78, 0.78, 0.78, 1.0],
  beam:   [0.65, 0.50, 0.35, 1.0],
  column: [0.65, 0.50, 0.35, 1.0],
  door:   [0.55, 0.35, 0.20, 1.0],
  window: [0.45, 0.65, 0.85, 0.45],
  space:  [0.30, 0.85, 0.55, 0.18],
  roof:   [0.55, 0.35, 0.30, 1.0],
  plate:  [0.70, 0.70, 0.72, 1.0],
  member: [0.55, 0.55, 0.50, 1.0],
};

const IFC_TYPE: Record<AddElementType, string> = {
  wall:   'IfcWall',
  slab:   'IfcSlab',
  beam:   'IfcBeam',
  column: 'IfcColumn',
  door:   'IfcDoor',
  window: 'IfcWindow',
  space:  'IfcSpace',
  roof:   'IfcRoof',
  plate:  'IfcPlate',
  member: 'IfcMember',
};

export interface ElementBuildContext {
  type: AddElementType;
  /** New entity's globalId (federation-aware). Tags every vertex. */
  globalId: number;
  /** Storey elevation in IFC Z (metres) — added to vertex Y in renderer. */
  storeyElevation: number;
  /** Per-element-type discriminated params + click points. */
  payload: ElementMeshPayload;
}

export type ElementMeshPayload =
  | { type: 'wall'; params: AddElementWallParams; start: Vec3; end: Vec3 }
  | { type: 'beam'; params: AddElementBeamParams; start: Vec3; end: Vec3 }
  | { type: 'member'; params: AddElementMemberParams; start: Vec3; end: Vec3 }
  | { type: 'column'; params: AddElementColumnParams; position: Vec3 }
  | { type: 'door'; params: AddElementDoorParams; position: Vec3 }
  | { type: 'window'; params: AddElementWindowParams; position: Vec3 }
  | { type: 'slab'; params: AddElementSlabParams; corners: Vec3[] }
  | { type: 'space'; params: AddElementSpaceParams; corners: Vec3[] }
  | { type: 'roof'; params: AddElementRoofParams; corners: Vec3[] }
  | { type: 'plate'; params: AddElementPlateParams; corners: Vec3[] };

/**
 * Build a renderer-frame `MeshData` for a freshly-added element.
 * Returns `null` when the payload is degenerate (zero-length wall etc.).
 */
export function buildElementMesh(ctx: ElementBuildContext): MeshData | null {
  const { type, globalId, storeyElevation, payload } = ctx;
  switch (payload.type) {
    case 'wall':
    case 'beam':
    case 'member': {
      // Linear extrusion: a (length × thickness × height) box centred
      // along the click→click axis, sitting on the storey floor.
      const thickness = 'Thickness' in payload.params
        ? payload.params.Thickness
        : payload.params.Width;
      const height = 'Height' in payload.params ? payload.params.Height : 0.1;
      return buildLinearBox(globalId, type, payload.start, payload.end, thickness, height, storeyElevation);
    }
    case 'column': {
      const { Width, Depth, Height } = payload.params;
      return buildAxisBox(globalId, type, payload.position, Width, Depth, Height, storeyElevation);
    }
    case 'door': {
      const { Width, Height, FrameThickness } = payload.params;
      return buildAxisBox(globalId, type, payload.position, Width, FrameThickness, Height, storeyElevation);
    }
    case 'window': {
      const { Width, Height, FrameThickness } = payload.params;
      return buildAxisBox(globalId, type, payload.position, Width, FrameThickness, Height, storeyElevation);
    }
    case 'slab':
    case 'roof':
    case 'plate': {
      const thickness = payload.params.Thickness;
      return buildPolygonExtrusion(globalId, type, payload.corners, thickness, storeyElevation, /* extrudeUp */ true);
    }
    case 'space': {
      const height = payload.params.Height;
      return buildPolygonExtrusion(globalId, type, payload.corners, height, storeyElevation, /* extrudeUp */ true);
    }
  }
}

/**
 * Linear segment extruded into a thickness × height box (wall / beam /
 * member shape). The bottom ring follows the segment's actual start/end
 * Z so a sloped beam previews as a sloped prism instead of pinning to
 * `startIfc[2]`. Walls reject sloped axes upstream
 * (`addWallToStore` enforces planar XY); beams / members do not, which
 * is why this routine has to honour both endpoints' Z.
 */
function buildLinearBox(
  globalId: number,
  type: AddElementType,
  startIfc: Vec3,
  endIfc: Vec3,
  thickness: number,
  height: number,
  storeyElevation: number,
): MeshData | null {
  const dx = endIfc[0] - startIfc[0];
  const dy = endIfc[1] - startIfc[1];
  // Cross-section plane is perpendicular to the ground-plane axis;
  // even on sloped segments we keep the cross-section vertical so
  // walls/beams/members read like building elements (extrusion is
  // along +Z, not perpendicular to the segment direction).
  const lenXY = Math.hypot(dx, dy);
  if (lenXY < 1e-6) return null;
  const ax = dx / lenXY;
  const ay = dy / lenXY;
  const nx = -ay;
  const ny = ax;
  const half = thickness / 2;
  const startBaseZ = startIfc[2];
  const endBaseZ = endIfc[2];
  const startTopZ = startBaseZ + height;
  const endTopZ = endBaseZ + height;
  const ifcCorners: Vec3[] = [
    [startIfc[0] + nx * half, startIfc[1] + ny * half, startBaseZ],
    [endIfc[0]   + nx * half, endIfc[1]   + ny * half, endBaseZ],
    [endIfc[0]   - nx * half, endIfc[1]   - ny * half, endBaseZ],
    [startIfc[0] - nx * half, startIfc[1] - ny * half, startBaseZ],
    [startIfc[0] + nx * half, startIfc[1] + ny * half, startTopZ],
    [endIfc[0]   + nx * half, endIfc[1]   + ny * half, endTopZ],
    [endIfc[0]   - nx * half, endIfc[1]   - ny * half, endTopZ],
    [startIfc[0] - nx * half, startIfc[1] - ny * half, startTopZ],
  ];
  return buildBoxFromIfcCorners(globalId, type, ifcCorners, storeyElevation);
}

/** Axis-aligned box centred on a single point (column / door / window shape). */
function buildAxisBox(
  globalId: number,
  type: AddElementType,
  centerIfc: Vec3,
  sizeX: number,
  sizeY: number,
  sizeZ: number,
  storeyElevation: number,
): MeshData {
  const hx = sizeX / 2;
  const hy = sizeY / 2;
  const baseZ = centerIfc[2];
  const topZ = baseZ + sizeZ;
  const cx = centerIfc[0];
  const cy = centerIfc[1];
  const ifcCorners: Vec3[] = [
    [cx - hx, cy - hy, baseZ],
    [cx + hx, cy - hy, baseZ],
    [cx + hx, cy + hy, baseZ],
    [cx - hx, cy + hy, baseZ],
    [cx - hx, cy - hy, topZ],
    [cx + hx, cy - hy, topZ],
    [cx + hx, cy + hy, topZ],
    [cx - hx, cy + hy, topZ],
  ];
  return buildBoxFromIfcCorners(globalId, type, ifcCorners, storeyElevation);
}

/** Polygon footprint extruded vertically (slab / space / roof / plate). */
function buildPolygonExtrusion(
  globalId: number,
  type: AddElementType,
  ifcFootprint: Vec3[],
  thickness: number,
  storeyElevation: number,
  extrudeUp: boolean,
): MeshData | null {
  const n = ifcFootprint.length;
  if (n < 3 || thickness <= 0) return null;
  const baseZ = ifcFootprint[0][2];
  const topZ = baseZ + (extrudeUp ? thickness : -thickness);

  // Vertex layout: bottom ring [0..n-1], top ring [n..2n-1]. Side
  // quads built from consecutive ring pairs. Cap fans triangulate
  // both rings around vertex 0 — fine for convex profiles, tolerable
  // for slightly concave (the export still emits the proper polygon).
  const vertCount = 2 * n;
  const positions = new Float32Array(vertCount * 3);
  const normals = new Float32Array(vertCount * 3);
  for (let i = 0; i < n; i++) {
    const [ix, iy] = ifcFootprint[i];
    // Bottom ring (renderer-frame)
    positions[i * 3 + 0] = ix;
    positions[i * 3 + 1] = baseZ + storeyElevation;
    positions[i * 3 + 2] = -iy;
    normals[i * 3 + 0] = 0;
    normals[i * 3 + 1] = -1;
    normals[i * 3 + 2] = 0;
    // Top ring
    const j = (n + i) * 3;
    positions[j + 0] = ix;
    positions[j + 1] = topZ + storeyElevation;
    positions[j + 2] = -iy;
    normals[j + 0] = 0;
    normals[j + 1] = 1;
    normals[j + 2] = 0;
  }

  // Triangle counts: 2(n-2) for caps + 2n for sides = 4n - 4 triangles.
  const triCount = 4 * n - 4;
  const indices = new Uint32Array(triCount * 3);
  let k = 0;

  // Bottom cap — fan around vertex 0 (CW so it faces -Y / down).
  for (let i = 1; i < n - 1; i++) {
    indices[k++] = 0;
    indices[k++] = i + 1;
    indices[k++] = i;
  }
  // Top cap — fan around vertex n (CCW so it faces +Y / up).
  for (let i = 1; i < n - 1; i++) {
    indices[k++] = n;
    indices[k++] = n + i;
    indices[k++] = n + i + 1;
  }
  // Side quads — two triangles per edge.
  for (let i = 0; i < n; i++) {
    const i0 = i;
    const i1 = (i + 1) % n;
    const t0 = n + i0;
    const t1 = n + i1;
    indices[k++] = i0;
    indices[k++] = i1;
    indices[k++] = t1;
    indices[k++] = i0;
    indices[k++] = t1;
    indices[k++] = t0;
  }

  const entityIds = new Uint32Array(vertCount);
  entityIds.fill(globalId);

  return {
    expressId: globalId,
    ifcType: IFC_TYPE[type],
    positions,
    normals,
    indices,
    color: COLORS[type],
    entityIds,
  };
}

/**
 * Box mesh from 8 IFC-frame corners (bottom ring 0..3, top ring 4..7).
 * Emits 12 triangles with face-aligned normals.
 */
function buildBoxFromIfcCorners(
  globalId: number,
  type: AddElementType,
  ifcCorners: Vec3[],
  storeyElevation: number,
): MeshData {
  // Each face has 4 unique vertices (normal welded per face) → 24 verts.
  // Faces: bottom, top, +U, +V, -U, -V (where U/V are the two sides).
  const faces: Array<{ corners: number[]; normal: Vec3 }> = [
    { corners: [0, 1, 2, 3], normal: [0, 0, -1] }, // bottom (IFC -Z)
    { corners: [4, 7, 6, 5], normal: [0, 0, 1] },  // top (IFC +Z)
    { corners: [0, 4, 5, 1], normal: faceNormal(ifcCorners, 0, 4, 1) },
    { corners: [1, 5, 6, 2], normal: faceNormal(ifcCorners, 1, 5, 2) },
    { corners: [2, 6, 7, 3], normal: faceNormal(ifcCorners, 2, 6, 3) },
    { corners: [3, 7, 4, 0], normal: faceNormal(ifcCorners, 3, 7, 0) },
  ];
  const positions = new Float32Array(24 * 3);
  const normals = new Float32Array(24 * 3);
  const indices = new Uint32Array(36);
  let v = 0;
  let i = 0;
  for (const face of faces) {
    const baseV = v;
    for (const ci of face.corners) {
      const [ix, iy, iz] = ifcCorners[ci];
      positions[v * 3 + 0] = ix;
      positions[v * 3 + 1] = iz + storeyElevation;
      positions[v * 3 + 2] = -iy;
      // IFC-frame normal → renderer-frame.
      normals[v * 3 + 0] = face.normal[0];
      normals[v * 3 + 1] = face.normal[2];
      normals[v * 3 + 2] = -face.normal[1];
      v++;
    }
    // Two triangles per face — split as (0,1,2) + (0,2,3).
    indices[i++] = baseV;
    indices[i++] = baseV + 1;
    indices[i++] = baseV + 2;
    indices[i++] = baseV;
    indices[i++] = baseV + 2;
    indices[i++] = baseV + 3;
  }
  const entityIds = new Uint32Array(24);
  entityIds.fill(globalId);
  return {
    expressId: globalId,
    ifcType: IFC_TYPE[type],
    positions,
    normals,
    indices,
    color: COLORS[type],
    entityIds,
  };
}

function faceNormal(corners: Vec3[], a: number, b: number, c: number): Vec3 {
  const ux = corners[b][0] - corners[a][0];
  const uy = corners[b][1] - corners[a][1];
  const uz = corners[b][2] - corners[a][2];
  const vx = corners[c][0] - corners[a][0];
  const vy = corners[c][1] - corners[a][1];
  const vz = corners[c][2] - corners[a][2];
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz) || 1;
  return [nx / len, ny / len, nz / len];
}
