/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** The slice of `Cesium.PrimitiveCollection` a model swap needs. */
export interface PrimitiveCollectionLike<T> {
  add(primitive: T): unknown;
  remove(primitive: T): boolean;
}

/**
 * Put `next` on the globe in place of `previous`, without a gap.
 *
 * The order is the whole point (#2583). The world view used to drop its model
 * the moment anything invalidated it — a geometry batch, a type toggle, a
 * georef edit, a hide — and only then start a debounce, a GLB build and a glTF
 * load. The building vanished from the map for a second or more on every edit,
 * which reads as a bug in the model rather than a reload.
 *
 * Adding before removing means the globe holds two models for the width of this
 * function and never zero. `remove` destroys the primitive it drops (Cesium's
 * `PrimitiveCollection` owns its children by default), so the old model's GPU
 * buffers are released here rather than leaking one model per rebuild — on a
 * 35 MB GLB that is not an amount you can leak repeatedly.
 */
export function swapCesiumModel<T>(
  primitives: PrimitiveCollectionLike<T>,
  previous: T | null,
  next: T,
): void {
  primitives.add(next);
  if (previous !== null && previous !== next) primitives.remove(previous);
}
