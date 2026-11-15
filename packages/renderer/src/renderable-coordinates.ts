/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Coordinates accepted by the finite float32 GPU translation boundary. */
export function renderableCoordinates(values: readonly number[]): boolean {
  return values.length === 3 && values.every((v) => Number.isFinite(v) && Number.isFinite(Math.fround(v)));
}
