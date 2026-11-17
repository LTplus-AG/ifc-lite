/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A railing on a stair refits with it (#9296). When a storey edit refits a
 * stair to a new rise (more or fewer risers of the same tread), a railing
 * that runs up that stair is stretched the same way: along the run by the
 * new run's ratio, up by the new rise's ratio, about the stair's foot. Its
 * height above the pitch, its side offset and its post layout are kept.
 *
 * A railing is on a stair when it is the builder's layout (`railing.ts`:
 * one swept handrail over a polyline, one post per base point) on the
 * stair's storey and its whole path climbs the stair: it starts at the foot
 * and ends at the top tread's nosing line (within 2 cm), every vertex inside
 * the run and the rise, and beside or over the flight (within 0.5 m of its
 * sides). Nothing else is guessed at.
 */

import { editOwnershipRefusal, expandAffectedSet } from '@ifc-lite/export';
import { getModelLengthUnitScale } from './edit/length-unit-scale.js';
import type { EditTarget } from './edit/target.js';
import { applyFrame, inverseFrame, placementRelativeTo, pointOf, refId, type Vec3 } from './host-geometry-frame.js';
import { AnchorEntityReader } from './resolve-anchor.js';

const TOLERANCE = 0.02;
const SIDE_REACH = 0.5;

/** A stair's flight in its own placement frame, metres: run along +X, width along +Y, rise up. */
export interface StairExtent {
  readonly stairId: number;
  readonly run: number;
  readonly rise: number;
  readonly width: number;
}

interface RailingBody {
  readonly placementId: number;
  readonly polylineId: number;
  /** Directrix points, railing-local, native units. */
  readonly directrix: Vec3[];
  readonly posts: Array<{ solidId: number; base: Vec3 }>;
  /** Handrail axis height above the path, native units. */
  readonly axisHeight: number;
}

function number(value: unknown): number | null {
  const raw = typeof value === 'object' && value !== null && 'real' in value ? (value as { real: unknown }).real : value;
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
}

function readRailingBody(reader: AnchorEntityReader, railingId: number): RailingBody | null {
  const railing = reader.entity(railingId);
  if (railing?.type.toUpperCase() !== 'IFCRAILING') return null;
  const placementId = refId(railing.attributes[5]);
  const shape = reader.entity(refId(railing.attributes[6]) ?? -1);
  const reps = shape?.attributes[2];
  const rep = Array.isArray(reps) && reps.length === 1 ? reader.entity(refId(reps[0]) ?? -1) : null;
  const items = Array.isArray(rep?.attributes[3]) ? (rep!.attributes[3] as unknown[]).map(refId) : [];
  if (placementId === null || items.length < 3 || items.some((id) => id === null)) return null;
  const [rail, ...postIds] = items as number[];
  const disk = reader.entity(rail);
  const polylineId = disk?.type.toUpperCase() === 'IFCSWEPTDISKSOLID' ? refId(disk.attributes[0]) : null;
  const polyline = polylineId === null ? null : reader.entity(polylineId);
  const points = polyline?.type.toUpperCase() === 'IFCPOLYLINE' && Array.isArray(polyline.attributes[0]) ? polyline.attributes[0] as unknown[] : [];
  const directrix = points.map((value) => pointOf(reader, value));
  if (directrix.length < 2 || directrix.some((p) => !p)) return null;
  const posts: RailingBody['posts'] = [];
  let axisHeight: number | null = null;
  for (const solidId of postIds) {
    const solid = reader.entity(solidId);
    if (solid?.type.toUpperCase() !== 'IFCEXTRUDEDAREASOLID') return null;
    const position = reader.entity(refId(solid.attributes[1]) ?? -1);
    const base = position?.type.toUpperCase() === 'IFCAXIS2PLACEMENT3D' && position.attributes[1] == null && position.attributes[2] == null
      ? pointOf(reader, position.attributes[0]) : null;
    const depth = number(solid.attributes[3]);
    if (!base || depth === null || (axisHeight !== null && Math.abs(depth - axisHeight) > 1e-9)) return null;
    axisHeight = depth;
    posts.push({ solidId, base });
  }
  return { placementId, polylineId: polylineId!, directrix: directrix as Vec3[], posts, axisHeight: axisHeight! };
}

/** The railing's refit map in the stair's frame, or null when the railing is not on the stair. */
function onStair(target: EditTarget, railingId: number, stairPlacementId: number, stair: StairExtent) {
  const reader = new AnchorEntityReader(target.dataStore, target.view);
  const body = readRailingBody(reader, railingId);
  if (!body) return null;
  const toStair = placementRelativeTo(reader, body.placementId, stairPlacementId);
  if (!toStair || Math.abs(toStair.z[2] - 1) > 1e-9) return null;
  const scale = getModelLengthUnitScale(target.dataStore);
  const path = body.directrix.map((p) => applyFrame(toStair, [p[0], p[1], p[2] - body.axisHeight]).map((v) => v * scale) as Vec3);
  const near = (a: number, b: number) => Math.abs(a - b) <= TOLERANCE;
  const first = path[0], last = path[path.length - 1];
  const foot = (p: Vec3) => near(p[0], 0) && near(p[2], 0);
  const top = (p: Vec3) => near(p[0], stair.run) && near(p[2], stair.rise);
  const inside = path.every((p) => p[0] >= -TOLERANCE && p[0] <= stair.run + TOLERANCE && p[2] >= -TOLERANCE && p[2] <= stair.rise + TOLERANCE
    && p[1] >= -SIDE_REACH && p[1] <= stair.width + SIDE_REACH);
  if (!inside || !((foot(first) && top(last)) || (foot(last) && top(first)))) return null;
  return { body, toStair, scale };
}

export interface RailingRefit {
  readonly railingId: number;
  readonly stairId: number;
}

/** Railings among `candidates` that run up `stair`. Pure read. */
export function railingsOnStair(target: EditTarget, stair: StairExtent, candidates: readonly number[]): RailingRefit[] {
  const reader = new AnchorEntityReader(target.dataStore, target.view);
  const stairPlacementId = refId(reader.entity(stair.stairId)?.attributes[5]);
  if (stairPlacementId === null) return [];
  return candidates.filter((id) => onStair(target, id, stairPlacementId, stair)).map((railingId) => ({ railingId, stairId: stair.stairId }));
}

/**
 * Stretch a railing on `before` to `after` (the same stair, refit). Caller
 * owns the atomic transaction; returns the reason when it cannot be written.
 */
export function refitStairRailing(target: EditTarget, railingId: number, before: StairExtent, after: Pick<StairExtent, 'run' | 'rise'>): string | null {
  const reader = new AnchorEntityReader(target.dataStore, target.view);
  const stairPlacementId = refId(reader.entity(before.stairId)?.attributes[5]);
  const found = stairPlacementId === null ? null : onStair(target, railingId, stairPlacementId, before);
  if (!found) return `the railing #${railingId} no longer runs up the stair #${before.stairId}`;
  const { body, toStair } = found;
  const back = inverseFrame(toStair);
  const kRun = after.run / before.run, kRise = after.rise / before.rise;
  // Railing-local native point of a path point, mapped through the stair's stretch.
  const stretch = (p: Vec3): Vec3 => {
    const s = applyFrame(toStair, p);
    return applyFrame(back, [s[0] * kRun, s[1], s[2] * kRise]).map((v) => Math.round(v * 1e9) / 1e9) as Vec3;
  };
  const up = (p: Vec3, dz: number): Vec3 => [p[0], p[1], p[2] + dz];
  const ownership = editOwnershipRefusal(target.dataStore, target.view, [body.polylineId, ...body.posts.map((post) => post.solidId)],
    expandAffectedSet(target.dataStore, target.view, [railingId], 'hostsChanged'));
  if (ownership) return ownership;
  const points = body.directrix.map((p) => target.editor.addEntity('IfcCartesianPoint', [up(stretch(up(p, -body.axisHeight)), body.axisHeight)]).expressId);
  target.editor.setPositionalAttribute(body.polylineId, 0, points.map((id) => `#${id}`));
  for (const post of body.posts) {
    const point = target.editor.addEntity('IfcCartesianPoint', [stretch(post.base)]).expressId;
    const position = target.editor.addEntity('IfcAxis2Placement3D', [`#${point}`, null, null]).expressId;
    target.editor.setPositionalAttribute(post.solidId, 1, `#${position}`);
  }
  return null;
}
