/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The instanced template membership a released-scene recovery must restore
 * (#10264), kept on the scene across unsuccessful attempts: a failed attempt's
 * reset already removed the templates, so a retry cannot read them back. Every
 * reshape of the scene updates it exactly as it updates the templates
 * themselves (a rebuild keeps only the present models, a removal drops one),
 * and a `clear()` (new content) forgets it. A successful recovery forgets it.
 */

const kept = new WeakMap<object, Set<number>>();

export function keepReleasedMembership(scene: object, indices: Iterable<number>): void { kept.set(scene, new Set(indices)); }
export function keptReleasedMembership(scene: object): ReadonlySet<number> | undefined { return kept.get(scene); }
export function forgetReleasedMembership(scene: object): void { kept.delete(scene); }

/** A reshape that keeps only `present` models' templates. */
export function keepPresentInReleasedMembership(scene: object, present: ReadonlySet<number>): void {
  const indices = kept.get(scene);
  if (indices) for (const index of [...indices]) if (!present.has(index)) indices.delete(index);
}

/** One model's templates were removed. */
export function dropFromReleasedMembership(scene: object, modelIndex: number): void { kept.get(scene)?.delete(modelIndex); }
