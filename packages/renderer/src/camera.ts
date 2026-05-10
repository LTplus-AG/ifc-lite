/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Camera and orbit controls
 *
 * Uses composition pattern: delegates to CameraControls (orbit/pan/zoom),
 * CameraAnimator (transitions/inertia/presets), and CameraProjection
 * (screen-world conversion/bounds fitting).
 */

import type { Vec3, Mat4 } from './types.js';
import { MathUtils } from './math.js';
import { CameraControls, type CameraInternalState, type ProjectionMode } from './camera-controls.js';
import { CameraAnimator } from './camera-animation.js';
import { CameraProjection } from './camera-projection.js';

export class Camera {
  private state: CameraInternalState;
  private controls: CameraControls;
  private animator: CameraAnimator;
  private projection: CameraProjection;

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
      orthoSize: 50, // Default half-height in world units
      sceneBounds: null,
    };

    const updateMatrices = () => this.updateMatrices();
    this.controls = new CameraControls(this.state, updateMatrices);
    this.projection = new CameraProjection(this.state, updateMatrices);
    this.animator = new CameraAnimator(this.state, updateMatrices, this.controls, this.projection);
    this.updateMatrices();
  }

  /**
   * Set camera aspect ratio
   */
  setAspect(aspect: number): void {
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

  /**
   * Orbit camera around the current pivot (Y-up coordinate system).
   * If orbitCenter is set, both position and target rotate around it.
   * Otherwise, position rotates around target (standard orbit).
   */
  orbit(deltaX: number, deltaY: number, addVelocity = false): void {
    this.animator.resetPresetTracking();
    this.controls.orbit(deltaX, deltaY);
    if (addVelocity) {
      this.animator.addOrbitVelocity(deltaX, deltaY);
    }
  }

  /**
   * Pan camera (Y-up coordinate system)
   */
  pan(deltaX: number, deltaY: number, addVelocity = false): void {
    // Pan speed depends on distance; compute before pan (pan preserves distance)
    const panSpeed = this.getDistance() * 0.001;
    this.controls.pan(deltaX, deltaY);
    if (addVelocity) {
      this.animator.addPanVelocity(deltaX, deltaY, panSpeed);
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
   */
  zoom(delta: number, addVelocity = false, mouseX?: number, mouseY?: number, canvasWidth?: number, canvasHeight?: number, fastZoom?: boolean): void {
    this.controls.zoom(delta, mouseX, mouseY, canvasWidth, canvasHeight, fastZoom);
    if (addVelocity) {
      const normalizedDelta = Math.sign(delta) * Math.min(Math.abs(delta) * 0.001, 0.1);
      this.animator.addZoomVelocity(normalizedDelta);
    }
  }

  /**
   * Fit view to bounding box
   * Sets camera to southeast isometric view (typical BIM starting view)
   * Y-up coordinate system: Y is vertical
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
   * Animate camera to fit bounds (southeast isometric view)
   * Y-up coordinate system
   */
  async zoomToFit(min: Vec3, max: Vec3, duration = 500): Promise<void> {
    return this.animator.zoomToFit(min, max, duration);
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
    this.animator.enableFirstPersonMode(enabled);
  }

  /**
   * Move in first-person mode (Y-up coordinate system)
   */
  moveFirstPerson(forward: number, right: number, up: number): void {
    this.animator.moveFirstPerson(forward, right, up);
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
  }

  getViewProjMatrix(): Mat4 {
    return this.state.viewProjMatrix;
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
   * Get distance from camera position to target
   */
  getDistance(): number {
    const dir = {
      x: this.state.camera.position.x - this.state.camera.target.x,
      y: this.state.camera.position.y - this.state.camera.target.y,
      z: this.state.camera.position.z - this.state.camera.target.z,
    };
    return Math.sqrt(dir.x * dir.x + dir.y * dir.y + dir.z * dir.z);
  }

  /**
   * Get current camera rotation angles in degrees
   * Returns { azimuth, elevation } where:
   * - azimuth: horizontal rotation (0-360), 0 = front
   * - elevation: vertical rotation (-90 to 90), 0 = horizon
   */
  getRotation(): { azimuth: number; elevation: number } {
    const dir = {
      x: this.state.camera.position.x - this.state.camera.target.x,
      y: this.state.camera.position.y - this.state.camera.target.y,
      z: this.state.camera.position.z - this.state.camera.target.z,
    };
    const distance = Math.sqrt(dir.x * dir.x + dir.y * dir.y + dir.z * dir.z);
    if (distance < 1e-6) return { azimuth: 0, elevation: 0 };

    // Elevation: angle from horizontal plane
    const elevation = Math.asin(Math.max(-1, Math.min(1, dir.y / distance))) * 180 / Math.PI;

    // Calculate azimuth smoothly using up vector
    // The up vector defines the "screen up" direction, which determines rotation
    const upX = this.state.camera.up.x;
    const upY = this.state.camera.up.y;
    const upZ = this.state.camera.up.z;

    // Project up vector onto horizontal plane (XZ plane)
    const upLen = Math.sqrt(upX * upX + upZ * upZ);

    let azimuth: number;
    if (upLen > 0.01) {
      // Use up vector projection for azimuth (smooth and consistent)
      azimuth = (Math.atan2(-upX, -upZ) * 180 / Math.PI + 360) % 360;

      // For bottom view, flip azimuth
      if (elevation < -80 && upY < 0) {
        azimuth = (azimuth + 180) % 360;
      }
    } else {
      // Fallback: use position-based azimuth when up vector is vertical
      azimuth = (Math.atan2(dir.x, dir.z) * 180 / Math.PI + 360) % 360;
    }

    return { azimuth, elevation };
  }

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
      // Calculate orthoSize from current perspective view so the model appears the same size
      const distance = this.getDistance();
      this.state.orthoSize = distance * Math.tan(this.state.camera.fov / 2);
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
    this.state.orthoSize = Math.max(0.01, size);
    this.updateMatrices();
  }

  /**
   * Set scene bounds for tight orthographic near/far plane computation.
   * Call this when geometry is loaded or changed.
   */
  setSceneBounds(bounds: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } } | null): void {
    if (bounds === null && this.state.sceneBounds !== null) {
      console.warn('[camera] setSceneBounds(null) — bounds being cleared. Stack:', new Error().stack);
    }
    this.state.sceneBounds = bounds;
    this.updateMatrices();
  }

  private updateMatrices(): void {
    const dx = this.state.camera.position.x - this.state.camera.target.x;
    const dy = this.state.camera.position.y - this.state.camera.target.y;
    const dz = this.state.camera.position.z - this.state.camera.target.z;
    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);

    this.state.viewMatrix = MathUtils.lookAt(
      this.state.camera.position,
      this.state.camera.target,
      this.state.camera.up
    );

    if (this.state.projectionMode === 'orthographic') {
      // Orthographic: project scene bounding sphere onto view direction for tight near/far.
      // Tight range maximizes depth precision (less z-fighting) and prevents clipping.
      const nf = this.computeOrthoNearFar(distance);
      this.state.camera.near = nf.near;
      this.state.camera.far = nf.far;
      const h = this.state.orthoSize;
      const w = h * this.state.camera.aspect;
      this.state.projMatrix = MathUtils.orthographicReverseZ(
        -w, w, -h, h,
        this.state.camera.near,
        this.state.camera.far
      );
    } else {
      // Perspective: derive near/far from the actual scene-bounds distance
      // when known. The legacy `distance * (0.001..10)` heuristic produces a
      // far/near ratio ≈ 10000 which collapses depth precision to zero for
      // large or far-from-origin scenes (georeferenced IFCs at survey
      // coordinates), making every fragment fail the reverse-Z test.
      // Bounds-based near/far stays tight regardless of camera distance.
      let near = Math.max(0.01, distance * 0.001);
      let far = Math.max(distance * 10, 1000);
      const b = this.state.sceneBounds;
      let usedBoundsPath = false;
      let minD = -1;
      let maxD = -1;
      if (b) {
        const cx = this.state.camera.position.x;
        const cy = this.state.camera.position.y;
        const cz = this.state.camera.position.z;
        minD = Infinity;
        maxD = 0;
        for (let i = 0; i < 8; i++) {
          const x = (i & 1) ? b.max.x : b.min.x;
          const y = (i & 2) ? b.max.y : b.min.y;
          const z = (i & 4) ? b.max.z : b.min.z;
          const dx = x - cx;
          const dy = y - cy;
          const dz = z - cz;
          const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
          if (d < minD) minD = d;
          if (d > maxD) maxD = d;
        }
        // Bounds-based near aims for tight depth precision on huge models.
        // BUT: when the camera dollies inside the bounds (or close to a
        // surface), `minD * 0.9` gets larger than the camera-to-surface
        // distance and clips geometry. Cap near at a small fixed value
        // (1 cm) so close-up navigation never clips. We still use the
        // bounds for `far` so depth precision stays usable on big models.
        const NEAR_CAP = 0.01;
        near = Math.max(NEAR_CAP, Math.min(minD * 0.9, distance * 0.05));
        far = Math.max(near * 2, maxD * 1.1);
        usedBoundsPath = true;
      }
      this.state.camera.near = near;
      this.state.camera.far = far;
      // Log every 60 calls so we don't spam, but enough to see what's happening.
      if (((this as unknown as { _matCallCount?: number })._matCallCount = ((this as unknown as { _matCallCount?: number })._matCallCount ?? 0) + 1) % 30 === 1) {
        console.log(
          `[camera] perspective near=${near.toFixed(3)} far=${far.toFixed(0)} ` +
          `(distance=${distance.toFixed(0)}, sceneBounds=${b ? 'set' : 'null'}, usedBoundsPath=${usedBoundsPath}, ` +
          `minD=${minD.toFixed(0)}, maxD=${maxD.toFixed(0)})`,
        );
      }
      this.state.projMatrix = MathUtils.perspectiveReverseZ(
        this.state.camera.fov,
        this.state.camera.aspect,
        this.state.camera.near,
        this.state.camera.far
      );
    }

    this.state.viewProjMatrix = MathUtils.multiply(this.state.projMatrix, this.state.viewMatrix);
  }

  /**
   * Compute tight near/far for orthographic mode by projecting the scene
   * bounding sphere onto the camera view direction.
   *
   * This gives optimal depth precision (minimizing z-fighting) while ensuring
   * no geometry is clipped regardless of camera position or view angle.
   */
  private computeOrthoNearFar(distance: number): { near: number; far: number } {
    const bounds = this.state.sceneBounds;
    if (!bounds) {
      // Fallback: generous range centered on camera
      return { near: -Math.max(distance, 500), far: Math.max(distance, 500) };
    }

    // Scene bounding sphere center and radius
    const cx = (bounds.min.x + bounds.max.x) / 2;
    const cy = (bounds.min.y + bounds.max.y) / 2;
    const cz = (bounds.min.z + bounds.max.z) / 2;
    const ex = bounds.max.x - bounds.min.x;
    const ey = bounds.max.y - bounds.min.y;
    const ez = bounds.max.z - bounds.min.z;
    const radius = Math.sqrt(ex * ex + ey * ey + ez * ez) / 2;

    // View direction (camera looks from position toward target)
    const pos = this.state.camera.position;
    let vx = this.state.camera.target.x - pos.x;
    let vy = this.state.camera.target.y - pos.y;
    let vz = this.state.camera.target.z - pos.z;
    const vLen = Math.sqrt(vx * vx + vy * vy + vz * vz);
    if (vLen > 1e-8) { vx /= vLen; vy /= vLen; vz /= vLen; }

    // Signed distance from camera to scene center along view direction
    const toCenter = (cx - pos.x) * vx + (cy - pos.y) * vy + (cz - pos.z) * vz;

    // Near/far as distances from camera along view direction.
    // The sphere spans [toCenter - radius, toCenter + radius] along view dir.
    // Add 10% padding for safety.
    const pad = radius * 0.1 + 1;
    let near = toCenter - radius - pad;
    let far = toCenter + radius + pad;

    // Ensure minimum range for depth precision
    if (far - near < 1) { near -= 0.5; far += 0.5; }

    return { near, far };
  }
}
