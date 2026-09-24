/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Pure constants and uniform packing for the selection/hover outline
 * composite (#5390), the WGSL side in `shaders/edges.wgsl.ts`'s
 * `outlineFragmentSource`. Mirrors `edge-params.ts`'s split between pure TS
 * (unit-tested) and the shader that reads it.
 */

/** Selection outline colour: accessible blue, matching the existing highlight fill's hue family. */
export const SELECTION_OUTLINE_COLOR: readonly [number, number, number] = [0.30, 0.62, 1.0];
/** Hover pre-highlight: the same hue, lower alpha and never drawn through occluders. */
export const HOVER_OUTLINE_COLOR: readonly [number, number, number] = [0.30, 0.62, 1.0];

/** Alpha the solid (visible) selection outline reaches at full coverage. */
export const SELECTION_VISIBLE_ALPHA = 0.9;
/** The hidden-portion outline is dimmer, not dashed: simpler and immune to pattern aliasing. */
export const SELECTION_HIDDEN_ALPHA = 0.35;
/** Hover is a thin pre-highlight, well below the selection's own alpha. */
export const HOVER_VISIBLE_ALPHA = 0.5;

/** Float offsets of the `OutlineParams` struct in `shaders/edges.wgsl.ts`. */
export const OUTLINE_UNIFORM_LAYOUT = {
  viewport: 0,
  selectionColor: 4,
  hoverColor: 8,
} as const;

export const OUTLINE_UNIFORM_BYTES = (OUTLINE_UNIFORM_LAYOUT.hoverColor + 4) * 4;

export interface OutlineFrameParams {
  width: number;
  height: number;
}

/** Pack one frame's `OutlineParams` into `out` (`OUTLINE_UNIFORM_BYTES / 4` floats). */
export function packOutlineUniforms(out: Float32Array, frame: OutlineFrameParams): void {
  const L = OUTLINE_UNIFORM_LAYOUT;
  out[L.viewport] = frame.width;
  out[L.viewport + 1] = frame.height;
  out[L.viewport + 2] = 0;
  out[L.viewport + 3] = 0;
  out.set([...SELECTION_OUTLINE_COLOR, SELECTION_VISIBLE_ALPHA], L.selectionColor);
  out.set([...HOVER_OUTLINE_COLOR, HOVER_VISIBLE_ALPHA], L.hoverColor);
}
