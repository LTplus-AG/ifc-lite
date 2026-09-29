/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The faces a selected element can be pushed or pulled by (charter #6232,
 * C4). A face is a dimension with a place to grab it:
 *
 *   - wall: the top (height), and the two sides (thickness);
 *   - slab, roof, plate: the far face of the extrusion (thickness);
 *   - column, beam, member: either end (length).
 *
 * Every face names the size patch that writes it (`patch`), and that patch is
 * the one the inspector's Dimensions rows write (`setElementSize`), so a face
 * dragged to 0.35 m and 0.35 typed in the field are the same edit. Geometry
 * is storey-local metres, like the readers it comes from; the storey's
 * workplane carries it to render space.
 */

import type { ViewerState } from '@/store';
import { readWallMetres } from '@/store/slices/mutation-wall-resize';
import { modelEditTarget } from '@/store/slices/mutation-modelling-records';
import type { ElementSizePatch } from '@/store/slices/mutation-element-size';
import { getModelLengthUnitScale } from '@/lib/length-unit-scale';
import { resolveLinearElementChain } from '@/lib/linear-element-edit';
import { resolveSlabEditChain } from '@/lib/slab-edit';
import { buildStoreyWorkplane, elementStoreyId, isWorkplane } from '@/lib/commands/modeling/workplane';
import { centredRectOutline, segmentOutline } from '@/lib/commands/modeling/ghost-shapes';
import type { TranslationKey } from '@/i18n';
import type { Vec2 } from '@/lib/snap/types';
import type { Vec3, Workplane } from '@/lib/commands/modeling/types';

export type PushPullFaceId = 'wall.top' | 'wall.sideLeft' | 'wall.sideRight' | 'slab.far' | 'linear.end' | 'linear.start';

export interface PushPullFace {
  readonly id: PushPullFaceId;
  readonly labelKey: TranslationKey;
  /** The face's centre and outward unit normal, storey-local metres. */
  readonly origin: Vec3;
  readonly normal: Vec3;
  /** The dimension this face sets, now (metres). */
  readonly size: number;
  /** Metres the dimension changes per metre the face travels: 2 for a wall side (the wall grows about its axis), 1 otherwise. */
  readonly gain: number;
  /** The size patch that writes `size` to the element: the inspector's write. */
  patch(size: number): ElementSizePatch;
}

/** The body the ghost draws: a vertical prism over an outline, in storey-local metres. */
export interface PushPullPrism {
  readonly outline: readonly Vec2[];
  readonly z0: number;
  readonly z1: number;
}

type Shape =
  | { kind: 'wall'; start: Vec3; end: Vec3; thickness: number; height: number }
  | { kind: 'slab'; footprint: readonly Vec2[]; base: number; thickness: number; up: boolean }
  | { kind: 'linear'; start: Vec3; axis: Vec3; depth: number; width: number; cross: number; yawDeg: number };

export interface PushPullTarget {
  readonly modelId: string;
  readonly expressId: number;
  readonly storeyId: number;
  readonly plane: Workplane;
  readonly faces: readonly PushPullFace[];
  /** The element with `face` at `size`, as a prism the ghost can draw. Null when no honest prism exists (a sloped beam). */
  prism(face: PushPullFace, size: number): PushPullPrism | null;
}

const unit2 = (a: Vec3, b: Vec3): Vec2 | null => {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  return len > 1e-9 ? [dx / len, dy / len] : null;
};

function wallFaces(shape: Extract<Shape, { kind: 'wall' }>): PushPullFace[] | null {
  const dir = unit2(shape.start, shape.end);
  if (!dir || !(shape.height > 0) || !(shape.thickness > 0)) return null;
  const mid: Vec3 = [(shape.start[0] + shape.end[0]) / 2, (shape.start[1] + shape.end[1]) / 2, shape.start[2]];
  const left: Vec3 = [-dir[1], dir[0], 0];
  const side = (sign: 1 | -1, id: PushPullFaceId, labelKey: TranslationKey): PushPullFace => ({
    id, labelKey, gain: 2, size: shape.thickness,
    origin: [mid[0] + sign * left[0] * shape.thickness / 2, mid[1] + sign * left[1] * shape.thickness / 2, mid[2] + shape.height / 2],
    normal: [sign * left[0], sign * left[1], 0],
    patch: (thickness) => ({ kind: 'wall', thickness }),
  });
  return [
    {
      id: 'wall.top', labelKey: 'pushPull.face.wallHeight', gain: 1, size: shape.height,
      origin: [mid[0], mid[1], mid[2] + shape.height], normal: [0, 0, 1],
      patch: (height) => ({ kind: 'wall', height }),
    },
    side(1, 'wall.sideLeft', 'pushPull.face.wallThickness'),
    side(-1, 'wall.sideRight', 'pushPull.face.wallThickness'),
  ];
}

function slabFaces(shape: Extract<Shape, { kind: 'slab' }>): PushPullFace[] | null {
  if (shape.footprint.length < 3 || !(shape.thickness > 0)) return null;
  const us = shape.footprint.map((p) => p[0]), vs = shape.footprint.map((p) => p[1]);
  const cx = (Math.min(...us) + Math.max(...us)) / 2, cy = (Math.min(...vs) + Math.max(...vs)) / 2;
  const far = shape.up ? shape.base + shape.thickness : shape.base;
  return [{
    id: 'slab.far', labelKey: 'pushPull.face.slabThickness', gain: 1, size: shape.thickness,
    origin: [cx, cy, far], normal: [0, 0, shape.up ? 1 : -1],
    patch: (thickness) => ({ kind: 'slab', thickness }),
  }];
}

function linearFaces(shape: Extract<Shape, { kind: 'linear' }>): PushPullFace[] | null {
  if (!(shape.depth > 0)) return null;
  const [sx, sy, sz] = shape.start, [ax, ay, az] = shape.axis;
  return [
    {
      id: 'linear.end', labelKey: 'pushPull.face.length', gain: 1, size: shape.depth,
      origin: [sx + ax * shape.depth, sy + ay * shape.depth, sz + az * shape.depth], normal: [ax, ay, az],
      patch: (length) => ({ kind: 'linear', length, fixed: 'start' }),
    },
    {
      id: 'linear.start', labelKey: 'pushPull.face.length', gain: 1, size: shape.depth,
      origin: [sx, sy, sz], normal: [-ax, -ay, -az],
      patch: (length) => ({ kind: 'linear', length, fixed: 'end' }),
    },
  ];
}

/** The prism of `shape` with the dimension `face` sets at `size`, the face's far side held still. */
function prismOf(shape: Shape, face: PushPullFace, size: number): PushPullPrism | null {
  if (shape.kind === 'wall') {
    const wall = { ...shape, ...(face.id === 'wall.top' ? { height: size } : { thickness: size }) };
    const outline = segmentOutline([wall.start[0], wall.start[1]], [wall.end[0], wall.end[1]], wall.thickness);
    return outline ? { outline, z0: wall.start[2], z1: wall.start[2] + wall.height } : null;
  }
  if (shape.kind === 'slab') {
    const top = shape.up ? shape.base + size : shape.base + shape.thickness;
    return { outline: shape.footprint, z0: shape.up ? shape.base : top - size, z1: top };
  }
  const { start, axis } = shape;
  // The length grows from the end that stays; a start face moves the start.
  const from = face.id === 'linear.start' ? shape.depth - size : 0;
  const s: Vec3 = [start[0] + axis[0] * from, start[1] + axis[1] * from, start[2] + axis[2] * from];
  if (Math.abs(axis[2]) > 0.999) {
    const z = s[2] + (axis[2] > 0 ? 0 : -size);
    return { outline: centredRectOutline([s[0], s[1]], shape.width, shape.cross, shape.yawDeg), z0: z, z1: z + size };
  }
  if (Math.abs(axis[2]) < 1e-3) {
    const end: Vec2 = [s[0] + axis[0] * size, s[1] + axis[1] * size];
    const outline = segmentOutline([s[0], s[1]], end, shape.width);
    return outline ? { outline, z0: s[2] - shape.cross / 2, z1: s[2] + shape.cross / 2 } : null;
  }
  return null;
}

function readShape(s: ViewerState, modelId: string, expressId: number): { shape: Shape; faces: PushPullFace[] } | null {
  const target = modelEditTarget(s, modelId);
  if (!target) return null;
  const scale = getModelLengthUnitScale(target.dataStore);
  const wall = readWallMetres(target, expressId);
  if (wall) {
    const shape: Shape = { kind: 'wall', start: wall.start, end: wall.end, thickness: wall.thickness, height: wall.height };
    const faces = wallFaces(shape);
    return faces && { shape, faces };
  }
  const slab = resolveSlabEditChain(target.dataStore, target.view, target.editor, expressId, scale);
  if (slab && slab.baseElevation !== null) {
    const shape: Shape = { kind: 'slab', footprint: slab.footprint, base: slab.baseElevation, thickness: slab.thickness, up: slab.extrusionUp };
    const faces = slabFaces(shape);
    return faces && { shape, faces };
  }
  const linear = resolveLinearElementChain(target.dataStore, target.view, target.editor, expressId, scale);
  if (linear) {
    const yaw = s.readEntityRotation(modelId, expressId)?.yawZ ?? 0;
    const shape: Shape = {
      kind: 'linear', start: linear.startCoordinates, axis: linear.axisDirection, depth: linear.depth,
      width: linear.profileWidth, cross: linear.profileHeight, yawDeg: (yaw * 180) / Math.PI,
    };
    const faces = linearFaces(shape);
    return faces && { shape, faces };
  }
  return null;
}

/**
 * `expressId` as something push / pull can act on, or null: it needs one of
 * the plain extruded layouts the builders write (see `setElementSize`), a
 * storey to sit on, and a workplane for that storey.
 */
export function readPushPullTarget(s: ViewerState, modelId: string, expressId: number): PushPullTarget | null {
  const storeyId = elementStoreyId(s, modelId, expressId);
  if (storeyId === null) return null;
  const plane = buildStoreyWorkplane(s, modelId, storeyId, 0);
  if (!isWorkplane(plane)) return null;
  const read = readShape(s, modelId, expressId);
  if (!read) return null;
  const { shape, faces } = read;
  return { modelId, expressId, storeyId, plane, faces, prism: (face, size) => prismOf(shape, face, size) };
}
