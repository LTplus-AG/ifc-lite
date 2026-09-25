/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Camera and orbit controls
 *
 * Uses composition pattern: delegates to CameraControls (orbit/pan/zoom), CameraAnimator
 * (transitions/inertia/presets), and CameraProjection (screen-world conversion/bounds fitting).
 */

import type { Vec3, Mat4 } from './types.js';
import { MathUtils } from './math.js';
import { CameraControls, type InteractionMode } from './camera-controls.js';
import type { CameraInternalState, ProjectionMode } from './camera-state.js';
import { CameraAnimator } from './camera-animation.js';
import { CameraProjection } from './camera-projection.js';
import { FirstPersonNavigator } from './camera-first-person.js';
import { updateCameraMatrices, updateCameraRelativeFrame } from './camera-matrices.js';
import { CameraOrientation } from './camera-orientation.js';
import { pickFitPolicy, type Bounds3, type FitPolicy, type PickFitPolicyOptions } from './camera-fit-policy.js';
import {
  DEFAULT_ORTHO_SIZE,
  isUsableBounds,
  isUsableDistance,
  usableOrthoSize,
} from './camera-guards.js';
import { RelativeToEyeFrame } from './relative-to-eye.js';
import { surfaceZoomStep } from './camera-surface-zoom.js';
import { CAMERA_CONSTANTS } from './constants.js';

export class Camera {
  private state: CameraInternalState;
  private controls: CameraControls;
  private animator: CameraAnimator;
  private projection: CameraProjection;
  private firstPerson: FirstPersonNavigator;
  private orientation: CameraOrientation;
  /** The sole renderer camera frame used by all RTE-capable consumers. */
  private readonly relativeToEyeFrame = new RelativeToEyeFrame();
  /** Mirror of the controls' gate, for the surface zoom below (#5393). */
  private interactionMode: InteractionMode = 'all';

  constructor() {
    // Geometry is converted from IFC Z-up to WebGL Y-up during import
    this.state = {
      camera: {
        position: { x: 50, y: 50, z: 100 },
        target: { x: 0, y: 0, z: 0 },
        up: { x: 0, y: 1, z: 0 }, // Y-up (standard WebGL)
        fov: Math.PI / 4,
        aspect: 1,
        near: 0.1,
        far: 100000, // Increased default far plane for large models
      },
      viewMatrix: MathUtils.identity(),
      projMatrix: MathUtils.identity(),
      viewProjMatrix: MathUtils.identity(),
      projectionMode: 'perspective',
      orthoSize: DEFAULT_ORTHO_SIZE, // Half-height in world units
      sceneBounds: null,
      orbitAnchorBounds: null,
    };

    // All pose writers publish the ordinary and relative frames together.
    const updateMatrices = () => this.updateMatrices();
    this.controls = new CameraControls(this.state, updateMatrices);
    this.projection = new CameraProjection(this.state, updateMatrices, this.relativeToEyeFrame);
    this.animator = new CameraAnimator(this.state, updateMatrices, this.controls, this.projection);
    this.firstPerson = new FirstPersonNavigator(this.state, updateMatrices);
    this.orientation = new CameraOrientation(this.state, this.animator, updateMatrices);
    this.updateMatrices();
  }

  /** Publish both camera frames after every setter, gesture and animation. */
  private updateMatrices(): void {
    updateCameraMatrices(this.state);
    updateCameraRelativeFrame(this.state, this.relativeToEyeFrame);
  }

  /**
   * Set camera aspect ratio
   */
  setAspect(aspect: number): void {
    // The other multiplicand of the orthographic half-width, and a direct
    // input to the perspective matrix. It arrives as a raw `width / height`
    // from the canvas, so a zero-height (collapsed or detached) canvas hands
    // this `Infinity` or `NaN`, and either poisons both projection branches
    // exactly like a malformed pose does (#2441). Keep the last usable ratio
    // instead: it is a viewport property, so the previous frame's is a far
    // better answer than any constant.
    if (!Number.isFinite(aspect) || aspect <= 0) return;
    this.state.camera.aspect = aspect;
    this.updateMatrices();
  }

  /**
   * Set camera position
   */
  setPosition(x: number, y: number, z: number): void {
    this.state.camera.position = { x, y, z };
    this.updateMatrices();
  }

  /**
   * Set camera target
   */
  setTarget(x: number, y: number, z: number): void {
    this.state.camera.target = { x, y, z };
    this.updateMatrices();
  }

  /**
   * Set camera up vector
   */
  setUp(x: number, y: number, z: number): void {
    this.state.camera.up = { x, y, z };
    this.updateMatrices();
  }

  /**
   * Set camera field of view in radians
   */
  setFOV(fov: number): void {
    // The clamp below is NaN-transparent, so on its own it would store a NaN
    // fov — and that leaks well past the projection matrix: `getFOV()` feeds
    // saved viewpoints, and `fitBoundsAdaptive` feeds it to `pickFitPolicy`,
    // which would hand back a NaN pose. `applyViewpoint` checks a restored
    // viewpoint's `orthoSize` but not its `fov`, so a malformed file-supplied
    // value reaches here unvalidated (#2441). Keep the current fov instead.
    if (!Number.isFinite(fov)) return;
    this.state.camera.fov = Math.max(0.01, Math.min(Math.PI - 0.01, fov));
    this.updateMatrices();
  }

  /**
   * Set the orbit center without moving the camera.
   * Future orbit() calls will rotate around this point.
   * Pass null to revert to orbiting around camera.target.
   */
  setOrbitCenter(center: Vec3 | null): void {
    this.controls.setOrbitCenter(center);
  }

  /** Restrict interactive orbit/pan/zoom (embed `controls` param, #2934). */
  setInteractionMode(mode: InteractionMode): void {
    this.interactionMode = mode;
    this.controls.setInteractionMode(mode);
  }

  /**
   * Orbit camera around the current pivot (Y-up coordinate system).
   * If orbitCenter is set, both position and target rotate around it.
   * Otherwise, position rotates around target (standard orbit).
   */
  orbit(deltaX: number, deltaY: number, addVelocity = false): void {
    // Gate both side effects on whether `orbit` applied, or a rejected gesture half-applies (#2934 review).
    if (!this.controls.orbit(deltaX, deltaY)) return;
    this.animator.resetPresetTracking();
    if (addVelocity) {
      this.animator.addOrbitVelocity(deltaX, deltaY);
    }
  }

  /**
   * Pan camera (Y-up coordinate system)
   */
  pan(deltaX: number, deltaY: number, addVelocity = false): void {
    // Pan speed depends on distance; compute before pan (pan preserves distance).
    // `getDistance()` reports the pose verbatim, so a malformed one makes this NaN —
    // and the inertia loop *latches* it: it spends velocity only while
    // `Math.abs(velocity) > minVelocity`, false for NaN, so a NaN pan velocity is
    // never applied and never decays, staying dead for the rest of the session even
    // after the pose is corrected (#2441). Skip it rather than seed an invented speed.
    const distance = this.getDistance();
    // Gate inertia on whether `pan` applied, same reason as `orbit` above (#2934 review).
    if (!this.controls.pan(deltaX, deltaY)) return;
    if (addVelocity && isUsableDistance(distance, 0)) {
      this.animator.addPanVelocity(deltaX, deltaY, distance * 0.001);
    }
  }

  /**
   * Zoom camera towards mouse position
   * @param delta - Zoom delta (positive = zoom out, negative = zoom in)
   * @param addVelocity - Whether to add velocity for inertia
   * @param mouseX - Mouse X position in canvas coordinates
   * @param mouseY - Mouse Y position in canvas coordinates
   * @param canvasWidth - Canvas width
   * @param canvasHeight - Canvas height
   * @param fastZoom - Pure dolly (Shift / Cesium): the full step translates the rig
   * @param surfacePoint - World point on the visible surface under the cursor
   *   (#5393). Zooming IN approaches it and stops short of it; it is ignored
   *   for zoom-out, fast zoom and orthographic. The surface step applies no
   *   inertia, so `addVelocity` has no effect on it.
   */
  zoom(delta: number, addVelocity = false, mouseX?: number, mouseY?: number, canvasWidth?: number, canvasHeight?: number, fastZoom?: boolean, surfacePoint?: Vec3): void {
    // Zooming IN over geometry approaches the picked surface instead of the
    // target plane, so repeated notches stop short of it (#5393). Pure dolly
    // (fast zoom, Cesium) and orthographic keep the plain path.
    if (surfacePoint && delta < 0 && !fastZoom && this.zoomTowardSurface(delta, surfacePoint)) return;
    // Gate inertia on whether `zoom` applied, same reason as `orbit` above (#2934 review).
    if (!this.controls.zoom(delta, mouseX, mouseY, canvasWidth, canvasHeight, fastZoom)) return;
    if (addVelocity) {
      const normalizedDelta = Math.sign(delta) * Math.min(Math.abs(delta) * 0.001, 0.1);
      this.animator.addZoomVelocity(normalizedDelta);
    }
  }

  /** One zoom-in notch toward a picked surface point; false = not applied. */
  private zoomTowardSurface(delta: number, point: Vec3): boolean {
    // Same gate as CameraControls.zoom: only 'all' may dolly (#2934).
    if (this.interactionMode !== 'all' || this.state.projectionMode !== 'perspective') return false;
    const fraction = Math.min(Math.abs(delta) * CAMERA_CONSTANTS.ZOOM_SENSITIVITY, CAMERA_CONSTANTS.MAX_ZOOM_DELTA);
    const next = surfaceZoomStep(this.state.camera, point, fraction);
    if (!next) return false;
    // The orbit centre is left where it is on purpose: the mouse path re-seats
    // it on every orbit start, and the new target already sits at the surface.
    // In place, like every other pose writer: callers may hold these objects.
    Object.assign(this.state.camera.position, next.position);
    Object.assign(this.state.camera.target, next.target);
    this.updateMatrices();
    return true;
  }

  /**
   * Fit view to bounding box. Sets camera to southeast isometric view (typical
   * BIM starting view). Y-up coordinate system: Y is vertical
   */
  fitToBounds(min: Vec3, max: Vec3): void {
    this.projection.fitToBounds(min, max);
  }

  /**
   * Update camera animation and inertia
   * Returns true if camera is still animating
   */
  update(deltaTime: number): boolean {
    return this.animator.update(deltaTime);
  }

  /**
   * Frame/center view on a point (keeps current distance and direction)
   * Standard CAD "Frame Selection" behavior
   */
  async framePoint(point: Vec3, duration = 300): Promise<void> {
    return this.animator.framePoint(point, duration);
  }

  /**
   * Frame selection - zoom to fit bounds while keeping current view direction
   * This is what "Frame Selection" should do - zoom to fill screen
   */
  async frameBounds(min: Vec3, max: Vec3, duration = 300): Promise<void> {
    return this.animator.frameBounds(min, max, duration);
  }

  async zoomExtent(min: Vec3, max: Vec3, duration = 300): Promise<void> {
    return this.animator.zoomExtent(min, max, duration);
  }

  /**
   * Apply a `FitPolicy` snapshot to the camera without animation. Used by
   * the post-load auto-fit where any in-flight tween would compete with
   * the streaming-complete frame and produce a visible camera jump.
   */
  snapToFitPolicy(policy: FitPolicy): void {
    this.state.camera.position = { ...policy.position };
    this.state.camera.target = { ...policy.target };
    this.state.camera.up = { ...policy.up };
    this.updateMatrices();
  }

  /**
   * Animate the camera to a `FitPolicy` pose. Used by the Home button so
   * the transition matches the rest of the navigation tweens.
   */
  async applyFitPolicy(policy: FitPolicy, duration = 500): Promise<void> {
    return this.animator.animateToWithUp(
      { ...policy.position },
      { ...policy.target },
      { ...policy.up },
      duration,
    );
  }

  /**
   * Convenience: pick + apply the adaptive fit policy for the given bounds
   * in one call. The default behaviour delegates to `pickFitPolicy()` so
   * callers don't have to thread the FOV through themselves.
   */
  fitBoundsAdaptive(
    bounds: Bounds3,
    options?: { animate?: boolean; duration?: number; viewportShortPx?: number },
  ): FitPolicy {
    // `pickFitPolicy` is pure and would hand back a non-finite pose for an
    // infinite or inverted box, which `snapToFitPolicy` writes verbatim into
    // position, target AND up — the widest single write in the class. This is
    // the auto-fit that runs as geometry streams, so the box comes straight
    // from the model (#2461). Report the pose the camera already has: applying
    // it is a no-op, which is exactly the intended outcome, and callers only
    // read `policy.kind`.
    if (!isUsableBounds(bounds.min, bounds.max)) {
      return {
        kind: 'compact',
        aspect: 1,
        target: { ...this.state.camera.target },
        position: { ...this.state.camera.position },
        up: { ...this.state.camera.up },
        distance: this.getDistance(),
      };
    }

    const fitOpts: PickFitPolicyOptions = {
      fovY: this.state.camera.fov,
      viewportShortPx: options?.viewportShortPx,
    };
    const policy = pickFitPolicy(bounds, fitOpts);
    if (options?.animate) {
      void this.applyFitPolicy(policy, options.duration ?? 500);
    } else {
      this.snapToFitPolicy(policy);
    }
    return policy;
  }

  /**
   * Animate camera to position and target
   */
  async animateTo(endPos: Vec3, endTarget: Vec3, duration = 500): Promise<void> {
    return this.animator.animateTo(endPos, endTarget, duration);
  }

  /**
   * Animate camera to position, target, and up vector (for orthogonal preset views)
   */
  async animateToWithUp(endPos: Vec3, endTarget: Vec3, endUp: Vec3, duration = 500): Promise<void> {
    return this.animator.animateToWithUp(endPos, endTarget, endUp, duration);
  }

  /**
   * Set first-person mode
   */
  enableFirstPersonMode(enabled: boolean): void {
    this.firstPerson.setEnabled(enabled);
  }

  /**
   * Move in first-person mode (Y-up coordinate system)
   */
  moveFirstPerson(forward: number, right: number, up: number): void {
    this.firstPerson.move(forward, right, up);
  }

  /**
   * Set preset view with explicit bounds (Y-up coordinate system)
   * Clicking the same view again rotates 90 degrees around the view axis
   * @param buildingRotation Optional building rotation in radians (from IfcSite placement)
   */
  setPresetView(
    view: 'top' | 'bottom' | 'front' | 'back' | 'left' | 'right',
    bounds?: { min: Vec3; max: Vec3 },
    buildingRotation?: number
  ): void {
    this.animator.setPresetView(view, bounds, buildingRotation);
  }

  /**
   * Reset velocity (stop inertia)
   */
  stopInertia(): void {
    this.animator.stopInertia();
  }

  /**
   * Reset camera state (clear orbit center, stop inertia, cancel animations)
   * Called when loading a new model to ensure clean state
   */
  reset(): void {
    this.controls.setOrbitCenter(null);
    this.animator.reset();
    // The walk velocity is smoothed in place, so it survives a model swap and
    // would be spent on the new model's first walk frame. It used to live on
    // the animator, where `animator.reset()` did not clear it either — the
    // extraction is what made the omission visible.
    this.firstPerson.stop();
    // Drop the previous model's outlier-robust orbit anchor (issue #1394) — it
    // survives setSceneBounds() syncs, so without this a model swap would orbit
    // the new model around the old one's centre until the first fit clears it.
    this.state.orbitAnchorBounds = null;
  }

  getViewProjMatrix(): Mat4 {
    return { m: new Float32Array(this.state.viewProjMatrix.m) };
  }

  /** The reverse-Z projection matrix (perspective or orthographic); a copy. */
  getProjMatrix(): Mat4 {
    return { m: new Float32Array(this.state.projMatrix.m) };
  }

  /**
   * Return the shared RTE frame for the current camera state. GPU consumers
   * must use this instead of deriving a second camera rebase.
   */
  getRelativeToEyeFrame(): RelativeToEyeFrame {
    return this.relativeToEyeFrame;
  }

  getPosition(): Vec3 {
    return { ...this.state.camera.position };
  }

  getTarget(): Vec3 {
    return { ...this.state.camera.target };
  }

  /**
   * Get camera up vector
   */
  getUp(): Vec3 {
    return { ...this.state.camera.up };
  }

  /**
   * Get camera FOV in radians
   */
  getFOV(): number {
    return this.state.camera.fov;
  }

  /**
   * The aspect ratio (width / height) the projection is currently built from.
   *
   * This is the DRAWING BUFFER's ratio. Since #5383 the buffer is the CSS box
   * scaled by one pixel ratio on both axes, so the two agree up to integer
   * rounding of the buffer (the width used to be floored to a multiple of 64,
   * which made them differ by up to 63 pixels).
   *
   * The buffer ratio is the right one for BCF (#3612). A viewpoint's snapshot
   * PNG comes from `canvas.toDataURL()`, which encodes that same drawing
   * buffer, so the `<AspectRatio>` written beside it describes the image
   * actually in the archive. It is also the ratio the projection matrix used,
   * so a viewer restoring the camera reproduces the framing.
   *
   * Always finite and positive -- {@link setAspect} rejects anything else --
   * which is what BCF 3.0's `PositiveDouble` schema type requires.
   */
  getAspect(): number {
    return this.state.camera.aspect;
  }

  /** Raw pose distance; non-finite source poses remain observable. */
  getDistance(): number { return this.orientation.getDistance(); }

  getRotation(): { azimuth: number; elevation: number } { return this.orientation.getRotation(); }

  setRotation(azimuth: number, elevation: number): void { this.orientation.setRotation(azimuth, elevation); }

  /**
   * Unproject screen coordinates to a ray in world space
   * @param screenX - X position in screen coordinates
   * @param screenY - Y position in screen coordinates
   * @param canvasWidth - Canvas width in pixels
   * @param canvasHeight - Canvas height in pixels
   * @returns Ray origin and direction in world space
   */
  unprojectToRay(screenX: number, screenY: number, canvasWidth: number, canvasHeight: number): { origin: Vec3; direction: Vec3 } {
    return this.projection.unprojectToRay(screenX, screenY, canvasWidth, canvasHeight);
  }

  /**
   * Project a world position to screen coordinates
   * @param worldPos - Position in world space
   * @param canvasWidth - Canvas width in pixels
   * @param canvasHeight - Canvas height in pixels
   * @returns Screen coordinates { x, y } or null if behind camera
   */
  projectToScreen(worldPos: Vec3, canvasWidth: number, canvasHeight: number): { x: number; y: number } | null {
    return this.projection.projectToScreen(worldPos, canvasWidth, canvasHeight);
  }

  /**
   * Set projection mode (perspective or orthographic)
   * When switching to orthographic, calculates initial orthoSize from current view.
   */
  setProjectionMode(mode: ProjectionMode): void {
    if (this.state.projectionMode === mode) return;

    if (mode === 'orthographic') {
      // Calculate orthoSize from current perspective view so the model appears
      // the same size. This reads the raw pose, so a non-finite position or
      // target — a malformed viewpoint reaches the public setters unvalidated
      // — makes it NaN, and BCF viewpoints carry the projection mode that gets
      // us here. Go through the same clamp the setter uses, and keep the
      // previous half-height when the pose yields nothing usable (#2441).
      const derived = usableOrthoSize(this.getDistance() * Math.tan(this.state.camera.fov / 2));
      if (derived !== null) this.state.orthoSize = derived;
    }

    this.state.projectionMode = mode;
    this.updateMatrices();
  }

  /**
   * Toggle between perspective and orthographic projection
   */
  toggleProjectionMode(): void {
    this.setProjectionMode(this.state.projectionMode === 'perspective' ? 'orthographic' : 'perspective');
  }

  /**
   * Get current projection mode
   */
  getProjectionMode(): ProjectionMode {
    return this.state.projectionMode;
  }

  /**
   * Get orthographic view half-height
   */
  getOrthoSize(): number {
    return this.state.orthoSize;
  }

  /**
   * Set orthographic view half-height
   */
  setOrthoSize(size: number): void {
    // `Math.max(0.01, NaN)` is `NaN`: the floor does not reject a non-finite
    // size, it forwards it (#2441). A rejected size leaves the current one in
    // place, which is finite, so `getOrthoSize()` cannot hand a NaN back out
    // into a saved viewpoint either.
    const next = usableOrthoSize(size);
    if (next === null) return;
    this.state.orthoSize = next;
    this.updateMatrices();
  }

  /**
   * Set scene bounds for tight orthographic near/far plane computation.
   * Call this when geometry is loaded or changed.
   */
  setSceneBounds(bounds: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } } | null): void {
    this.state.sceneBounds = bounds;
    this.updateMatrices();
  }

  /**
   * The cached scene bounds last set via {@link setSceneBounds} (null if never
   * set). O(1) — does not recompute from geometry, so it is cheap enough to
   * read on the orbit hot path (e.g. anchoring the orbit pivot to the scene
   * centre on large models). Returns the live reference; callers must not mutate.
   */
  getSceneBounds(): { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } } | null {
    return this.state.sceneBounds;
  }

  /**
   * Set the outlier-robust orbit-pivot anchor bounds (issue #1394), or `null`
   * to clear it (the pivot then falls back to {@link getSceneBounds}). The
   * renderer never touches this, so it survives the per-upload `setSceneBounds`
   * syncs that keep `sceneBounds` pinned to the full model AABB.
   */
  setOrbitAnchorBounds(bounds: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } } | null): void {
    this.state.orbitAnchorBounds = bounds;
  }

  /**
   * The robust orbit-pivot anchor bounds last set via {@link setOrbitAnchorBounds}
   * (null if never set / cleared). O(1); safe on the orbit hot path. Returns the
   * live reference; callers must not mutate.
   */
  getOrbitAnchorBounds(): { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } } | null {
    return this.state.orbitAnchorBounds;
  }
}
