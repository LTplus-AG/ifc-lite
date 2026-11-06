/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { MutableRefObject } from 'react';
import { useViewerStore } from '@/store';
import type { SectionPlane } from '@/store/types.js';
import { projectToCssScreen } from '../../utils/projectScreen.js';

/**
 * The camera state the measurement reprojection pass last ran for. The
 * animation loop, wheel zoom and a Point-mode hover (#8828) all compare
 * against it, so they agree on when the view counts as changed.
 */

export interface MeasureCameraState {
  position: { x: number; y: number; z: number };
  rotation: { azimuth: number; elevation: number };
  distance: number;
  /** A projection toggle or an orthographic zoom moves nothing above, yet re-frames the view. */
  projectionMode: string;
  orthoSize: number;
  /** A viewpoint restore can change only these. */
  fov: number;
  up: { x: number; y: number; z: number };
  /** The drawing buffer, which the camera's aspect follows. */
  canvasWidth: number;
  canvasHeight: number;
  /**
   * What a pick at the cursor filters by (#8886), compared by identity: the
   * effective hidden and isolated sets the pick reads (model visibility and
   * storey context fold into them) and the section state the render clips by.
   */
  scene: {
    hidden: ReadonlySet<number>;
    isolated: ReadonlySet<number> | null;
    sectionVisible: boolean;
    sectionPlane: SectionPlane;
    inactiveSectionPlanes: readonly SectionPlane[];
  };
}

/** The refs Viewport hands both the animation loop and the pointer handlers. */
interface MeasurePassRefs {
  lastCameraStateRef: MutableRefObject<MeasureCameraState | null>;
  hiddenEntitiesRef: MutableRefObject<ReadonlySet<number>>;
  isolatedEntitiesRef: MutableRefObject<ReadonlySet<number> | null>;
}

interface CameraPose {
  projectToScreen(p: { x: number; y: number; z: number }, w: number, h: number): { x: number; y: number } | null;
  getPosition(): { x: number; y: number; z: number };
  getRotation(): { azimuth: number; elevation: number };
  getDistance(): number;
  getProjectionMode(): string;
  getOrthoSize(): number;
  getFOV(): number;
  getUp(): { x: number; y: number; z: number };
}

export function measureCameraState(
  camera: CameraPose, canvas: { width: number; height: number }, refs: Omit<MeasurePassRefs, 'lastCameraStateRef'>,
): MeasureCameraState {
  const s = useViewerStore.getState();
  return {
    position: camera.getPosition(),
    rotation: camera.getRotation(),
    distance: camera.getDistance(),
    projectionMode: camera.getProjectionMode(),
    orthoSize: camera.getOrthoSize(),
    fov: camera.getFOV(),
    up: camera.getUp(),
    canvasWidth: canvas.width,
    canvasHeight: canvas.height,
    scene: {
      hidden: refs.hiddenEntitiesRef.current,
      isolated: refs.isolatedEntitiesRef.current,
      sectionVisible: s.sceneState.section.visible,
      sectionPlane: s.sectionPlane,
      inactiveSectionPlanes: s.inactiveSectionPlanes,
    },
  };
}

/**
 * Nothing changed what a pick at a resting cursor returns: the camera did not
 * move (#8828) and nothing was hidden, isolated or cut (#8886). A
 * drawing-buffer resize alone is no such change: the buffer drops to pixel
 * ratio 1 while the view interacts and grows back once it settles, and still
 * needs the markers reprojected (the camera's aspect follows it), but moves
 * nothing under a resting cursor.
 */
export function sameMeasureCameraPose(a: MeasureCameraState | null, b: MeasureCameraState): boolean {
  return a !== null && sameAspect(a, b) &&
    a.scene.hidden === b.scene.hidden &&
    a.scene.isolated === b.scene.isolated &&
    a.scene.sectionVisible === b.scene.sectionVisible &&
    a.scene.sectionPlane === b.scene.sectionPlane &&
    a.scene.inactiveSectionPlanes === b.scene.inactiveSectionPlanes &&
    a.position.x === b.position.x &&
    a.position.y === b.position.y &&
    a.position.z === b.position.z &&
    a.rotation.azimuth === b.rotation.azimuth &&
    a.rotation.elevation === b.rotation.elevation &&
    a.distance === b.distance &&
    a.projectionMode === b.projectionMode &&
    a.orthoSize === b.orthoSize &&
    a.fov === b.fov &&
    a.up.x === b.up.x &&
    a.up.y === b.up.y &&
    a.up.z === b.up.z;
}

/**
 * A canvas whose box changed shape (a panel opened, the window resized) shows
 * something else under the cursor. The pixel-ratio swap keeps the shape up to
 * a pixel of rounding, so a ratio tolerance tells the two apart.
 */
function sameAspect(a: MeasureCameraState, b: MeasureCameraState): boolean {
  // A collapsed side has no shape to compare (0/0 is NaN): compare exactly.
  if (!a.canvasWidth || !b.canvasWidth || !a.canvasHeight || !b.canvasHeight) {
    return a.canvasWidth === b.canvasWidth && a.canvasHeight === b.canvasHeight;
  }
  return Math.abs(a.canvasWidth / a.canvasHeight / (b.canvasWidth / b.canvasHeight) - 1) < ASPECT_TOLERANCE;
}
const ASPECT_TOLERANCE = 0.01;

/** Nothing the reprojection pass depends on changed. */
export function sameMeasureCameraState(a: MeasureCameraState | null, b: MeasureCameraState): boolean {
  return sameMeasureCameraPose(a, b) && a !== null &&
    a.canvasWidth === b.canvasWidth &&
    a.canvasHeight === b.canvasHeight;
}

/**
 * The canvas's ResizeObserver callback reports its CSS box, so a resize is
 * seen without a per-frame layout read. A size change that keeps the aspect
 * (browser zoom, a proportional window resize) still moves what is under a
 * resting cursor, yet the drawing-buffer comparison above cannot tell it from
 * a pixel-ratio swap: forget the last pass, so the next one counts the view
 * as moved and ends Point mode's Live (#8886). A pixel-ratio-only change (the
 * window moved to another display) keeps the CSS box and the reading.
 */
export function measureCanvasBoxWatch(lastStateRef: MutableRefObject<MeasureCameraState | null>) {
  let box: { width: number; height: number } | null = null;
  return (entries: ReadonlyArray<{ contentRect: { width: number; height: number } }>): void => {
    const rect = entries[entries.length - 1]?.contentRect;
    if (!rect) return;
    if (box && (box.width !== rect.width || box.height !== rect.height)) lastStateRef.current = null;
    box = { width: rect.width, height: rect.height };
  };
}

/**
 * The measurement reprojection pass, run by the animation loop every frame and
 * by wheel zoom and a Point-mode hover on demand: reproject every stored point
 * when the view changed since the last pass, telling the store whether what
 * is under the cursor changed, which ends Point mode's Live reading (#8828).
 */
export function reprojectMeasurementsForCamera(
  camera: CameraPose,
  canvas: HTMLCanvasElement,
  refs: MeasurePassRefs,
  update: (project: (worldPos: { x: number; y: number; z: number }) => { x: number; y: number } | null, viewMoved: boolean) => void,
): void {
  const lastStateRef = refs.lastCameraStateRef;
  const last = lastStateRef.current;
  const current = measureCameraState(camera, canvas, refs);
  if (sameMeasureCameraState(last, current)) return;
  lastStateRef.current = current;
  // CSS-space coords so the measure line/labels track the geometry under the
  // cursor (raw coords are drawing-buffer device px, not CSS px — #1107, #5383).
  update((worldPos) => projectToCssScreen(camera, canvas, worldPos), !sameMeasureCameraPose(last, current));
}
