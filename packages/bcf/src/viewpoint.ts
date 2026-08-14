/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Viewpoint conversion utilities
 *
 * Converts between viewer camera state and BCF viewpoint format.
 * Handles coordinate system transformations and camera parameter mapping.
 */

import type {
  BCFViewpoint,
  BCFPerspectiveCamera,
  BCFOrthogonalCamera,
  BCFClippingPlane,
  BCFPoint,
  BCFDirection,
} from './types.js';
import { generateUuid } from '@ifc-lite/encoding';
import { usableTargetDistance } from './numeric.js';

// ============================================================================
// Camera State Types (matching ifc-lite viewer)
// ============================================================================

export interface ViewerCameraState {
  /** Camera position in world coordinates */
  position: { x: number; y: number; z: number };
  /** Camera look-at target in world coordinates */
  target: { x: number; y: number; z: number };
  /** Camera up vector */
  up: { x: number; y: number; z: number };
  /** Field of view in radians */
  fov: number;
  /** Is orthographic projection */
  isOrthographic?: boolean;
  /** Orthographic scale (view-to-world) */
  orthoScale?: number;
}

export interface ViewerSectionPlane {
  /** Axis: 'down' (Y), 'front' (Z), 'side' (X) */
  axis: 'down' | 'front' | 'side';
  /** Position as percentage (0-100) of model bounds */
  position: number;
  /** Is the section plane enabled */
  enabled: boolean;
  /** Is the plane flipped */
  flipped: boolean;
}

export interface ViewerBounds {
  min: { x: number; y: number; z: number };
  max: { x: number; y: number; z: number };
}

// ============================================================================
// Coordinate System Conversion
// ============================================================================

/**
 * ifc-lite viewer uses Y-up coordinate system (typical WebGL):
 *   +X = right
 *   +Y = up
 *   +Z = towards viewer (out of screen)
 *
 * BCF/IFC uses Z-up coordinate system:
 *   +X = right
 *   +Y = forward (into screen)
 *   +Z = up
 *
 * Conversion:
 *   BCF.x = Viewer.x
 *   BCF.y = -Viewer.z  (viewer Z towards viewer = negative BCF Y forward)
 *   BCF.z = Viewer.y   (viewer Y up = BCF Z up)
 */

type Point3D = { x: number; y: number; z: number };

/**
 * Convert from viewer coordinates (Y-up) to BCF coordinates (Z-up)
 */
function viewerToBcfCoords(p: Point3D): Point3D {
  return {
    x: p.x,
    y: -p.z,
    z: p.y,
  };
}

/**
 * Convert from BCF coordinates (Z-up) to viewer coordinates (Y-up)
 */
function bcfToViewerCoords(p: Point3D): Point3D {
  return {
    x: p.x,
    y: p.z,
    z: -p.y,
  };
}

// ============================================================================
// Camera Conversion
// ============================================================================

/**
 * Convert viewer camera state to BCF perspective camera
 *
 * BCF uses direction vector instead of look-at point.
 * Direction = normalize(target - position)
 *
 * Also converts from viewer's Y-up to BCF's Z-up coordinate system.
 */
export function cameraToPerspective(camera: ViewerCameraState): BCFPerspectiveCamera {
  // Convert position and target to BCF coordinates (Z-up)
  const bcfPosition = viewerToBcfCoords(camera.position);
  const bcfTarget = viewerToBcfCoords(camera.target);
  const bcfUp = viewerToBcfCoords(camera.up);

  // Calculate direction vector in BCF coordinates
  const dx = bcfTarget.x - bcfPosition.x;
  const dy = bcfTarget.y - bcfPosition.y;
  const dz = bcfTarget.z - bcfPosition.z;

  const length = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const direction: BCFDirection =
    length > 0.0001
      ? { x: dx / length, y: dy / length, z: dz / length }
      : { x: 0, y: 1, z: 0 }; // Default forward in BCF (positive Y)

  // Normalize up vector
  const upLength = Math.sqrt(bcfUp.x * bcfUp.x + bcfUp.y * bcfUp.y + bcfUp.z * bcfUp.z);
  const upVector: BCFDirection =
    upLength > 0.0001
      ? { x: bcfUp.x / upLength, y: bcfUp.y / upLength, z: bcfUp.z / upLength }
      : { x: 0, y: 0, z: 1 }; // Default up in BCF (positive Z)

  // Convert FOV from radians to degrees
  const fieldOfView = (camera.fov * 180) / Math.PI;

  return {
    cameraViewPoint: bcfPosition,
    cameraDirection: direction,
    cameraUpVector: upVector,
    fieldOfView: Math.max(1, Math.min(179, fieldOfView)), // Clamp to valid range
  };
}

/**
 * Convert viewer camera state to BCF orthogonal camera
 *
 * Also converts from viewer's Y-up to BCF's Z-up coordinate system.
 */
export function cameraToOrthogonal(
  camera: ViewerCameraState,
  viewToWorldScale: number
): BCFOrthogonalCamera {
  // Convert position and target to BCF coordinates (Z-up)
  const bcfPosition = viewerToBcfCoords(camera.position);
  const bcfTarget = viewerToBcfCoords(camera.target);
  const bcfUp = viewerToBcfCoords(camera.up);

  // Calculate direction vector in BCF coordinates
  const dx = bcfTarget.x - bcfPosition.x;
  const dy = bcfTarget.y - bcfPosition.y;
  const dz = bcfTarget.z - bcfPosition.z;

  const length = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const direction: BCFDirection =
    length > 0.0001
      ? { x: dx / length, y: dy / length, z: dz / length }
      : { x: 0, y: 1, z: 0 }; // Default forward in BCF

  // Normalize up vector
  const upLength = Math.sqrt(bcfUp.x * bcfUp.x + bcfUp.y * bcfUp.y + bcfUp.z * bcfUp.z);
  const upVector: BCFDirection =
    upLength > 0.0001
      ? { x: bcfUp.x / upLength, y: bcfUp.y / upLength, z: bcfUp.z / upLength }
      : { x: 0, y: 0, z: 1 }; // Default up in BCF

  return {
    cameraViewPoint: bcfPosition,
    cameraDirection: direction,
    cameraUpVector: upVector,
    viewToWorldScale,
  };
}

/**
 * Convert BCF perspective camera to viewer camera state
 *
 * BCF stores direction, but viewers need a look-at point.
 * We compute target = position + direction * distance
 *
 * Also converts from BCF's Z-up to viewer's Y-up coordinate system.
 *
 * @param camera - BCF perspective camera
 * @param targetDistance - Distance from eye to target (default: 10)
 */
export function perspectiveToCamera(
  camera: BCFPerspectiveCamera,
  targetDistance = 10
): ViewerCameraState {
  // The caller's reference distance is the viewer's live `camera.getDistance()`,
  // which is raw by contract — `@ifc-lite/renderer` reports a malformed pose
  // instead of hiding it. So once the camera is broken by any route, this
  // multiplication turned every *restored* viewpoint into `viewPoint +
  // direction * NaN`, and restoring a known-good viewpoint — the obvious way
  // out — silently failed to repair anything (#2466). Falling back to the
  // documented default is one guard at the sink every restore path funnels
  // through, rather than one guard per app-layer consumer; there are six of
  // those, and guarding them individually is the arrangement that produced
  // this gap.
  const distance = usableTargetDistance(targetDistance, 10);

  // Calculate target in BCF coordinates
  const bcfTarget = {
    x: camera.cameraViewPoint.x + camera.cameraDirection.x * distance,
    y: camera.cameraViewPoint.y + camera.cameraDirection.y * distance,
    z: camera.cameraViewPoint.z + camera.cameraDirection.z * distance,
  };

  // Convert to viewer coordinates (Y-up)
  const viewerPosition = bcfToViewerCoords(camera.cameraViewPoint);
  const viewerTarget = bcfToViewerCoords(bcfTarget);
  const viewerUp = bcfToViewerCoords(camera.cameraUpVector);

  // Convert FOV from degrees to radians
  const fov = (camera.fieldOfView * Math.PI) / 180;

  return {
    position: viewerPosition,
    target: viewerTarget,
    up: viewerUp,
    fov,
    isOrthographic: false,
  };
}

/**
 * Convert BCF orthogonal camera to viewer camera state
 *
 * Also converts from BCF's Z-up to viewer's Y-up coordinate system.
 */
export function orthogonalToCamera(
  camera: BCFOrthogonalCamera,
  targetDistance = 10
): ViewerCameraState {
  // Same sink, same reasoning as `perspectiveToCamera` (#2466).
  const distance = usableTargetDistance(targetDistance, 10);

  // Calculate target in BCF coordinates
  const bcfTarget = {
    x: camera.cameraViewPoint.x + camera.cameraDirection.x * distance,
    y: camera.cameraViewPoint.y + camera.cameraDirection.y * distance,
    z: camera.cameraViewPoint.z + camera.cameraDirection.z * distance,
  };

  // Convert to viewer coordinates (Y-up)
  const viewerPosition = bcfToViewerCoords(camera.cameraViewPoint);
  const viewerTarget = bcfToViewerCoords(bcfTarget);
  const viewerUp = bcfToViewerCoords(camera.cameraUpVector);

  return {
    position: viewerPosition,
    target: viewerTarget,
    up: viewerUp,
    fov: Math.PI / 4, // Default FOV for ortho (not used)
    isOrthographic: true,
    orthoScale: camera.viewToWorldScale,
  };
}

// ============================================================================
// Section Plane Conversion
// ============================================================================

/**
 * Convert viewer section plane to BCF clipping plane
 *
 * ifc-lite uses percentage position (0-100) along an axis.
 * BCF uses absolute location and direction in world coordinates (Z-up).
 */
export function sectionPlaneToClippingPlane(
  sectionPlane: ViewerSectionPlane,
  bounds: ViewerBounds
): BCFClippingPlane | null {
  if (!sectionPlane.enabled) {
    return null;
  }

  // Calculate absolute position from percentage (in viewer coordinates)
  const t = sectionPlane.position / 100;

  let viewerLocation: Point3D;
  let viewerDirection: Point3D;

  switch (sectionPlane.axis) {
    case 'down': // Y axis (viewer up/down)
      viewerLocation = {
        x: (bounds.min.x + bounds.max.x) / 2,
        y: bounds.min.y + t * (bounds.max.y - bounds.min.y),
        z: (bounds.min.z + bounds.max.z) / 2,
      };
      viewerDirection = sectionPlane.flipped ? { x: 0, y: 1, z: 0 } : { x: 0, y: -1, z: 0 };
      break;

    case 'front': // Z axis (viewer depth)
      viewerLocation = {
        x: (bounds.min.x + bounds.max.x) / 2,
        y: (bounds.min.y + bounds.max.y) / 2,
        z: bounds.min.z + t * (bounds.max.z - bounds.min.z),
      };
      viewerDirection = sectionPlane.flipped ? { x: 0, y: 0, z: 1 } : { x: 0, y: 0, z: -1 };
      break;

    case 'side': // X axis
      viewerLocation = {
        x: bounds.min.x + t * (bounds.max.x - bounds.min.x),
        y: (bounds.min.y + bounds.max.y) / 2,
        z: (bounds.min.z + bounds.max.z) / 2,
      };
      viewerDirection = sectionPlane.flipped ? { x: 1, y: 0, z: 0 } : { x: -1, y: 0, z: 0 };
      break;
  }

  // Convert to BCF coordinates (Z-up)
  return {
    location: viewerToBcfCoords(viewerLocation),
    direction: viewerToBcfCoords(viewerDirection),
  };
}

/**
 * Convert BCF clipping plane to viewer section plane
 *
 * Determines the closest axis and calculates percentage position.
 * Converts from BCF coordinates (Z-up) to viewer coordinates (Y-up).
 */
export function clippingPlaneToSectionPlane(
  plane: BCFClippingPlane,
  bounds: ViewerBounds
): ViewerSectionPlane {
  // Convert from BCF coordinates to viewer coordinates
  const viewerLocation = bcfToViewerCoords(plane.location);
  const viewerDirection = bcfToViewerCoords(plane.direction);

  // Determine primary axis based on direction (in viewer coordinates)
  const absX = Math.abs(viewerDirection.x);
  const absY = Math.abs(viewerDirection.y);
  const absZ = Math.abs(viewerDirection.z);

  let axis: 'down' | 'front' | 'side';
  let position: number;
  let flipped: boolean;

  if (absY >= absX && absY >= absZ) {
    // Y axis dominant (down) in viewer
    axis = 'down';
    const range = bounds.max.y - bounds.min.y;
    position = range > 0 ? ((viewerLocation.y - bounds.min.y) / range) * 100 : 50;
    flipped = viewerDirection.y > 0;
  } else if (absZ >= absX) {
    // Z axis dominant (front) in viewer
    axis = 'front';
    const range = bounds.max.z - bounds.min.z;
    position = range > 0 ? ((viewerLocation.z - bounds.min.z) / range) * 100 : 50;
    flipped = viewerDirection.z > 0;
  } else {
    // X axis dominant (side)
    axis = 'side';
    const range = bounds.max.x - bounds.min.x;
    position = range > 0 ? ((viewerLocation.x - bounds.min.x) / range) * 100 : 50;
    flipped = viewerDirection.x > 0;
  }

  // Clamp position to valid range
  position = Math.max(0, Math.min(100, position));

  return {
    axis,
    position,
    enabled: true,
    flipped,
  };
}

// ============================================================================
// Viewpoint Factory
// ============================================================================

/**
 * Create a BCF viewpoint from viewer state
 *
 * For visibility:
 * - Use `hiddenGuids` when most entities are visible (defaultVisibility=true, exceptions=hidden)
 * - Use `visibleGuids` when most entities are hidden/isolated (defaultVisibility=false, exceptions=visible)
 */
export function createViewpoint(options: {
  camera: ViewerCameraState;
  sectionPlane?: ViewerSectionPlane;
  bounds?: ViewerBounds;
  snapshot?: string;
  snapshotData?: Uint8Array;
  selectedGuids?: string[];
  hiddenGuids?: string[];
  visibleGuids?: string[]; // For isolation mode (defaultVisibility=false)
  coloredGuids?: { color: string; guids: string[] }[];
}): BCFViewpoint {
  const {
    camera,
    sectionPlane,
    bounds,
    snapshot,
    snapshotData,
    selectedGuids,
    hiddenGuids,
    visibleGuids,
    coloredGuids,
  } = options;

  const viewpoint: BCFViewpoint = {
    guid: generateUuid(),
  };

  // Add camera
  if (camera.isOrthographic && camera.orthoScale !== undefined) {
    viewpoint.orthogonalCamera = cameraToOrthogonal(camera, camera.orthoScale);
  } else {
    viewpoint.perspectiveCamera = cameraToPerspective(camera);
  }

  // Add clipping plane
  if (sectionPlane?.enabled && bounds) {
    const clippingPlane = sectionPlaneToClippingPlane(sectionPlane, bounds);
    if (clippingPlane) {
      viewpoint.clippingPlanes = [clippingPlane];
    }
  }

  // Add snapshot
  if (snapshot) {
    viewpoint.snapshot = snapshot;
  }
  if (snapshotData) {
    viewpoint.snapshotData = snapshotData;
  }

  // Add components
  const hasSelection = selectedGuids && selectedGuids.length > 0;
  const hasHidden = hiddenGuids && hiddenGuids.length > 0;
  const hasVisible = visibleGuids && visibleGuids.length > 0;
  const hasColoring = coloredGuids && coloredGuids.length > 0;

  if (hasSelection || hasHidden || hasVisible || hasColoring) {
    viewpoint.components = {};

    if (hasSelection) {
      viewpoint.components.selection = selectedGuids!.map((guid) => ({ ifcGuid: guid }));
    }

    // Visibility: use visibleGuids (isolation) or hiddenGuids (normal), not both
    if (hasVisible) {
      // Isolation mode: everything hidden by default, exceptions are visible
      viewpoint.components.visibility = {
        defaultVisibility: false,
        exceptions: visibleGuids!.map((guid) => ({ ifcGuid: guid })),
      };
    } else if (hasHidden) {
      // Normal mode: everything visible by default, exceptions are hidden
      viewpoint.components.visibility = {
        defaultVisibility: true,
        exceptions: hiddenGuids!.map((guid) => ({ ifcGuid: guid })),
      };
    }

    if (hasColoring) {
      viewpoint.components.coloring = coloredGuids!.map(({ color, guids }) => ({
        color,
        components: guids.map((guid) => ({ ifcGuid: guid })),
      }));
    }
  }

  return viewpoint;
}

/**
 * Extract viewer state from a BCF viewpoint
 */
export function extractViewpointState(
  viewpoint: BCFViewpoint,
  bounds?: ViewerBounds,
  targetDistance = 10
): {
  camera?: ViewerCameraState;
  sectionPlane?: ViewerSectionPlane;
  selectedGuids: string[];
  hiddenGuids: string[];
  visibleGuids: string[]; // For isolation mode (defaultVisibility=false)
  coloredGuids: { color: string; guids: string[] }[];
} {
  let camera: ViewerCameraState | undefined;
  let sectionPlane: ViewerSectionPlane | undefined;

  // Extract camera
  if (viewpoint.perspectiveCamera) {
    camera = perspectiveToCamera(viewpoint.perspectiveCamera, targetDistance);
  } else if (viewpoint.orthogonalCamera) {
    camera = orthogonalToCamera(viewpoint.orthogonalCamera, targetDistance);
  }

  // Extract section plane
  if (viewpoint.clippingPlanes && viewpoint.clippingPlanes.length > 0 && bounds) {
    sectionPlane = clippingPlaneToSectionPlane(viewpoint.clippingPlanes[0], bounds);
  }

  // Extract selected GUIDs
  const selectedGuids: string[] = [];
  if (viewpoint.components?.selection) {
    for (const comp of viewpoint.components.selection) {
      if (comp.ifcGuid) {
        selectedGuids.push(comp.ifcGuid);
      }
    }
  }

  // Extract visibility GUIDs
  const hiddenGuids: string[] = [];
  const visibleGuids: string[] = [];
  if (viewpoint.components?.visibility) {
    const { defaultVisibility, exceptions } = viewpoint.components.visibility;
    if (exceptions) {
      for (const comp of exceptions) {
        if (comp.ifcGuid) {
          if (defaultVisibility === false) {
            // Isolation mode: exceptions are the visible entities
            visibleGuids.push(comp.ifcGuid);
          } else {
            // Normal mode: exceptions are the hidden entities
            hiddenGuids.push(comp.ifcGuid);
          }
        }
      }
    }
  }

  // Extract colored GUIDs
  const coloredGuids: { color: string; guids: string[] }[] = [];
  if (viewpoint.components?.coloring) {
    for (const coloring of viewpoint.components.coloring) {
      const guids: string[] = [];
      for (const comp of coloring.components) {
        if (comp.ifcGuid) {
          guids.push(comp.ifcGuid);
        }
      }
      if (guids.length > 0) {
        coloredGuids.push({ color: coloring.color, guids });
      }
    }
  }

  return {
    camera,
    sectionPlane,
    selectedGuids,
    hiddenGuids,
    visibleGuids,
    coloredGuids,
  };
}
