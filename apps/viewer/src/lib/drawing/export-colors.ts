/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { GeometryResult } from '@ifc-lite/geometry';
export function drawingEntityColors(geometry: GeometryResult | null | undefined): Map<number, [number, number, number, number]> {
  const colors = new Map<number, [number, number, number, number]>();
  for (const mesh of geometry?.meshes ?? []) if (mesh.expressId && mesh.color) colors.set(mesh.expressId, mesh.color);
  return colors;
}
