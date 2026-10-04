/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Editing joined walls in the store (#6232 B2): join two walls that are
 * already there, and move wall ends with their joins following.
 *
 *  - `joinWallsInStore` reads both walls, then writes the join. Two walls that
 *    are already joined get the new `IfcRelConnectsPathElements` in place of
 *    the old one, never a second beside it.
 *  - `reshapeWallsInStore` gives walls new axis ends. A dragged corner brings
 *    the walls joined at that end along, changed ends are made square while
 *    unchanged ends retain their cuts, and every affected join is recomputed. A join that
 *    no longer holds (the axes no longer meet) is removed and the wall that did
 *    not move stops square at its own end.
 *
 * Both write through the editor only. Joining is atomic; reshaping runs inside
 * the caller's transaction. Hosts record either as one undo step. Every length
 * in and out is metres, storey-local.
 */

import { editOwnershipRefusal, expandAffectedSet } from '@ifc-lite/export';
import type { StoreEditor } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';
import { toNativeLength } from './anchor.js';
import { resolveAuthoringAnchor } from './resolve-relations.js';
import { AnchorEntityReader } from './resolve-anchor.js';
import { applyWallJoinToStore, rewriteWall, type JoinAnchor, type WallJoinApplyOptions, type WallJoinApplyResult } from './wall-join-apply.js';
import { readWallJoinRels, readWallJoinTarget, type WallJoinRead, type WallJoinRel } from './wall-join-read.js';
import { computeWallJoin, reshapeWallAxis, type PlanPoint, type WallJoinWall } from './wall-join.js';
import { assertWallOpeningsFit } from './wall-opening-fit.js';

/** What a join write needs from the model: the authoring anchor plus the context an `Axis` representation lives in. */
export function resolveWallJoinAnchor(store: IfcDataStore, view?: Parameters<typeof resolveAuthoringAnchor>[1]): JoinAnchor {
  const base = resolveAuthoringAnchor(store, view);
  const reader = new AnchorEntityReader(store, view);
  const axisContextId = reader.contextId('axis', reader.rootContextId());
  if (axisContextId === null) throw new Error('resolveWallJoinAnchor: no IfcGeometricRepresentationContext (or Axis subcontext) found in store');
  return { ownerHistoryId: base.ownerHistoryId, schema: base.schema, lengthUnitScale: base.lengthUnitScale, axisContextId };
}

function mustRead(store: IfcDataStore, editor: StoreEditor, wallId: number, scale: number, op: string): WallJoinRead {
  const read = readWallJoinTarget(store, editor.getMutationView(), wallId, scale);
  if (!read) throw new Error(`${op}: #${wallId} is not a straight wall with a body this editor can rewrite`);
  return read;
}

export interface WallJoinInStoreResult extends WallJoinApplyResult {
  /** The relationships this join replaced, now removed. */
  replacedRelIds: number[];
}

/**
 * Join walls `aId` and `bId`. See `computeWallJoin` for the geometry and
 * options. When the pair is already joined, the old relationship is removed
 * (its name and priorities carried over) and the wall that ran through then
 * still does, unless `options.priority` says otherwise. Nothing is written
 * when the join is refused.
 */
export function joinWallsInStore(
  editor: StoreEditor,
  store: IfcDataStore,
  anchor: JoinAnchor,
  aId: number,
  bId: number,
  options: WallJoinApplyOptions = {},
): WallJoinInStoreResult {
  return editor.runAtomic(draft => joinWalls(draft, store, anchor, aId, bId, options));
}

function joinWalls(
  editor: StoreEditor, store: IfcDataStore, anchor: JoinAnchor, aId: number, bId: number, options: WallJoinApplyOptions,
): WallJoinInStoreResult {
  const op = 'joinWallsInStore';
  const a = mustRead(store, editor, aId, anchor.lengthUnitScale ?? 1, op);
  const b = mustRead(store, editor, bId, anchor.lengthUnitScale ?? 1, op);
  if (a.parentPlacementId !== b.parentPlacementId) throw new Error(`${op}: walls #${aId} and #${bId} are not placed in the same frame`);

  const existing = readWallJoinRels(store, editor.getMutationView(), new Set([aId, bId]))
    .filter((rel) => (rel.relatingId === aId && rel.relatedId === bId) || (rel.relatingId === bId && rel.relatedId === aId));
  const first = existing[0];
  const priority = options.priority ?? (first ? (first.relatingId === aId ? 'a' : 'b') : undefined);
  const priorities = options.priorities ?? (first
    ? (first.relatingId === aId
      ? { a: first.relatingPriorities, b: first.relatedPriorities }
      : { a: first.relatedPriorities, b: first.relatingPriorities })
    : undefined);
  const joinOptions: WallJoinApplyOptions = { ...options, priority, priorities, Name: options.Name ?? first?.name ?? undefined };
  // Refuse before the old relationship is touched.
  const join = computeWallJoin(a.wall, b.wall, joinOptions);
  assertWallOpeningsFit(store, editor.getMutationView(), a, join.a.wall, anchor.lengthUnitScale ?? 1);
  assertWallOpeningsFit(store, editor.getMutationView(), b, join.b.wall, anchor.lengthUnitScale ?? 1);
  for (const rel of existing) editor.removeEntity(rel.relId);
  return { ...applyWallJoinToStore(editor, anchor, a, b, joinOptions), replacedRelIds: existing.map((rel) => rel.relId) };
}

/** A wall's new axis ends and thickness, storey-local metres. What is left out stays. */
export interface WallReshape {
  wallId: number;
  start?: PlanPoint;
  end?: PlanPoint;
  thickness?: number;
}

export interface WallReshapeOptions {
  /** A moved end takes the walls joined end to end with it (an L corner or a butt join) along. */
  moveJoinedEnds?: boolean;
  /** Tolerance of the recomputed joins, see `computeWallJoin`. */
  tolerance?: number;
  /**
   * Walls that were moved as a whole (a rigid move or turn) and are NOT
   * rewritten here: the joins they are part of are recomputed against the
   * walls that are.
   */
  refresh?: readonly number[];
}

export interface WallReshapeResult {
  /** Every wall whose geometry was written, moved or re-cut: the ones to re-mesh. */
  walls: number[];
  /** The relationships written. */
  relIds: number[];
  /** Relationships removed because their walls no longer meet. */
  droppedRelIds: number[];
}

const MOVE_EPS = 1e-9;
const MIN_LENGTH = 1e-6;

/**
 * Give walls new axis ends and keep every join that touches them current.
 * Refuses (writing nothing) a wall this module cannot read, a wall that would
 * have no length or leave its storey plane is the caller's to check.
 */
export function reshapeWallsInStore(
  editor: StoreEditor,
  store: IfcDataStore,
  anchor: JoinAnchor,
  edits: readonly WallReshape[],
  options: WallReshapeOptions = {},
): WallReshapeResult {
  const op = 'reshapeWallsInStore';
  const scale = anchor.lengthUnitScale ?? 1;
  const view = () => editor.getMutationView();
  const targets = new Map<number, WallJoinRead>();
  const load = (id: number): WallJoinRead => {
    let read = targets.get(id);
    if (!read) targets.set(id, (read = mustRead(store, editor, id, scale, op)));
    return read;
  };

  // The requested axes, then the walls a moved corner drags along.
  const axes = new Map<number, { start: PlanPoint; end: PlanPoint; thickness?: number }>();
  for (const edit of edits) {
    const read = load(edit.wallId);
    const start = edit.start ?? read.wall.start;
    const end = edit.end ?? read.wall.end;
    if (![...start, ...end].every(Number.isFinite)) throw new Error(`${op}: wall #${edit.wallId} has a non-finite end`);
    if (Math.hypot(end[0] - start[0], end[1] - start[1]) < MIN_LENGTH) throw new Error(`${op}: wall #${edit.wallId} would have no length`);
    if (edit.thickness !== undefined && !(Number.isFinite(edit.thickness) && edit.thickness > 0)) {
      throw new Error(`${op}: wall #${edit.wallId} thickness must be positive`);
    }
    axes.set(edit.wallId, { start, end, thickness: edit.thickness });
  }
  if (options.moveJoinedEnds) {
    for (const rel of readWallJoinRels(store, view(), new Set(axes.keys()))) {
      for (const [self, other, selfConn, otherConn] of [
        [rel.relatingId, rel.relatedId, rel.relatingConnection, rel.relatedConnection],
        [rel.relatedId, rel.relatingId, rel.relatedConnection, rel.relatingConnection],
      ] as const) {
        const moved = axes.get(self);
        if (!moved || axes.has(other) || selfConn === 'ATPATH' || otherConn === 'ATPATH') continue;
        const from = load(self).wall;
        const key = selfConn === 'ATSTART' ? 'start' : 'end';
        if (Math.hypot(moved[key][0] - from[key][0], moved[key][1] - from[key][1]) <= MOVE_EPS) continue;
        const partner = load(other).wall;
        const newAxis: { start: PlanPoint; end: PlanPoint; thickness?: number } = { start: partner.start, end: partner.end };
        newAxis[otherConn === 'ATSTART' ? 'start' : 'end'] = moved[key];
        axes.set(other, newAxis);
      }
    }
  }
  for (const id of axes.keys()) load(id);

  // Everything that can refuse has run: write. Each moved wall gets a fresh
  // placement point and direction (the old ones may be shared with other
  // walls), retaining supported cuts at unchanged ends on the same direction.
  const rels = readWallJoinRels(store, view(), new Set([...axes.keys(), ...(options.refresh ?? [])]));
  const touched = new Set<number>(axes.keys());
  // A refresh can rewrite either joined wall, including neighbours that did
  // not move. Their solid/shape records must not belong to unrelated products.
  for (const rel of rels) {
    readOrNull(store, editor, targets, rel.relatingId, scale);
    readOrNull(store, editor, targets, rel.relatedId, scale);
  }
  const bodyIds = [...targets.values()].flatMap(read => [read.solidId, read.productShapeId]);
  const ownership = editOwnershipRefusal(store, view(), bodyIds, new Set(targets.keys()));
  if (ownership) throw new Error(`${op}: ${ownership}`);
  const placementIds = [...axes].flatMap(([id, ends]) => holdsPlacement(load(id).wall, ends.start, ends.end) ? [] : [load(id).axisPlacementId]);
  const placementOwnership = editOwnershipRefusal(store, view(), placementIds, expandAffectedSet(store, view(), targets.keys(), 'hostsChanged'));
  if (placementOwnership) throw new Error(`${op}: ${placementOwnership}`);
  for (const [id, { start, end, thickness }] of axes) targets.set(id, writeAxis(editor, anchor, load(id), start, end, thickness));

  // Recompute every join that touches a moved wall: the joined end snaps to the
  // crossing and is cut to the other wall's face. The relating wall runs through.
  const relIds: number[] = [];
  const droppedRelIds: number[] = [];
  for (const rel of rels) {
    const a = readOrNull(store, editor, targets, rel.relatingId, scale);
    const b = readOrNull(store, editor, targets, rel.relatedId, scale);
    if (!a || !b) continue;
    const joinOptions = joinOptionsOf(rel, options.tolerance);
    try {
      computeWallJoin(a.wall, b.wall, joinOptions);
    } catch {
      // The walls no longer meet: the join goes, and a wall that did not move stops square at that end.
      editor.removeEntity(rel.relId);
      droppedRelIds.push(rel.relId);
      for (const [wall, connection] of [[a, rel.relatingConnection], [b, rel.relatedConnection]] as const) {
        if (axes.has(wall.wallId) || connection === 'ATPATH') continue;
        targets.set(wall.wallId, squareEnd(editor, anchor, wall, connection));
        touched.add(wall.wallId);
      }
      continue;
    }
    editor.removeEntity(rel.relId);
    const written = applyWallJoinToStore(editor, anchor, a, b, joinOptions);
    relIds.push(written.relId);
    for (const [id, next] of [[a.wallId, written.a], [b.wallId, written.b]] as const) {
      targets.set(id, { ...load(id), ...next });
      touched.add(id);
    }
  }
  return { walls: [...touched], relIds, droppedRelIds };
}

function readOrNull(store: IfcDataStore, editor: StoreEditor, targets: Map<number, WallJoinRead>, id: number, scale: number): WallJoinRead | null {
  const known = targets.get(id);
  if (known) return known;
  const read = readWallJoinTarget(store, editor.getMutationView(), id, scale);
  if (read) targets.set(id, read);
  return read;
}

/** The recompute options of an existing join: the relating wall (`a`) keeps running through, its name and priorities stay. */
function joinOptionsOf(rel: WallJoinRel, tolerance: number | undefined): WallJoinApplyOptions {
  return {
    priority: 'a',
    ...(tolerance === undefined ? {} : { tolerance }),
    priorities: { a: rel.relatingPriorities, b: rel.relatedPriorities },
    Name: rel.name ?? undefined,
  };
}

/**
 * Move `read` onto the axis `start`..`end`, retaining unchanged end cuts. The placement
 * stays where it is when the start does not move and the direction holds (a
 * far-end drag: the openings hosted in the wall keep their place); otherwise it
 * gets a fresh point and direction at the new start (the old ones may be
 * shared with other walls).
 */
/** The existing axis writer retains placement when start and direction stay. */
function holdsPlacement(old: WallJoinWall, start: PlanPoint, end: PlanPoint): boolean {
  const oldLength = Math.hypot(old.end[0] - old.start[0], old.end[1] - old.start[1]);
  const length = Math.hypot(end[0] - start[0], end[1] - start[1]);
  return Math.hypot(start[0] - old.start[0], start[1] - old.start[1]) <= MOVE_EPS
    && (((end[0] - start[0]) / length) * ((old.end[0] - old.start[0]) / oldLength)
      + ((end[1] - start[1]) / length) * ((old.end[1] - old.start[1]) / oldLength)) > 1 - 1e-12;
}

function writeAxis(editor: StoreEditor, anchor: JoinAnchor, read: WallJoinRead, start: PlanPoint, end: PlanPoint, thickness = read.wall.thickness): WallJoinRead {
  const length = Math.hypot(end[0] - start[0], end[1] - start[1]);
  const native = (v: number) => toNativeLength(anchor, v);
  const reshaped = reshapeWallAxis({ ...read.wall, thickness }, start, end);

  const ux = (end[0] - start[0]) / length;
  const uy = (end[1] - start[1]) / length;
  if (holdsPlacement(read.wall, start, end)) {
    return { ...read, ...rewriteWall(editor, anchor, { ...read, wall: reshaped }, reshaped), wall: reshaped, plain: false };
  }
  const point = editor.addEntity('IfcCartesianPoint', [[native(start[0]), native(start[1]), read.location[2]]]).expressId;
  const direction = editor.addEntity('IfcDirection', [[ux, uy, 0]]).expressId;
  editor.setPositionalAttribute(read.axisPlacementId, 0, `#${point}`);
  editor.setPositionalAttribute(read.axisPlacementId, 2, `#${direction}`);
  const moved = rewriteWall(editor, anchor, { ...read, origin: start, wall: reshaped }, reshaped);
  return {
    ...read, ...moved, locationPointId: point, refDirectionId: direction,
    location: [native(start[0]), native(start[1]), read.location[2]], origin: start, wall: reshaped, plain: false,
  };
}

/** `read`'s wall with its joined end cut square again. */
function squareEnd(editor: StoreEditor, anchor: JoinAnchor, read: WallJoinRead, connection: 'ATSTART' | 'ATEND'): WallJoinRead {
  const { startCut, endCut, ...rest } = read.wall;
  const wall: WallJoinWall = {
    ...rest,
    ...(connection === 'ATEND' && startCut ? { startCut } : {}),
    ...(connection === 'ATSTART' && endCut ? { endCut } : {}),
  };
  return { ...read, ...rewriteWall(editor, anchor, read, wall), wall };
}
