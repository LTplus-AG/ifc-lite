/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** The slice of `Cesium.PrimitiveCollection` a model swap needs. */
export interface PrimitiveCollectionLike<T> {
  add(primitive: T): unknown;
  remove(primitive: T): boolean;
}

/**
 * Put `next` on the globe in place of `previous`, without a visible gap.
 *
 * The ordering is the whole point (#2583). The world view used to drop its
 * model the moment anything invalidated it — a geometry batch, a type toggle, a
 * georef edit, a hide — and only then start a debounce, a GLB build and a glTF
 * load. The building vanished from the map for a second or more on every edit,
 * which reads as a bug in the model rather than a reload.
 *
 * Adding before removing is necessary but NOT sufficient, and that distinction
 * is what `whenReady` exists for. `Model.fromGltfAsync` resolving does not mean
 * the model can draw: Cesium finishes loading inside `update()` across
 * subsequent frames, sets `_ready` from `frameState.afterRender`, and then
 * deliberately skips one more frame before rendering. Removing the old model as
 * soon as the new one was *constructed* would swap a drawable primitive for a
 * blank one and leave the map empty for several frames — a much shorter gap
 * than before, but the same defect, and one a "is a model present?" probe
 * cannot see. So the old model is not dropped until the new one reports ready.
 *
 * `remove` destroys the primitive it drops (Cesium's `PrimitiveCollection` owns
 * its children by default), so the old model's GPU buffers are released here
 * rather than leaking one model per rebuild — on a 35 MB GLB that is not an
 * amount you can leak repeatedly.
 */
export async function swapCesiumModel<T>(
  primitives: PrimitiveCollectionLike<T>,
  previous: T | null,
  next: T,
  whenReady: (next: T) => Promise<void>,
): Promise<void> {
  // Replacing a primitive with itself must touch nothing. Adding it a second
  // time is not harmless on a real PrimitiveCollection — it would duplicate the
  // draw or throw — and there would be nothing left to release afterwards.
  if (previous === next) return;
  primitives.add(next);
  if (previous === null) return;
  try {
    await whenReady(next);
  } catch {
    // A model that never reports ready must not strand the old one on the
    // globe forever; dropping it here is the same outcome as before this
    // change, and the caller has already logged the failure.
  }
  primitives.remove(previous);
}
