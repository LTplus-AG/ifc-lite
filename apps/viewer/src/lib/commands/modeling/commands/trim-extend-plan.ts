/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What one click of `element.trimExtend` would do to one target (charter
 * #6232, C1), decided without writing: the reach (`planReach`), then what the
 * store would refuse anyway, so the preview shows it before the click.
 *
 *  - a wall meeting a wall goes through the join core (`computeWallJoin`): the
 *    preview is the body the join would cut, and a pair it refuses is refused
 *    here with its reason;
 *  - a trim that would cut through an opening, door or window hosted in the
 *    wall is refused, naming how many;
 *  - a beam or member is trimmed or extended along its axis.
 *
 * The commit (`trim-extend-commit.ts`) writes what this decided and re-checks
 * it against the live model.
 */

import { computeWallJoin, reshapeWallAxis, wallBodyOutline, type WallJoinWall } from '@ifc-lite/create';
import type { MeshData } from '@ifc-lite/geometry';
import { resolve as translate } from '@/i18n/registry';
import type { TranslationKey } from '@/i18n';
import type { ViewerState } from '@/store';
import { modelEditTarget } from '@/store/slices/mutation-modelling-records';
import { cutsOutside, readHostedCuts, type HostedCut, type HostedCuts } from '@/lib/wall-hosted-cuts';
import type { Vec2 } from '@/lib/snap/types';
import { prismGhostMesh, segmentOutline } from '../ghost-shapes.js';
import type { Vec3, Workplane } from '../types.js';
import { planeZ } from './placement-shared.js';
import { clickAlong, planReach, type ReachMode, type ReachRefusal } from './trim-extend-geometry.js';
import { minLengthOf, type Boundary, type TrimTarget } from './trim-extend-model.js';
import type { IfcDataStore } from '@ifc-lite/parser';

export type JoinKind = 'L' | 'T' | 'butt';

export type TrimExtendPreview =
  | {
    readonly ok: true;
    readonly target: TrimTarget;
    readonly op: ReachMode;
    /** The end that moves. */
    readonly end: 'start' | 'end';
    /** The new axis ends, storey-local. */
    readonly start: Vec3;
    readonly stop: Vec3;
    readonly length: number;
    /** Metres the end moves outward (negative: trimmed). */
    readonly moved: number;
    /** Where the axis meets the boundary, plan. */
    readonly point: Vec2;
    /** The join a wall makes with a boundary wall; null otherwise. */
    readonly joinKind: JoinKind | null;
    /** The result's body in plan, storey-local (what the ghost extrudes). */
    readonly outline: readonly Vec2[];
    /** The stretch a trim takes away, in plan; null for an extension. */
    readonly removed: readonly Vec2[] | null;
  }
  | { readonly ok: false; readonly target: TrimTarget; readonly reason: string };

const REFUSAL_KEYS: Readonly<Record<ReachRefusal, TranslationKey>> = {
  parallel: 'trimExtend.refused.parallel',
  vertical: 'trimExtend.refused.vertical',
  boundaryShort: 'trimExtend.refused.boundaryShort',
  crossesInside: 'trimExtend.refused.crossesInside',
  notReached: 'trimExtend.refused.notReached',
  otherEnd: 'trimExtend.refused.otherEnd',
  tooShort: 'trimExtend.refused.tooShort',
  alreadyThere: 'trimExtend.refused.alreadyThere',
};

const refuse = (target: TrimTarget, reason: string): TrimExtendPreview => ({ ok: false, target, reason });

/** The band of the axis a trim takes away: from the new end to the old one. */
function removedBand(target: TrimTarget, end: 'start' | 'end', newEnd: Vec2, moved: number): Vec2[] | null {
  const { axis } = target;
  if (!axis || moved >= 0) return null;
  const old: Vec2 = end === 'start'
    ? [axis.p0[0], axis.p0[1]]
    : [axis.p0[0] + axis.dir[0] * axis.length, axis.p0[1] + axis.dir[1] * axis.length];
  return segmentOutline(newEnd, old, target.width);
}

/** The body's plan polygon, storey-local, cuts and offset included. */
export function bodyPolygon(wall: WallJoinWall): Vec2[] {
  const { corners, length } = wallBodyOutline(wall);
  const dx = (wall.end[0] - wall.start[0]) / length;
  const dy = (wall.end[1] - wall.start[1]) / length;
  return corners.map(([x, y]) => [wall.start[0] + x * dx - y * dy, wall.start[1] + x * dy + y * dx] as Vec2);
}

/**
 * The hosted cuts of a wall, read once per wall and edit: a pointer move must
 * not walk every void relationship of the model again. Keyed by the parsed
 * store so a model that is replaced never reads another's cuts.
 */
const cutCache = new WeakMap<IfcDataStore, { version: number; walls: Map<number, HostedCuts> }>();

export function hostedCutsOf(s: ViewerState, modelId: string, wallId: number): HostedCuts | null {
  const edit = modelEditTarget(s, modelId);
  if (!edit) return null;
  let entry = cutCache.get(edit.dataStore);
  if (!entry || entry.version !== s.mutationVersion) cutCache.set(edit.dataStore, entry = { version: s.mutationVersion, walls: new Map() });
  let cuts = entry.walls.get(wallId);
  if (!cuts) entry.walls.set(wallId, cuts = readHostedCuts(edit.dataStore, edit.view, edit.editor, wallId));
  return cuts;
}

/** The body's safe longitudinal span in the original placement frame, including join cuts. */
function bodySpan(target: TrimTarget, wall: WallJoinWall): [number, number] | null {
  const read = target.wall, axis = target.axis;
  if (!read || !axis) return null;
  const [dx, dy] = axis.dir;
  const first = (wall.start[0] - read.origin[0]) * dx + (wall.start[1] - read.origin[1]) * dy;
  const { corners } = wallBodyOutline(wall);
  // Every opening traverses the wall thickness: it must fit both cut faces,
  // including an oblique butt join, not merely the uncut axis endpoints.
  return [first + Math.max(corners[0][0], corners[3][0]), first + Math.min(corners[1][0], corners[2][0])];
}

/**
 * The openings a change of the wall's ends would strand or shift, as a refusal.
 * A trim strands what stands beyond the new end; moving the start moves the
 * placement, so every opening must be known to be put back. Openings whose
 * place cannot be read refuse both: they are never guessed at.
 */
function hostedRefusal(s: ViewerState, target: TrimTarget, wall: WallJoinWall, requireReadable: boolean): string | null {
  const hosted = hostedCutsOf(s, target.modelId, target.expressId);
  const span = bodySpan(target, wall);
  if (!hosted || !span) return translate('trimExtend.refused.hostedUnreadable', { count: 1, countDisplay: '1' });
  if (requireReadable && hosted.unreadable.length > 0) return translate('trimExtend.refused.hostedUnreadable', { count: hosted.unreadable.length, countDisplay: String(hosted.unreadable.length) });
  const outside: HostedCut[] = cutsOutside(hosted.cuts, span[0], span[1]);
  return outside.length > 0 ? translate('trimExtend.refused.hosted', { count: outside.length, countDisplay: String(outside.length) }) : null;
}

/**
 * What clicking `target` at `click` (storey-local) does with `boundary`, in
 * `mode`, or why it is refused.
 */
export function previewFor(s: ViewerState, target: TrimTarget, boundary: Boundary, mode: ReachMode, click: Vec2): TrimExtendPreview {
  const { axis } = target;
  if (target.refusal || !axis) return refuse(target, target.refusal ?? translate('trimExtend.refused.wallBody'));
  const boundaryWall = boundary.kind === 'wall' && boundary.wall !== null && target.kind === 'wall';
  const plan = planReach(axis, boundary, mode, clickAlong(axis, click), minLengthOf(target.kind), boundaryWall);
  if (!plan.ok) return refuse(target, translate(REFUSAL_KEYS[plan.reason]));
  const start: Vec2 = [plan.start[0], plan.start[1]];
  const stop: Vec2 = [plan.stop[0], plan.stop[1]];

  if (target.kind === 'beam') {
    const outline = segmentOutline(start, stop, target.width);
    if (!outline) return refuse(target, translate(REFUSAL_KEYS.tooShort));
    const removed = removedBand(target, plan.end, plan.end === 'start' ? start : stop, plan.moved);
    return { ok: true, target, op: plan.op, end: plan.end, start: plan.start, stop: plan.stop, length: plan.length, moved: plan.moved, point: plan.point, joinKind: null, outline, removed };
  }

  const read = target.wall!;
  let wall = reshapeWallAxis(read.wall, start, stop);
  let joinKind: JoinKind | null = null;
  if (boundaryWall) {
    const other = boundary.wall;
    if (!other) return refuse(target, translate('trimExtend.refused.wallBody'));
    try {
      // The boundary is the `a` side, so a tie runs it through, as `wall.place` runs the earlier wall through.
      const join = computeWallJoin(other, wall);
      joinKind = join.kind;
      wall = join.b.wall;
    } catch (error) {
      return refuse(target, translate('trimExtend.refused.join', { reason: error instanceof Error ? error.message : String(error) }));
    }
  }
  let outline: Vec2[];
  try {
    const previous = bodySpan(target, read.wall);
    const next = bodySpan(target, wall);
    // An end extension is safe without guessing only when its resulting
    // body contains the previous body. A join can shorten that body even
    // when its axis grows; a moved start always needs every opening known.
    // Unknown openings cannot justify a millimetre of clipping tolerance.
    // One nanometre only absorbs roundoff from these metre-space projections.
    const contracts = !previous || !next || next[0] > previous[0] + 1e-9 || next[1] < previous[1] - 1e-9;
    const stranded = hostedRefusal(s, target, wall, plan.moved < 0 || contracts || (plan.end === 'start' && plan.moved !== 0));
    if (stranded) return refuse(target, stranded);
    outline = bodyPolygon(wall);
  } catch (error) {
    return refuse(target, translate('trimExtend.refused.join', { reason: error instanceof Error ? error.message : String(error) }));
  }
  const removed = removedBand(target, plan.end, plan.end === 'start' ? start : stop, plan.moved);
  return { ok: true, target, op: plan.op, end: plan.end, start: plan.start, stop: plan.stop, length: plan.length, moved: plan.moved, point: plan.point, joinKind, outline, removed };
}

/** The result as a ghost mesh, or null for a refusal. */
export function previewGhost(preview: TrimExtendPreview, plane: Workplane, ghostId: number): MeshData | null {
  if (!preview.ok) return null;
  const { target } = preview;
  const z0 = target.bottom - planeZ(plane);
  return prismGhostMesh(plane, preview.outline as Vec2[], z0, z0 + Math.max(target.height, 0.05), ghostId);
}
