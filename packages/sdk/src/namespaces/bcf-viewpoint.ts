/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Shape adapter between the SDK's public `ViewpointOptions`/
 * `ExtractedViewpointState` (tuple camera, x/y/z section-plane axis — the
 * shapes `bim.viewer.getCamera()`/`getSection()`/`setCamera()`/`setSection()`
 * use) and `@ifc-lite/bcf`'s `ViewerCameraState`/`ViewerSectionPlane`
 * (object camera, down/front/side axis).
 *
 * `BCFNamespace.createViewpoint()`/`extractViewpointState()` in bcf.ts used
 * to forward the SDK shape to `@ifc-lite/bcf` unchanged: the library read
 * `camera.position.x` off a 3-tuple (always undefined) and an 'x'|'y'|'z'
 * axis never matched its 'down'|'front'|'side' switch, so a documented
 * `createViewpoint({ camera: bim.viewer.getCamera(), sectionPlane:
 * bim.viewer.getSection() })` call silently produced a corrupted camera and
 * dropped the section cut with no error (#4251). Split out of bcf.ts to
 * keep that file under the house 400-line module-size budget.
 */

import type { AABB } from '../types.js';

// ============================================================================
// Option types for the namespace API
// ============================================================================

export interface ViewpointOptions {
  /**
   * Camera state from bim.viewer.getCamera(). `position`/`target`/`up` are
   * REQUIRED if `camera` is passed at all — `createViewpoint()` throws
   * `IncompleteCameraStateError` rather than building a viewpoint with
   * missing coordinates (#4251). `bim.viewer.getCamera()` returns only
   * `{ mode }` when no viewport is mounted (headless, or before first
   * paint); callers in that situation must supply position/target/up
   * themselves or omit `camera`.
   *
   * The SDK's `CameraState` carries no field-of-view (the renderer's real
   * FOV isn't part of its public surface), so the viewpoint's FOV is always
   * written as a fixed default (`Math.PI / 4`), matching the placeholder
   * `@ifc-lite/bcf` itself uses for orthographic cameras.
   */
  camera?: {
    mode: 'perspective' | 'orthographic';
    position?: [number, number, number];
    target?: [number, number, number];
    up?: [number, number, number];
  };
  /** Section plane from bim.viewer.getSection(). Requires `bounds` (below)
   * when `enabled` is true — see `bounds`. */
  sectionPlane?: {
    axis: 'x' | 'y' | 'z';
    position: number;
    enabled: boolean;
    flipped: boolean;
  };
  /**
   * The model's overall axis-aligned bounding box, REQUIRED when
   * `sectionPlane.enabled` is true — `@ifc-lite/bcf` needs it to convert a
   * percentage-along-axis section plane into an absolute clipping-plane
   * location, and nothing in the SDK's public surface (`bim.viewer.*`,
   * `bim.spatial.*`) can compute a model's bounds (`bim.spatial.queryBounds`
   * does the reverse: it queries entities inside an already-known box).
   * Omitting `bounds` while `sectionPlane.enabled` is true throws
   * `MissingSectionBoundsError` instead of silently dropping the clipping
   * plane (#4251).
   */
  bounds?: AABB;
  /** Component selection/visibility */
  components?: {
    selection?: Array<{ GlobalId: string }>;
    visibility?: {
      /**
       * BCF's `<Visibility DefaultVisibility>` attribute, which is OPTIONAL
       * in the schema and defaults to **true**. Omitting it therefore means
       * "everything is visible, and `exceptions` names what is HIDDEN" -- it
       * is NOT a shorthand for isolation. A truthiness test on this field was
       * wrong in both directions: it read an absent flag as isolation,
       * inverting the spec, and with no exceptions to isolate it turned a
       * caller who said nothing about visibility into a blank viewport.
       *
       * Pass `false` explicitly to isolate, in which case `exceptions` is the
       * visible allowlist and an empty or absent list means an active
       * isolation matching nothing (a blank viewport), not "no visibility
       * channel" -- which is why the adapter forwards `exceptions ?? []` on
       * that arm rather than `exceptions?.map(...)`: `@ifc-lite/bcf`'s
       * `hasVisible` reads an `undefined` allowlist as "no isolation at all".
       */
      defaultVisibility?: boolean;
      exceptions?: Array<{ GlobalId: string }>;
    };
    coloring?: Array<{
      color: string;
      components: Array<{ GlobalId: string }>;
    }>;
  };
}

/**
 * State extracted from a BCF viewpoint, shaped to round-trip straight back
 * into `bim.viewer.setCamera()` / `bim.viewer.setSection()` — the same
 * tuple camera + x/y/z section-plane axis vocabulary `ViewpointOptions`
 * documents as input from `getCamera()`/`getSection()`.
 */
export interface ExtractedViewpointState {
  camera?: {
    mode: 'perspective' | 'orthographic';
    position: [number, number, number];
    target: [number, number, number];
    up: [number, number, number];
  };
  sectionPlane?: {
    axis: 'x' | 'y' | 'z';
    position: number;
    enabled: boolean;
    flipped: boolean;
  };
  selectedGuids: string[];
  hiddenGuids: string[];
  // `null` = no isolation channel in the captured viewpoint (show
  // everything); a non-null array -- EMPTY included -- = isolation WAS
  // active, down to "matched nothing". See `@ifc-lite/bcf`'s
  // `extractViewpointState` for the full rationale.
  visibleGuids: string[] | null;
  coloredGuids: Array<{ color: string; guids: string[] }>;
}

// ============================================================================
// Errors — reject, do not silently coerce (#4251)
// ============================================================================

/**
 * Thrown by createViewpoint() when `options.camera` is missing (or missing
 * position/target/up). Forwarding an incomplete camera used to build a
 * viewpoint whose coordinates silently read back as `null`
 * (`JSON.stringify` drops `undefined`; `-undefined` is `NaN`, which
 * serializes as `null`) — see #4251.
 */
export class IncompleteCameraStateError extends Error {
  constructor(missing: string[]) {
    super(
      `bim.bcf.createViewpoint(): camera is missing ${missing.join(', ')}. ` +
        `Pass position/target/up as [number, number, number] tuples, or omit ` +
        `camera entirely — bim.viewer.getCamera() returns only { mode } when ` +
        `no viewport is mounted.`
    );
    this.name = 'IncompleteCameraStateError';
  }
}

/**
 * Thrown by createViewpoint() when `options.sectionPlane.enabled` is true
 * but `options.bounds` was not supplied. @ifc-lite/bcf's
 * `sectionPlaneToClippingPlane` needs both an `enabled` section plane and a
 * `bounds` argument to build a clipping plane; without `bounds` the SDK
 * used to forward `sectionPlane` alone and the library silently produced no
 * `clippingPlanes` at all — see #4251.
 */
export class MissingSectionBoundsError extends Error {
  constructor() {
    super(
      `bim.bcf.createViewpoint(): options.sectionPlane.enabled is true but ` +
        `options.bounds was not provided. Pass the model's overall AABB as ` +
        `{ min: [x, y, z], max: [x, y, z] }.`
    );
    this.name = 'MissingSectionBoundsError';
  }
}

// ============================================================================
// Conversion helpers
// ============================================================================

/** FOV (radians) written into every viewpoint camera — the SDK's public
 * CameraState carries no FOV field, so there is no real value to forward.
 * Matches @ifc-lite/bcf's own orthographic placeholder default. */
export const DEFAULT_VIEWPOINT_FOV = Math.PI / 4;

export function toVec3(t: [number, number, number]): { x: number; y: number; z: number } {
  return { x: t[0], y: t[1], z: t[2] };
}

export function toTuple(p: { x: number; y: number; z: number }): [number, number, number] {
  return [p.x, p.y, p.z];
}

/** @ifc-lite/bcf's object-shaped `ViewerBounds`. */
export type BcfViewerBounds = { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } };

/** Accept either the SDK's tuple `AABB` or @ifc-lite/bcf's own object-shaped
 * `ViewerBounds` and return the library shape. The tuple form otherwise
 * reaches the library's `bounds.min.x` reads as `undefined` -> `NaN`. */
export function toLibraryBounds(bounds: AABB | BcfViewerBounds): BcfViewerBounds {
  return {
    min: Array.isArray(bounds.min) ? toVec3(bounds.min) : bounds.min,
    max: Array.isArray(bounds.max) ? toVec3(bounds.max) : bounds.max,
  };
}

/** Names the fields missing from a `ViewpointOptions.camera` (or the whole
 * `camera` object) so `IncompleteCameraStateError` can say exactly what a
 * caller needs to add. Empty array means the camera is complete. */
export function collectMissingCameraFields(camera: ViewpointOptions['camera']): string[] {
  if (!camera) return ['camera'];
  const missing: string[] = [];
  if (!camera.position) missing.push('camera.position');
  if (!camera.target) missing.push('camera.target');
  if (!camera.up) missing.push('camera.up');
  return missing;
}

/**
 * SDK axis ('x'|'y'|'z', as returned by bim.viewer.getSection()) <->
 * @ifc-lite/bcf / viewer-store axis ('down'|'front'|'side'). Identical to
 * apps/viewer/src/sdk/adapters/viewer-adapter.ts's AXIS_TO_STORE /
 * STORE_TO_AXIS, which already performs this exact remap on the way in/out
 * of bim.viewer.getSection()/setSection() — reused here rather than
 * inventing a third convention.
 */
export const SDK_AXIS_TO_BCF_AXIS: Record<'x' | 'y' | 'z', 'down' | 'front' | 'side'> = {
  x: 'side',
  y: 'down',
  z: 'front',
};
export const BCF_AXIS_TO_SDK_AXIS: Record<'down' | 'front' | 'side', 'x' | 'y' | 'z'> = {
  side: 'x',
  down: 'y',
  front: 'z',
};

export interface BcfViewerCameraState {
  position: { x: number; y: number; z: number };
  target: { x: number; y: number; z: number };
  up: { x: number; y: number; z: number };
  fov: number;
  isOrthographic?: boolean;
}

export interface BcfViewerSectionPlane {
  axis: 'down' | 'front' | 'side';
  position: number;
  enabled: boolean;
  flipped: boolean;
}
