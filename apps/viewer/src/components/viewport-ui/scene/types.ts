/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Framework- and renderer-agnostic types for the scene-overlay kernel
 * (#5486, charter #5478). Kept free of `@ifc-lite/renderer` imports so
 * {@link SceneProjector} can be unit-tested with a stub camera, and so a
 * future non-viewer consumer (if one ever appears) isn't forced to depend on
 * the renderer package for the projector's public shape.
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface ScreenPoint {
  x: number;
  y: number;
}

/** The subset of `Camera` the projector needs — matches `Camera.projectToScreen`. */
export interface ProjectorCamera {
  projectToScreen(worldPos: Vec3, canvasWidth: number, canvasHeight: number): ScreenPoint | null;
}

export interface CanvasSize {
  width: number;
  height: number;
}

/**
 * What the projector reads each tick to decide whether to do any work.
 * `isDirty` must be a non-consuming peek (see `Renderer.peekRenderRequest`):
 * the projector is one of potentially several readers, and consuming the
 * flag here would starve the main render loop of it.
 */
export interface ProjectorSource {
  getCamera(): ProjectorCamera | null;
  getCanvasSize(): CanvasSize | null;
  isDirty(): boolean;
}

/** The result of projecting one anchor's world point this tick. */
export interface AnchorProjection {
  /** CSS-px screen position, or `null` when it cannot be projected right now. */
  screen: ScreenPoint | null;
  /** True when there is no camera/canvas, or the world point is behind the camera / outside the view frustum. */
  behindCamera: boolean;
  /** True when `screen` is off the canvas bounds (by more than the configured margin). Always false when `screen` is null. */
  offScreen: boolean;
}

export const HIDDEN_PROJECTION: AnchorProjection = { screen: null, behindCamera: true, offScreen: false };

export type ProjectorListener = (projection: AnchorProjection) => void;

/** How an anchor is unregistered — returned by `SceneProjector.registerAnchor`. */
export type Unregister = () => void;
