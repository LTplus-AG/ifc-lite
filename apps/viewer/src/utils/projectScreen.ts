/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Project a world position to CSS-pixel screen coordinates.
 *
 * `camera.projectToScreen` returns coordinates in the canvas DRAWING-BUFFER
 * space (`0..canvas.width`), which is device pixels: the CSS box times the
 * display's pixel ratio (#5383). DOM overlays — the measure gizmo / line, the
 * move and section gizmos, the snap indicator — are positioned in CSS pixels,
 * so the raw buffer coordinates would land off the cursor (issue #1107).
 * Scaling buffer-space → CSS px puts them back under it.
 */
export function projectToCssScreen(
  camera: {
    projectToScreen(
      p: { x: number; y: number; z: number },
      w: number,
      h: number,
    ): { x: number; y: number } | null;
  },
  canvas: HTMLCanvasElement,
  worldPos: { x: number; y: number; z: number },
): { x: number; y: number } | null {
  const projected = camera.projectToScreen(worldPos, canvas.width, canvas.height);
  if (!projected) return null;
  const rect = canvas.getBoundingClientRect();
  if (!canvas.width || !canvas.height || !rect.width || !rect.height) return projected;
  return {
    x: projected.x * (rect.width / canvas.width),
    y: projected.y * (rect.height / canvas.height),
  };
}
