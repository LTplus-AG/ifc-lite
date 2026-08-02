/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/* Tuple-API surface over the Plato-generated vector kernel
 * (generated/plato.g.ts). Public signatures are unchanged: every function
 * takes and returns `[x, y, z]` tuples. The arithmetic lives once, in the
 * single-source generated code; these wrappers bind the flattened tuple-native
 * kernels (zero per-call allocation beyond the returned tuple, same as the old
 * hand-written code). */

import type { Vec3 } from '../types.js';
import * as G from './generated/plato.g.js';

export function sub(a: Vec3, b: Vec3): Vec3 {
  return G.sub(a, b);
}

export function add(a: Vec3, b: Vec3): Vec3 {
  return G.add(a, b);
}

export function scale(a: Vec3, s: number): Vec3 {
  return G.scale(a, s);
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return G.cross(a, b);
}

export function dot(a: Vec3, b: Vec3): number {
  return G.dot(a, b);
}

export function lenSq(a: Vec3): number {
  return G.lenSq(a);
}

export function distSq(a: Vec3, b: Vec3): number {
  return G.distSq(a, b);
}

export function mid(a: Vec3, b: Vec3): Vec3 {
  return G.mid(a, b);
}

export function centroid(a: Vec3, b: Vec3, c: Vec3): Vec3 {
  return G.centroid(a, b, c);
}
