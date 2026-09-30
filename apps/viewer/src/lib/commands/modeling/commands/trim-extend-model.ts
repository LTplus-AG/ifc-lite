/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What `element.trimExtend` works on (charter #6232, C1): the walls, beams and
 * members of the session storey read once into plan axes (`prepareModel`),
 * the slab edges a boundary may be, and the picking that names the one under
 * the cursor. A pointer move only runs `pickTarget` / `pickBoundary` over this;
 * nothing here writes.
 *
 * A wall is read the way the join core reads it (`readWallJoinTarget`: axis,
 * thickness, cuts, joins), so a wall already joined or cut at its ends is a
 * target like any other. A target the reader cannot take (a mesh body, a
 * profile that is not a rectangle, an imported extrusion the beam reader does
 * not know) is still pickable, by its mesh bounds, so it can be refused with
 * the reason the Split button gives for the same element.
 *
 * Boundaries: a wall or beam (its axis), a slab edge, or the guide line the
 * snap solver holds (a grid axis, an edge of some other element). Each is a
 * `ReachBoundary` in the storey's local frame.
 */

import { readWallJoinTarget, type WallJoinRead, type WallJoinWall } from '@ifc-lite/create';
import type { TranslationKey } from '@/i18n';
import { resolve as translate } from '@/i18n/registry';
import { toGlobalIdFromModels } from '@/store/globalId';
import { meshesForOwningModel } from '@/store/owningModelMeshes';
import { modelEditTarget } from '@/store/slices/mutation-modelling-records';
import type { ViewerState } from '@/store';
import { createEntityBoundsLookup } from '@/utils/viewportUtils';
import { getModelLengthUnitScale } from '@/lib/length-unit-scale';
import { resolveLinearElementChain, MIN_LINEAR_SEGMENT_LENGTH, type LinearElementEditChain } from '@/lib/linear-element-edit';
import { pointInPolygon, type Point2D } from '@/lib/polygon-clip';
import { MIN_WALL_SEGMENT_LENGTH } from '@/lib/wall-edit';
import type { Guide, SnapResult, Vec2 } from '@/lib/snap/types';
import { labelOf, stepTypeOf, storeyCandidates, type TargetRef } from './multi-split-plan.js';
import { segmentOutline } from '../ghost-shapes.js';
import type { Vec3, Workplane } from '../types.js';
import type { ReachBoundary, ReachTarget } from './trim-extend-geometry.js';

const WALL_TYPES = new Set(['IFCWALL', 'IFCWALLSTANDARDCASE']);
const BEAM_TYPES = new Set(['IFCBEAM', 'IFCMEMBER']);
/** What can be trimmed or extended, and what can be a boundary, on a storey. */
const CANDIDATE_TYPES = new Set([...WALL_TYPES, ...BEAM_TYPES]);
const SLAB_TYPES = new Set(['IFCSLAB']);

/** A wall, beam or member of the session storey. */
export interface TrimTarget extends TargetRef {
  readonly label: string;
  readonly kind: 'wall' | 'beam';
  /** Its axis, when it could be read; null for a refused one. */
  readonly axis: ReachTarget | null;
  /** Wall thickness or beam width, metres. */
  readonly width: number;
  /** Wall height or section height, metres. */
  readonly height: number;
  /** Storey-local z of the body's underside. */
  readonly bottom: number;
  /** The join core's read of a wall; null for a beam or a refused element. */
  readonly wall: WallJoinRead | null;
  readonly beam: LinearElementEditChain | null;
  /** Why it can be neither trimmed nor extended; null when it can. */
  readonly refusal: string | null;
  /** Its footprint in plan, storey-local: the axis band, or the mesh bounds of a refused one. */
  readonly outline: readonly Vec2[];
}

export interface SlabEdge extends TargetRef {
  readonly label: string;
  readonly a: Vec2;
  readonly b: Vec2;
}

export interface TrimExtendModel {
  readonly targets: readonly TrimTarget[];
  readonly slabEdges: readonly SlabEdge[];
}

export const EMPTY_MODEL: TrimExtendModel = { targets: [], slabEdges: [] };

export interface Boundary extends ReachBoundary {
  readonly kind: 'wall' | 'beam' | 'slab' | 'line';
  /** The element it is, for a wall or beam (excluded from the targets, and a wall boundary joins). */
  readonly ref: TargetRef | null;
  /** The join core's read of a boundary wall. */
  readonly wall: WallJoinWall | null;
  readonly label: string;
}

export const minLengthOf = (kind: 'wall' | 'beam'): number => (kind === 'wall' ? MIN_WALL_SEGMENT_LENGTH : MIN_LINEAR_SEGMENT_LENGTH);

const key = (k: TranslationKey, params?: Record<string, string | number>) => translate(k, params);

/** Mesh bounds of an element as a plan polygon in the storey frame; null without a mesh. */
function boundsPolygon(s: ViewerState, plane: Workplane, finder: ReturnType<typeof createEntityBoundsLookup>, ref: TargetRef): Vec2[] | null {
  const box = finder(toGlobalIdFromModels(s.models, ref.modelId, ref.expressId));
  if (!box) return null;
  const corners: Vec3[] = [
    [box.min.x, box.min.y, box.min.z], [box.max.x, box.min.y, box.min.z],
    [box.max.x, box.min.y, box.max.z], [box.min.x, box.min.y, box.max.z],
  ];
  return corners.map((c) => {
    const local = plane.renderToLocal(c);
    return [local[0], local[1]] as Vec2;
  });
}

function refusedTarget(
  s: ViewerState, plane: Workplane, finder: ReturnType<typeof createEntityBoundsLookup>,
  ref: TargetRef, kind: 'wall' | 'beam', reason: string,
): TrimTarget {
  return {
    ...ref, label: labelOf(s, ref.modelId, ref.expressId), kind, axis: null, width: 0, height: 0, bottom: 0,
    wall: null, beam: null, refusal: reason, outline: boundsPolygon(s, plane, finder, ref) ?? [],
  };
}

/** Why the Split button would not take `ref`, as the sentence it shows; a generic one when it would. */
function splitReason(s: ViewerState, ref: TargetRef, fallback: string): string {
  const verdict = s.readSplitTarget(ref.modelId, ref.expressId);
  return verdict.ok ? fallback : translate(verdict.reasonKey);
}

/**
 * Read the session storey's walls, beams and members and its slab edges.
 * Cheap enough to redo after every commit; never per pointer move.
 */
export function prepareModel(s: ViewerState, modelId: string, storeyId: number, plane: Workplane): TrimExtendModel {
  const edit = modelEditTarget(s, modelId);
  if (!edit) return EMPTY_MODEL;
  const scale = getModelLengthUnitScale(edit.dataStore);
  const finder = createEntityBoundsLookup(meshesForOwningModel(s, modelId));
  const targets: TrimTarget[] = [];
  for (const expressId of storeyCandidates(s, modelId, storeyId, CANDIDATE_TYPES)) {
    const ref = { modelId, expressId };
    const type = stepTypeOf(s, modelId, expressId) ?? '';
    if (WALL_TYPES.has(type)) {
      const read = readWallJoinTarget(edit.dataStore, edit.view, expressId, scale);
      if (!read) {
        targets.push(refusedTarget(s, plane, finder, ref, 'wall', splitReason(s, ref, key('trimExtend.refused.wallBody'))));
        continue;
      }
      const [start, end] = [read.wall.start, read.wall.end];
      const length = Math.hypot(end[0] - start[0], end[1] - start[1]);
      const z = read.location[2] * scale;
      targets.push({
        ...ref, label: labelOf(s, modelId, expressId), kind: 'wall',
        axis: { p0: [start[0], start[1], z], dir: [(end[0] - start[0]) / length, (end[1] - start[1]) / length, 0], length },
        width: read.wall.thickness, height: read.height, bottom: z, wall: read, beam: null, refusal: null,
        outline: segmentOutline(start, end, read.wall.thickness) ?? [],
      });
      continue;
    }
    const chain = resolveLinearElementChain(edit.dataStore, edit.view, edit.editor, expressId, scale);
    if (!chain) {
      targets.push(refusedTarget(s, plane, finder, ref, 'beam', splitReason(s, ref, key('splitTool.unavailable.shape'))));
      continue;
    }
    const [dx, dy, dz] = chain.axisDirection;
    const start = chain.startCoordinates;
    const label = labelOf(s, modelId, expressId);
    if (Math.hypot(dx, dy) < 0.05) {
      targets.push({ ...refusedTarget(s, plane, finder, ref, 'beam', key('trimExtend.refused.vertical')), label });
      continue;
    }
    const end: Vec2 = [start[0] + dx * chain.depth, start[1] + dy * chain.depth];
    targets.push({
      ...ref, label, kind: 'beam',
      axis: { p0: [start[0], start[1], start[2]], dir: [dx, dy, dz], length: chain.depth },
      width: chain.profileWidth, height: chain.profileHeight, bottom: start[2] - chain.profileHeight / 2,
      wall: null, beam: chain, refusal: null, outline: segmentOutline([start[0], start[1]], end, chain.profileWidth) ?? [],
    });
  }

  const slabEdges: SlabEdge[] = [];
  for (const expressId of storeyCandidates(s, modelId, storeyId, SLAB_TYPES)) {
    const footprint = s.readSlabFootprint(modelId, expressId)?.footprint;
    if (!footprint || footprint.length < 3) continue;
    const label = key('trimExtend.boundary.slab', { name: labelOf(s, modelId, expressId) });
    footprint.forEach((p, i) => {
      const q = footprint[(i + 1) % footprint.length];
      slabEdges.push({ modelId, expressId, label, a: [p[0], p[1]], b: [q[0], q[1]] });
    });
  }
  return { targets, slabEdges };
}

function distanceToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const length2 = dx * dx + dy * dy;
  const t = length2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length2)) : 0;
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** Half a body plus a few pixels: how far off its axis a cursor may be and still pick it. */
export function pickSlack(s: Pick<SnapResult, 'metresPerPixel'>): number {
  return Math.max(0.03, (s.metresPerPixel ?? 0.01) * 10);
}

/**
 * The wall, beam or member under `local`: the nearest axis whose body (grown
 * by `slack`) holds the point, or a refused element whose mesh bounds do.
 * `exclude` (the boundary's own element) is never picked.
 */
export function pickTarget(model: TrimExtendModel, local: Vec2, slack: number, exclude: TargetRef | null = null): TrimTarget | null {
  let best: { target: TrimTarget; d: number } | null = null;
  for (const target of model.targets) {
    if (exclude && target.modelId === exclude.modelId && target.expressId === exclude.expressId) continue;
    const { axis } = target;
    let d: number;
    if (axis) {
      const end: Vec2 = [axis.p0[0] + axis.dir[0] * axis.length, axis.p0[1] + axis.dir[1] * axis.length];
      d = distanceToSegment(local, [axis.p0[0], axis.p0[1]], end) - target.width / 2;
      if (d > slack) continue;
    } else if (target.outline.length >= 3 && pointInPolygon(target.outline as Point2D[], [local[0], local[1]])) {
      d = 0;
    } else continue;
    if (!best || d < best.d) best = { target, d };
  }
  return best?.target ?? null;
}

/** The axis of a wall or beam target as a boundary. Null for a refused one. */
export function boundaryOfTarget(target: TrimTarget): Boundary | null {
  const { axis } = target;
  if (!axis) return null;
  return {
    kind: target.kind, ref: { modelId: target.modelId, expressId: target.expressId }, wall: target.wall?.wall ?? null,
    label: key(target.kind === 'wall' ? 'trimExtend.boundary.wall' : 'trimExtend.boundary.beam', { name: target.label }),
    a: [axis.p0[0], axis.p0[1]],
    b: [axis.p0[0] + axis.dir[0] * axis.length, axis.p0[1] + axis.dir[1] * axis.length],
    tMin: 0, tMax: 1, reach: target.width / 2,
  };
}

/** A snap guide as a boundary: a segment (an edge), a ray, or a whole line (a grid axis). */
export function boundaryOfGuide(guide: Guide | undefined, label: string): Boundary | null {
  if (!guide) return null;
  if (guide.kind === 'segment') return { kind: 'line', ref: null, wall: null, label, a: guide.a, b: guide.b, tMin: 0, tMax: 1, reach: 0.005 };
  if (guide.kind === 'line' || guide.kind === 'ray') {
    const b: Vec2 = [guide.origin[0] + guide.dir[0], guide.origin[1] + guide.dir[1]];
    return { kind: 'line', ref: null, wall: null, label, a: guide.origin, b, tMin: guide.kind === 'ray' ? 0 : -Infinity, tMax: Infinity, reach: 0.005 };
  }
  return null;
}

/**
 * The boundary under the cursor, best first: a wall or beam whose body it is
 * over, the slab edge it is near, then the line the snap solver holds (a grid
 * axis, an edge of anything else).
 */
export function pickBoundary(model: TrimExtendModel, snap: SnapResult): Boundary | null {
  const slack = pickSlack(snap);
  const element = pickTarget(model, snap.local, slack);
  const asBoundary = element && boundaryOfTarget(element);
  if (asBoundary) return asBoundary;
  let edge: { edge: SlabEdge; d: number } | null = null;
  for (const e of model.slabEdges) {
    const d = distanceToSegment(snap.local, e.a, e.b);
    if (d <= slack && (!edge || d < edge.d)) edge = { edge: e, d };
  }
  if (edge) {
    return { kind: 'slab', ref: null, wall: null, label: edge.edge.label, a: edge.edge.a, b: edge.edge.b, tMin: 0, tMax: 1, reach: 0.005 };
  }
  const guide = snap.winner?.guide;
  return boundaryOfGuide(guide, key(snap.winner?.source === 'grid' ? 'trimExtend.boundary.grid' : 'trimExtend.boundary.edge'));
}

/** The boundary as a drawable segment: a line or ray with no end is drawn a hundred metres each way from where it starts. */
export function boundarySegment(boundary: ReachBoundary): [Vec2, Vec2] {
  const dx = boundary.b[0] - boundary.a[0], dy = boundary.b[1] - boundary.a[1];
  const length = Math.hypot(dx, dy) || 1;
  const reachT = 100 / length;
  const t0 = Math.max(boundary.tMin, -reachT), t1 = Math.min(boundary.tMax, reachT);
  return [[boundary.a[0] + dx * t0, boundary.a[1] + dy * t0], [boundary.a[0] + dx * t1, boundary.a[1] + dy * t1]];
}
