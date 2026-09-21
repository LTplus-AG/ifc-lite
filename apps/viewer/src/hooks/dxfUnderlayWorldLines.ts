/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** RTE-safe 3D DXF line construction, kept separate from 2D drawing mapping. */

import { applyDxfPlacement, type Point2D } from '@ifc-lite/drawing-2d';
import type { AnchoredRendererLineVertices } from '@/lib/renderer/line-overlay-rte';
import type { DxfUnderlayState } from '@/store/slices/drawing2DSlice';

export type AnchoredDxfLines3D = AnchoredRendererLineVertices;

function worldLineNumbers(entry: DxfUnderlayState, shift: { x: number; y: number }, elevation: number, mapToWorld: (p: Point2D) => Point2D, georeferenced: boolean): number[] {
  const vertices: number[] = [];
  for (const layer of entry.underlay.layers) {
    if (!(entry.layerVisibility[layer.name] ?? layer.visible)) continue;
    for (const path of layer.paths) {
      if (path.points.length < 2) continue;
      const points = path.points.map((point) => {
        const world = georeferenced ? mapToWorld(point) : point;
        return applyDxfPlacement({ x: world.x - shift.x, y: -(world.y - shift.y) }, entry.placement);
      });
      for (let index = 0; index < points.length - 1; index++) {
        vertices.push(points[index].x, elevation, points[index].y, points[index + 1].x, elevation, points[index + 1].y);
      }
      if (path.closed && points.length > 2) {
        const last = points[points.length - 1], first = points[0];
        vertices.push(last.x, elevation, last.y, first.x, elevation, first.y);
      }
    }
  }
  return vertices;
}

export function dxfUnderlayToWorldLines3D(entry: DxfUnderlayState, shift: { x: number; y: number }, elevation: number, mapToWorld: (p: Point2D) => Point2D, georeferenced: boolean): Float32Array {
  return new Float32Array(worldLineNumbers(entry, shift, elevation, mapToWorld, georeferenced));
}

export function dxfUnderlayToWorldLines3DAnchored(entry: DxfUnderlayState, shift: { x: number; y: number }, elevation: number, mapToWorld: (p: Point2D) => Point2D, georeferenced: boolean): AnchoredDxfLines3D | null {
  const world = worldLineNumbers(entry, shift, elevation, mapToWorld, georeferenced);
  if (world.length === 0) return null;
  const origin: [number, number, number] = [world[0], world[1], world[2]];
  const localVertices = new Float32Array(world.length);
  for (let index = 0; index < world.length; index += 3) {
    localVertices[index] = world[index] - origin[0];
    localVertices[index + 1] = world[index + 1] - origin[1];
    localVertices[index + 2] = world[index + 2] - origin[2];
  }
  return { localVertices, origin };
}
