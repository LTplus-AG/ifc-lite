/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { AppearanceDraftSettings } from '@/components/viewer/appearance/types.js';
import type { AppearanceMapping } from './planner-types.js';

export const DEFAULT_APPEARANCE_SETTINGS: AppearanceDraftSettings = {
  representationPolicy: 'preserve', kind: 'planar', plane: 'xz', repeatU: 1, repeatV: 1,
  tileWidth: 1, tileHeight: 1, tileDepth: 1, rotationDegrees: 0,
  offsetU: 0, offsetV: 0, offsetW: 0, repeatS: true, repeatT: true,
};

/** UI units are explicit; geometric interpretation remains in the Rust planner. */
export function appearanceMapping(settings: AppearanceDraftSettings): AppearanceMapping {
  const radians = settings.rotationDegrees * Math.PI / 180;
  if (settings.kind === 'existingUv') return {
    kind: 'existingUv', scale: [settings.repeatU, settings.repeatV],
    offset: [settings.offsetU, settings.offsetV], rotationRadians: radians,
  };
  if (settings.kind === 'box') return {
    kind: 'box', frame: 'world', origin: [settings.offsetU, settings.offsetV, settings.offsetW],
    metresPerTile: [settings.tileWidth, settings.tileHeight, settings.tileDepth],
  };
  const axes: Record<AppearanceDraftSettings['plane'], [[number, number, number], [number, number, number]]> = {
    xy: [[1, 0, 0], [0, 1, 0]], xz: [[1, 0, 0], [0, 0, 1]], yz: [[0, 1, 0], [0, 0, 1]],
  };
  const [u, v] = axes[settings.plane];
  const c = Math.cos(radians), s = Math.sin(radians);
  const rotate = (a: number[], b: number[], sign: number): [number, number, number] =>
    [a[0] * c + b[0] * s * sign, a[1] * c + b[1] * s * sign, a[2] * c + b[2] * s * sign];
  return { kind: 'planar', frame: 'world', origin: [settings.offsetU, settings.offsetV, settings.offsetW],
    axisU: rotate(u, v, 1), axisV: rotate(v, u, -1), metresPerTile: [settings.tileWidth, settings.tileHeight] };
}
