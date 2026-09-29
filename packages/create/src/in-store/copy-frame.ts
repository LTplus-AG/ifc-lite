/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The placement arithmetic behind copying a product (#6232 C3): an
 * `IfcLocalPlacement` read as a rigid frame (a turn about the vertical plus
 * a translation, in the file's native length unit), composed up to the
 * storey's own placement, and the copy's turn-and-move applied to it.
 *
 * Frames here turn about the vertical only: a placement whose Axis is tilted
 * contributes its RefDirection's plan projection, as every storey-local
 * reader in this package does (`placement-frame.ts`).
 */

import type { IfcAttributeValue } from '@ifc-lite/mutations';
import { asRef } from './style-entity-reader.js';

export type CopyVec3 = [number, number, number];

/** A read of one live record (`createStyleEntityReader`). */
export type LiveRead = (id: number) => { type: string; attributes: readonly unknown[] } | null;

/** `p ↦ R(c, s)·p + origin`; `z` just adds. */
export interface RigidFrame {
  readonly origin: CopyVec3;
  readonly c: number;
  readonly s: number;
}

export const IDENTITY_FRAME: RigidFrame = { origin: [0, 0, 0], c: 1, s: 0 };

export function applyRigid(f: RigidFrame, p: readonly number[]): CopyVec3 {
  return [f.origin[0] + f.c * p[0] - f.s * p[1], f.origin[1] + f.s * p[0] + f.c * p[1], f.origin[2] + (p[2] ?? 0)];
}

export function composeRigid(outer: RigidFrame, inner: RigidFrame): RigidFrame {
  return {
    origin: applyRigid(outer, inner.origin),
    c: outer.c * inner.c - outer.s * inner.s,
    s: outer.s * inner.c + outer.c * inner.s,
  };
}

export function invertRigid(f: RigidFrame): RigidFrame {
  const [x, y, z] = f.origin;
  return { origin: [-(f.c * x + f.s * y), -(-f.s * x + f.c * y), -z], c: f.c, s: -f.s };
}

/** The turn about the vertical through `pivot`, then the move `offset`: one rigid frame. */
export function turnThenMove(turn: number, pivot: readonly [number, number], offset: readonly number[]): RigidFrame {
  const c = Math.cos(turn);
  const s = Math.sin(turn);
  // q = R(p - pivot) + pivot + offset = R p + (pivot - R pivot + offset)
  return {
    origin: [pivot[0] - (c * pivot[0] - s * pivot[1]) + offset[0], pivot[1] - (s * pivot[0] + c * pivot[1]) + offset[1], offset[2] ?? 0],
    c,
    s,
  };
}

export function numberTriple(value: unknown): CopyVec3 | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  const out = [0, 0, 0].map((_, i) => (i < value.length ? value[i] : 0));
  return out.every((v) => typeof v === 'number' && Number.isFinite(v)) ? (out as CopyVec3) : null;
}

export interface OwnPlacement {
  readonly frame: RigidFrame;
  readonly parentId: number | null;
  readonly location: CopyVec3;
  readonly axis: CopyVec3 | null;
  readonly refDirection: CopyVec3 | null;
}

/** One `IfcLocalPlacement`'s own frame in its parent's, or null when a link does not read. */
export function readOwnPlacement(read: LiveRead, placementId: number): OwnPlacement | null {
  const placement = read(placementId);
  const axisPlacementId = asRef(placement?.attributes[1]);
  const axisPlacement = axisPlacementId === null ? null : read(axisPlacementId);
  if (!placement || !axisPlacement) return null;
  const locationId = asRef(axisPlacement.attributes[0]);
  const location = locationId === null ? null : numberTriple(read(locationId)?.attributes[0]);
  if (!location) return null;
  const direction = (slot: unknown): CopyVec3 | null => {
    const id = asRef(slot);
    return id === null ? null : numberTriple(read(id)?.attributes[0]);
  };
  const axis = direction(axisPlacement.attributes[1]);
  const refDirection = direction(axisPlacement.attributes[2]);
  const [dx, dy] = refDirection ?? [1, 0, 0];
  const length = Math.hypot(dx, dy);
  const [c, s] = length > 1e-9 ? [dx / length, dy / length] : [1, 0];
  return { frame: { origin: location, c, s }, parentId: asRef(placement.attributes[0]), location, axis, refDirection };
}

/**
 * The frame of `placementId` in `ancestorId`'s frame: every placement from it
 * up to (not including) the ancestor, composed. `placementId === ancestorId`
 * is the identity. Null when the chain does not reach the ancestor (or loops).
 */
export function frameInAncestor(read: LiveRead, placementId: number | null, ancestorId: number): RigidFrame | null {
  let frame = IDENTITY_FRAME;
  const visited = new Set<number>();
  let id = placementId;
  while (id !== null && id !== ancestorId) {
    if (visited.has(id)) return null;
    visited.add(id);
    const own = readOwnPlacement(read, id);
    if (!own) return null;
    frame = composeRigid(own.frame, frame);
    id = own.parentId;
  }
  return id === ancestorId ? frame : null;
}

/** `v` turned counter-clockwise about the vertical by the frame's turn (directions do not translate). */
export function turnDirection(f: Pick<RigidFrame, 'c' | 's'>, v: CopyVec3): CopyVec3 {
  return [f.c * v[0] - f.s * v[1], f.s * v[0] + f.c * v[1], v[2]];
}

/** A `#N` reference token, or null. */
export function refToken(id: number | null): string | null {
  return id === null ? null : `#${id}`;
}

/** Rewrite every `#old` token in a (possibly nested) attribute value that `ids` maps. */
export function remapRefs(value: unknown, ids: ReadonlyMap<number, number>): IfcAttributeValue {
  if (Array.isArray(value)) return value.map((v) => remapRefs(v, ids)) as IfcAttributeValue;
  if (typeof value === 'string') {
    const id = asRef(value);
    const mapped = id === null ? undefined : ids.get(id);
    return mapped === undefined ? value : `#${mapped}`;
  }
  return value as IfcAttributeValue;
}
