/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/* Tuple-API surface over the Plato-generated Vec3 kernel (generated/plato.g.ts).
 * Public signatures are unchanged: every function takes and returns `[x, y, z]`
 * tuples. The arithmetic itself lives once, in the single-source generated
 * class; this module only marshals tuple <-> Vec3. `add` maps to the generated
 * `Plus` (renamed from `Add` in the .plato source so no generated method shares
 * a scalar-intrinsic name). */

import type { Vec3 } from '../types.js';
import { Vec3 as PVec3 } from './generated/plato.g.js';

function v(a: Vec3): PVec3 {
  return new PVec3(a[0], a[1], a[2]);
}

function tuple(p: PVec3): Vec3 {
  return [p.X, p.Y, p.Z];
}

export function sub(a: Vec3, b: Vec3): Vec3 {
  return tuple(v(a).Sub(v(b)));
}

export function add(a: Vec3, b: Vec3): Vec3 {
  return tuple(v(a).Plus(v(b)));
}

export function scale(a: Vec3, s: number): Vec3 {
  return tuple(v(a).Scale(s));
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return tuple(v(a).Cross(v(b)));
}

export function dot(a: Vec3, b: Vec3): number {
  return v(a).Dot(v(b));
}

export function lenSq(a: Vec3): number {
  return v(a).LenSq();
}

export function distSq(a: Vec3, b: Vec3): number {
  return v(a).DistSq(v(b));
}

export function mid(a: Vec3, b: Vec3): Vec3 {
  return tuple(v(a).Mid(v(b)));
}

export function centroid(a: Vec3, b: Vec3, c: Vec3): Vec3 {
  return tuple(v(a).Centroid(v(b), v(c)));
}
