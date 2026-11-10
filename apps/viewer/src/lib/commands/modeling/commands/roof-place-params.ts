/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { Vec2 } from '@/lib/snap/types';
export type RoofPreset = 'hip' | 'gable' | 'mono' | 'flat';
export interface RoofGesture {
  readonly preset: RoofPreset;
  readonly pitch: number;
  readonly edge: number;
  readonly overrides: Readonly<Record<number, number>>;
  readonly overhang: number;
}
export const initialRoof = (): RoofGesture => ({ preset: 'hip', pitch: 30, edge: 0, overrides: {}, overhang: 0 });
/** Per-edge choices belong to one footprint; the next outline keeps only preset, pitch and overhang. */
export const nextRoof = (roof: RoofGesture): RoofGesture => ({ ...roof, edge: 0, overrides: {} });
/** Edges retain the outline's order; UI degrees become SDK radians only here. */
export function roofEdgeSlopes(roof: RoofGesture, outline: readonly Vec2[]): number[] {
  const n = outline.length;
  let opposite = -1;
  if (roof.preset === 'gable' && n >= 3) {
    const [a, b] = outline, dx = b[0] - a[0], dy = b[1] - a[1];
    opposite = outline.findIndex((p, i) => {
      if (i === 0) return false;
      const q = outline[(i + 1) % n], ex = q[0] - p[0], ey = q[1] - p[1];
      return dx * ex + dy * ey < 0 && Math.abs(dx * ey - dy * ex) < 1e-8 * Math.hypot(dx, dy) * Math.hypot(ex, ey);
    });
    if (opposite < 0) throw new Error('A gable roof needs two opposing parallel footprint edges');
  }
  return outline.map((_, i) => {
    const pitched = roof.preset === 'hip' || (roof.preset === 'mono' && i === 0) || (roof.preset === 'gable' && (i === 0 || i === opposite));
    return (roof.overrides[i] ?? (pitched ? roof.pitch : 0)) * Math.PI / 180;
  });
}
