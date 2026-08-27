/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `CameraControl` — the camera surface `Renderer.getCamera()` hands across the
 * package boundary.
 *
 * WHY THIS EXISTS: `getCamera()` used to return the `Camera` class itself, so
 * the interface a consumer of `@ifc-lite/renderer` had to learn was `Renderer`
 * PLUS everything `Camera` happens to expose, and every method added to
 * `Camera` widened the published surface without anyone deciding to. This
 * interface freezes that leak at its measured width.
 *
 * HOW THE MEMBER LIST WAS CHOSEN: it is not a design sketch, it is a
 * measurement. Every `renderer.getCamera()` call site in `apps/viewer` and
 * `apps/viewer-embed` was resolved with the TypeScript checker and the returned
 * value followed through locals, class fields, object-literal properties,
 * parameters and function returns until it was dereferenced; the 39 members
 * below are exactly the ones something outside `packages/renderer/src` reaches
 * for. Two independent passes (a type-directed sweep over property accesses and
 * the origin-accurate taint scan) agreed on all 39.
 *
 * ADDING A MEMBER IS A DECISION, NOT A DETAIL. A new entry here is a new
 * published API for `@ifc-lite/renderer` and cannot be taken back without a
 * major bump. Add one when a caller genuinely needs it — not because `Camera`
 * already has it.
 *
 * `Camera` is NOT declared `implements CameraControl`: an `implements` clause
 * would let the class's own surface drift wider without the interface noticing,
 * which is the thing this file exists to stop. The check that the class
 * satisfies this shape is the `return this.camera` in `Renderer.getCamera()`,
 * which fails to compile the moment a signature here stops matching.
 */

import type { Vec3 } from './types.js';
import type { ProjectionMode } from './camera-state.js';
import type { Bounds3, FitPolicy } from './camera-fit-policy.js';

/**
 * An axis-aligned box in the camera's own world frame. Spelled structurally
 * (rather than as `Bounds3`) because that is the shape the `Camera` methods
 * below are declared with, and the two must match exactly.
 */
type CameraBounds = {
  min: { x: number; y: number; z: number };
  max: { x: number; y: number; z: number };
};

/** The measured external camera surface. See the module doc before widening. */
export interface CameraControl {
  // ─── Pose ────────────────────────────────────────────────────────────
  getPosition(): Vec3;
  setPosition(x: number, y: number, z: number): void;
  getTarget(): Vec3;
  setTarget(x: number, y: number, z: number): void;
  getUp(): Vec3;
  setUp(x: number, y: number, z: number): void;
  getRotation(): { azimuth: number; elevation: number };
  setRotation(azimuth: number, elevation: number): void;
  getDistance(): number;
  reset(): void;

  // ─── Interactive navigation ──────────────────────────────────────────
  orbit(deltaX: number, deltaY: number, addVelocity?: boolean): void;
  pan(deltaX: number, deltaY: number, addVelocity?: boolean): void;
  zoom(
    delta: number,
    addVelocity?: boolean,
    mouseX?: number,
    mouseY?: number,
    canvasWidth?: number,
    canvasHeight?: number,
    fastZoom?: boolean,
  ): void;
  stopInertia(): void;
  update(deltaTime: number): boolean;

  // ─── First-person walk mode ──────────────────────────────────────────
  enableFirstPersonMode(enabled: boolean): void;
  moveFirstPerson(forward: number, right: number, up: number): void;

  // ─── Framing ─────────────────────────────────────────────────────────
  fitToBounds(min: Vec3, max: Vec3): void;
  fitBoundsAdaptive(
    bounds: Bounds3,
    options?: { animate?: boolean; duration?: number; viewportShortPx?: number },
  ): FitPolicy;
  frameBounds(min: Vec3, max: Vec3, duration?: number): Promise<void>;
  framePoint(point: Vec3, duration?: number): Promise<void>;
  zoomExtent(min: Vec3, max: Vec3, duration?: number): Promise<void>;
  animateTo(endPos: Vec3, endTarget: Vec3, duration?: number): Promise<void>;
  animateToWithUp(endPos: Vec3, endTarget: Vec3, endUp: Vec3, duration?: number): Promise<void>;
  setPresetView(
    view: 'top' | 'bottom' | 'front' | 'back' | 'left' | 'right',
    bounds?: { min: Vec3; max: Vec3 },
    buildingRotation?: number,
  ): void;

  // ─── Projection ──────────────────────────────────────────────────────
  getProjectionMode(): ProjectionMode;
  setProjectionMode(mode: ProjectionMode): void;
  toggleProjectionMode(): void;
  getFOV(): number;
  setFOV(fov: number): void;
  getOrthoSize(): number;
  setOrthoSize(size: number): void;

  // ─── Screen <-> world ────────────────────────────────────────────────
  projectToScreen(
    worldPos: Vec3,
    canvasWidth: number,
    canvasHeight: number,
  ): { x: number; y: number } | null;
  unprojectToRay(
    screenX: number,
    screenY: number,
    canvasWidth: number,
    canvasHeight: number,
  ): { origin: Vec3; direction: Vec3 };

  // ─── Bounds the camera reasons about ─────────────────────────────────
  getSceneBounds(): CameraBounds | null;
  setSceneBounds(bounds: CameraBounds | null): void;
  getOrbitAnchorBounds(): CameraBounds | null;
  setOrbitAnchorBounds(bounds: CameraBounds | null): void;
  setOrbitCenter(center: Vec3 | null): void;
}
