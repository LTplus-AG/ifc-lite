/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The plan behind `split.multi` (charter #6232, C5): which elements one cut
 * plane splits, and which it cannot.
 *
 * The cut is a vertical plane through two points. Every target's geometry is
 * read ONCE (`prepareTargets`: the walls' and beams' plan axes, the slabs'
 * footprints, each in its own storey's local frame), so a pointer move only
 * re-runs the cheap intersection (`evaluateCut`). The verdicts are the ONE
 * split predicate the Split button shares (`readSplitTarget`,
 * `lib/split-target.ts`): a target it refuses is reported with that reason and
 * never touched. The cut itself is the existing per-element split actions,
 * composed by the command; nothing here writes to the store.
 */

import { resolve as translate } from '@/i18n/registry';
import type { TranslationKey } from '@/i18n';
import { toGlobalIdFromModels } from '@/store/globalId';
import { meshesForOwningModel } from '@/store/owningModelMeshes';
import type { ViewerState } from '@/store';
import { createEntityBoundsLookup } from '@/utils/viewportUtils';
import { MIN_WALL_SEGMENT_LENGTH } from '@/lib/wall-edit';
import { clipPolygonByLine, type Point2D } from '@/lib/polygon-clip';
import type { Vec2 } from '@/lib/snap/types';
import { buildStoreyWorkplane, elementStoreyId, isWorkplane } from '../workplane.js';
import type { Vec3, Workplane } from '../types.js';

/** A wall, beam or slab is what "everything the cut crosses" means on a storey. */
const STOREY_TYPES = new Set(['IFCWALL', 'IFCWALLSTANDARDCASE', 'IFCBEAM', 'IFCSLAB']);
/** A beam this close to vertical has no plan axis to cross. */
const MIN_PLAN_AXIS = 0.05;
/** Side-of-line tolerance, metres: an element that only touches the plane is not crossed. */
const SIDE_EPS = 1e-6;

export interface TargetRef { readonly modelId: string; readonly expressId: number }

interface Bounds { readonly minX: number; readonly maxX: number; readonly minZ: number; readonly maxZ: number; readonly y: number }

export type TargetShape =
  /** A wall or beam: its plan axis, and how it splits (`splitWallAtDistance` / `splitLinearElementAtDistance`). */
  | { readonly kind: 'axis'; readonly op: 'wall' | 'linear'; readonly start: Vec2; readonly end: Vec2; readonly length: number }
  /** A slab-like element: its footprint, cut by the line itself. */
  | { readonly kind: 'footprint'; readonly polygon: Point2D[] }
  /** Cannot be split; its render-space extent (when it has a mesh) says whether the plane crosses it. */
  | { readonly kind: 'refused'; readonly reason: string; readonly bounds: Bounds | null };

export interface MultiSplitTarget extends TargetRef {
  readonly label: string;
  /** Selected by the user: a refusal is always reported. Otherwise it is one of the storey's candidates. */
  readonly explicit: boolean;
  /** The storey workplane the shape is expressed in; null for a refused target. */
  readonly plane: Workplane | null;
  readonly shape: TargetShape;
  /** The element drawn as a polyline in render space (closed for a footprint). */
  readonly outline: readonly Vec3[];
}

export type SplitOp =
  | { readonly kind: 'wall'; readonly distance: number }
  | { readonly kind: 'linear'; readonly distance: number }
  | { readonly kind: 'slab'; readonly a: [number, number]; readonly b: [number, number] };

export interface PlannedSplit extends TargetRef {
  readonly label: string;
  readonly op: SplitOp;
}

export interface RefusedTarget extends TargetRef {
  readonly label: string;
  readonly reason: string;
}

/** What the HUD draws for one target the plane crosses. */
export interface CutMark extends TargetRef {
  readonly status: 'split' | 'refused';
  readonly outline: readonly Vec3[];
  readonly closed: boolean;
  /** Where the plane meets a wall or beam axis (render space); null for a footprint or a refusal. */
  readonly at: Vec3 | null;
  /** The refusal, for a refused mark. */
  readonly reason?: string;
}

export interface MultiSplitPlan {
  readonly splits: readonly PlannedSplit[];
  readonly refused: readonly RefusedTarget[];
  readonly marks: readonly CutMark[];
}

export const EMPTY_PLAN: MultiSplitPlan = { splits: [], refused: [], marks: [] };

const key = (k: TranslationKey, params?: Record<string, string | number>) => translate(k, params);

function stepTypeOf(s: ViewerState, modelId: string, expressId: number): string | undefined {
  const view = s.mutationViews.get(modelId);
  const type = view?.getEntityTypeMutation(expressId)?.newType
    ?? view?.getNewEntity(expressId)?.type
    ?? s.models.get(modelId)?.ifcDataStore?.entities.getTypeName(expressId);
  return type?.toUpperCase();
}

function labelOf(s: ViewerState, modelId: string, expressId: number): string {
  const name = s.models.get(modelId)?.ifcDataStore?.entities.getName(expressId);
  return name ? `${name} #${expressId}` : `#${expressId}`;
}

function storeyPlane(s: ViewerState, modelId: string, expressId: number): Workplane | null {
  const storeyId = elementStoreyId(s, modelId, expressId);
  if (storeyId === null) return null;
  const plane = buildStoreyWorkplane(s, modelId, storeyId, 0);
  return isWorkplane(plane) ? plane : null;
}

/** The walls, beams and slabs contained in `storeyId` right now, deleted and re-contained ones out. */
export function storeyCandidates(s: ViewerState, modelId: string, storeyId: number): number[] {
  const hierarchy = s.models.get(modelId)?.ifcDataStore?.spatialHierarchy;
  const view = s.mutationViews.get(modelId);
  return [...(hierarchy?.byStorey.get(storeyId) ?? [])].filter((id) =>
    !view?.isDeleted(id) && STOREY_TYPES.has(stepTypeOf(s, modelId, id) ?? '') && elementStoreyId(s, modelId, id) === storeyId);
}

/** The axis-aligned box `plane` maps a local rectangle to, as a closed render-space outline. */
function boundsOutline(b: Bounds): Vec3[] {
  return [[b.minX, b.y, b.minZ], [b.maxX, b.y, b.minZ], [b.maxX, b.y, b.maxZ], [b.minX, b.y, b.maxZ]];
}

/**
 * Read `refs`' geometry into what `evaluateCut` needs. `explicit` says the
 * user chose them: a refusal is then always reported, where a storey sweep
 * reports only the refused elements the plane actually crosses.
 */
export function prepareTargets(s: ViewerState, refs: readonly TargetRef[], explicit: boolean, sessionModelId: string): MultiSplitTarget[] {
  const finders = new Map<string, ReturnType<typeof createEntityBoundsLookup>>();
  const boundsOf = ({ modelId, expressId }: TargetRef): Bounds | null => {
    let find = finders.get(modelId);
    if (!find) {
      find = createEntityBoundsLookup(meshesForOwningModel(s, modelId));
      finders.set(modelId, find);
    }
    const box = find(toGlobalIdFromModels(s.models, modelId, expressId));
    return box ? { minX: box.min.x, maxX: box.max.x, minZ: box.min.z, maxZ: box.max.z, y: box.min.y } : null;
  };
  return refs.map((ref) => {
    const { modelId, expressId } = ref;
    const label = labelOf(s, modelId, expressId);
    const refuse = (reason: string): MultiSplitTarget => {
      const bounds = boundsOf(ref);
      return { modelId, expressId, label, explicit, plane: null, shape: { kind: 'refused', reason, bounds }, outline: bounds ? boundsOutline(bounds) : [] };
    };
    if (modelId !== sessionModelId) return refuse(key('multiSplit.refused.otherModel'));
    const verdict = s.readSplitTarget(modelId, expressId);
    if (!verdict.ok) return refuse(translate(verdict.reasonKey));
    const plane = storeyPlane(s, modelId, expressId);
    if (!plane) return refuse(key('modelingCommand.split.noPlane'));
    const base = { modelId, expressId, label, explicit, plane };
    if (verdict.kind === 'slab') return prepareSlab(s, base) ?? refuse(key('splitTool.unavailable.shape'));
    return prepareAxis(s, base, verdict.kind, refuse) ?? refuse(key('splitTool.unavailable.shape'));
  });
}

type Base = Omit<MultiSplitTarget, 'shape' | 'outline' | 'plane'> & { plane: Workplane };

function prepareSlab(s: ViewerState, base: Base): MultiSplitTarget | null {
  const slab = s.readSlabFootprint(base.modelId, base.expressId);
  if (!slab || slab.footprint.length < 3) return null;
  const outline = slab.footprint.map((p) => base.plane.localToRender([p[0], p[1], 0]));
  return { ...base, shape: { kind: 'footprint', polygon: slab.footprint }, outline };
}

function prepareAxis(
  s: ViewerState, base: Base, kind: 'wall' | 'linear', refuse: (reason: string) => MultiSplitTarget,
): MultiSplitTarget | null {
  const { modelId, expressId, plane } = base;
  let start: [number, number, number];
  let end: [number, number, number];
  let length: number;
  if (kind === 'wall') {
    const wall = s.readWallEndpoints(modelId, expressId);
    if (!wall) return null;
    start = wall.start;
    end = wall.end;
    length = Math.hypot(end[0] - start[0], end[1] - start[1]);
  } else {
    // The projection of any point recovers the axis: cutPoint = start + axis * distance.
    const p = s.readLinearElementSplitProjection(modelId, expressId, [0, 0, 0]);
    if (!p) return null;
    if (p.elementType === 'IfcColumn') return refuse(key('multiSplit.refused.column'));
    const [ax, ay, az] = p.axis;
    start = [p.cutPoint[0] - ax * p.distance, p.cutPoint[1] - ay * p.distance, p.cutPoint[2] - az * p.distance];
    end = [start[0] + ax * p.length, start[1] + ay * p.length, start[2] + az * p.length];
    length = p.length;
    if (Math.hypot(end[0] - start[0], end[1] - start[1]) < MIN_PLAN_AXIS) return refuse(key('multiSplit.refused.vertical'));
  }
  return {
    ...base,
    shape: { kind: 'axis', op: kind, start: [start[0], start[1]], end: [end[0], end[1]], length },
    outline: [plane.localToRender(start), plane.localToRender(end)],
  };
}

/** Signed distance of `p` from the line a→b (positive on the left), metres. */
function side(a: readonly number[], b: readonly number[], p: readonly number[]): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len = Math.hypot(dx, dy) || 1;
  return ((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])) / len;
}

/** Whether the render-space line a→b (horizontally) passes through `bounds`. */
function crossesBounds(bounds: Bounds, a: Vec3, b: Vec3): boolean {
  const line = [a[0], a[2]], to = [b[0], b[2]];
  const corners = [[bounds.minX, bounds.minZ], [bounds.maxX, bounds.minZ], [bounds.maxX, bounds.maxZ], [bounds.minX, bounds.maxZ]];
  const sides = corners.map((c) => side(line, to, c));
  return sides.some((v) => v > SIDE_EPS) && sides.some((v) => v < -SIDE_EPS);
}

/**
 * Which of `targets` the vertical plane through render points `a` and `b`
 * splits, and which it crosses but cannot split. A target the plane misses is
 * in neither (a refused one the user selected is still reported: it was asked for).
 */
export function evaluateCut(targets: readonly MultiSplitTarget[], a: Vec3, b: Vec3): MultiSplitPlan {
  const splits: PlannedSplit[] = [];
  const refused: RefusedTarget[] = [];
  const marks: CutMark[] = [];
  const refuse = (t: MultiSplitTarget, reason: string) => {
    refused.push({ modelId: t.modelId, expressId: t.expressId, label: t.label, reason });
    marks.push({ modelId: t.modelId, expressId: t.expressId, status: 'refused', outline: t.outline, closed: t.shape.kind !== 'axis', at: null, reason });
  };
  for (const t of targets) {
    const { shape, plane } = t;
    if (shape.kind === 'refused') {
      if (!shape.bounds ? t.explicit : crossesBounds(shape.bounds, a, b)) refuse(t, shape.reason);
      continue;
    }
    if (!plane) continue;
    const la = plane.renderToLocal(a), lb = plane.renderToLocal(b);
    if (Math.hypot(lb[0] - la[0], lb[1] - la[1]) < SIDE_EPS) continue;
    if (shape.kind === 'axis') {
      const s0 = side(la, lb, shape.start), s1 = side(la, lb, shape.end);
      if (!((s0 > SIDE_EPS && s1 < -SIDE_EPS) || (s0 < -SIDE_EPS && s1 > SIDE_EPS))) continue;
      const t01 = s0 / (s0 - s1);
      const distance = t01 * shape.length;
      if (distance <= MIN_WALL_SEGMENT_LENGTH || distance >= shape.length - MIN_WALL_SEGMENT_LENGTH) {
        refuse(t, key('multiSplit.refused.nearEnd', { min: Math.round(MIN_WALL_SEGMENT_LENGTH * 100) }));
        continue;
      }
      const at = plane.localToRender([
        shape.start[0] + (shape.end[0] - shape.start[0]) * t01,
        shape.start[1] + (shape.end[1] - shape.start[1]) * t01,
        0,
      ]);
      splits.push({ modelId: t.modelId, expressId: t.expressId, label: t.label, op: shape.op === 'wall' ? { kind: 'wall', distance } : { kind: 'linear', distance } });
      marks.push({ modelId: t.modelId, expressId: t.expressId, status: 'split', outline: t.outline, closed: false, at });
      continue;
    }
    const sides = shape.polygon.map((p) => side(la, lb, p));
    if (!(sides.some((v) => v > SIDE_EPS) && sides.some((v) => v < -SIDE_EPS))) continue;
    const cutA: [number, number] = [la[0], la[1]], cutB: [number, number] = [lb[0], lb[1]];
    const clipped = clipPolygonByLine(shape.polygon, cutA, cutB);
    if (!clipped.ok) {
      refuse(t, translate('splitTool.failed', { reason: clipped.reason }));
      continue;
    }
    splits.push({ modelId: t.modelId, expressId: t.expressId, label: t.label, op: { kind: 'slab', a: cutA, b: cutB } });
    marks.push({ modelId: t.modelId, expressId: t.expressId, status: 'split', outline: t.outline, closed: true, at: null });
  }
  return { splits, refused, marks };
}
