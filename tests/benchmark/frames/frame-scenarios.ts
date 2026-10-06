/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Scripted input for the frame-time rigs (#6960): one array of CDP input
 * events per frame, in canvas-relative geometry, so the deterministic rig
 * (one BeginFrame per step) and the real-GPU rig (one step per 8.333 ms of
 * wall time) replay the same gesture.
 */

export interface CanvasRect { x: number; y: number; width: number; height: number }

export interface CdpInput {
  method: 'Input.dispatchMouseEvent' | 'Input.dispatchKeyEvent';
  params: Record<string, unknown>;
}

const mouse = (type: 'mouseMoved' | 'mousePressed' | 'mouseReleased', x: number, y: number, held: boolean): CdpInput => ({
  method: 'Input.dispatchMouseEvent',
  params: {
    type, x: Math.round(x), y: Math.round(y),
    button: type === 'mouseMoved' && !held ? 'none' : 'left',
    buttons: held && type !== 'mouseReleased' ? 1 : 0,
    clickCount: type === 'mouseMoved' ? 0 : 1,
  },
});

/** Home resets the camera to the model's default view (viewer keyboard map). */
export function homeKey(): CdpInput[][] {
  const key = { key: 'Home', code: 'Home', windowsVirtualKeyCode: 36, nativeVirtualKeyCode: 36 };
  return [
    [{ method: 'Input.dispatchKeyEvent', params: { type: 'rawKeyDown', ...key } }],
    [{ method: 'Input.dispatchKeyEvent', params: { type: 'keyUp', ...key } }],
  ];
}

/**
 * Left-drag orbit: press at the canvas centre, sweep a horizontal ellipse
 * (half a canvas width, a fifth of its height) over `frames` frames, release.
 * Trailing frames with no input are where inertia plays out; callers add them.
 */
export function orbitGesture(rect: CanvasRect, frames = 120): CdpInput[][] {
  const cx = rect.x + rect.width / 2, cy = rect.y + rect.height / 2;
  const rx = rect.width / 4, ry = rect.height / 10;
  const point = (i: number) => {
    const t = (i / (frames - 1)) * Math.PI * 2;
    return [cx + rx * Math.sin(t), cy + ry * (1 - Math.cos(t)) / 2] as const;
  };
  const steps: CdpInput[][] = [[mouse('mouseMoved', cx, cy, false), mouse('mousePressed', cx, cy, true)]];
  for (let i = 1; i < frames - 1; i++) steps.push([mouse('mouseMoved', ...point(i), true)]);
  steps.push([mouse('mouseReleased', ...point(frames - 1), true)]);
  return steps;
}

/** Hover sweep: no button, a zig-zag across the central 80% of the canvas. */
export function hoverSweep(rect: CanvasRect, frames = 120): CdpInput[][] {
  const rows = 4;
  const steps: CdpInput[][] = [];
  for (let i = 0; i < frames; i++) {
    const along = (i / frames) * rows;
    const row = Math.floor(along), u = along - row;
    const fx = row % 2 === 0 ? u : 1 - u;
    const fy = (row + 0.5) / rows;
    steps.push([mouse('mouseMoved', rect.x + rect.width * (0.1 + 0.8 * fx), rect.y + rect.height * (0.1 + 0.8 * fy), false)]);
  }
  return steps;
}
