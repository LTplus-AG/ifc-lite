/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Public contracts for section caps and independent world-line overlays. */

export const LINE_OVERLAY_CHANNELS = ['annotation', 'alignment', 'grid', 'dxf', 'terrain'] as const;
export type LineOverlayChannel = (typeof LINE_OVERLAY_CHANNELS)[number];

export interface Section2DOverlayCapStyle {
  fillColor: [number, number, number, number];
  strokeColor: [number, number, number, number];
  patternId: number;
  spacingPx: number;
  angleRad: number;
  widthPx: number;
  secondaryAngleRad: number;
}

export interface Section2DOverlayOptions {
  axis: 'down' | 'front' | 'side';
  position: number;
  bounds: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } };
  viewProj: Float32Array;
  rteViewProj?: Float32Array;
  rteCamera?: readonly [number, number, number];
  flipped?: boolean;
  min?: number;
  max?: number;
  capStyle?: Section2DOverlayCapStyle;
  showFills?: boolean;
  showOutlines?: boolean;
}
