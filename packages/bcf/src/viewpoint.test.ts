/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import {
  cameraToPerspective,
  cameraToOrthogonal,
  perspectiveToCamera,
  orthogonalToCamera,
  sectionPlaneToClippingPlane,
  clippingPlaneToSectionPlane,
  createViewpoint,
  extractViewpointState,
  type ViewerCameraState,
  type ViewerBounds,
  type ViewerSectionPlane,
} from './viewpoint.js';

/**
 * Coordinate system reference:
 *
 * Viewer (Y-up, typical WebGL):
 *   +X = right
 *   +Y = up (vertical)
 *   +Z = towards viewer (out of screen)
 *
 * BCF/IFC (Z-up):
 *   +X = right
 *   +Y = forward (into screen)
 *   +Z = up (vertical)
 *
 * Conversion Y-up → Z-up:
 *   BCF.x = Viewer.x
 *   BCF.y = -Viewer.z
 *   BCF.z = Viewer.y
 */

describe('BCF Viewpoint Coordinate Conversion', () => {
  describe('cameraToPerspective (Y-up → Z-up)', () => {
    it('should convert standard isometric view correctly', () => {
      // Viewer camera looking at origin from upper-right-front
      // In Y-up: position is to the right (+X), up (+Y), and towards viewer (+Z)
      const viewerCamera: ViewerCameraState = {
        position: { x: 10, y: 10, z: 10 },
        target: { x: 0, y: 0, z: 0 },
        up: { x: 0, y: 1, z: 0 }, // Y-up
        fov: Math.PI / 3, // 60 degrees
      };

      const bcfCamera = cameraToPerspective(viewerCamera);

      // Expected BCF position after conversion:
      // BCF.x = 10, BCF.y = -10 (viewer Z=10 → BCF Y=-10), BCF.z = 10 (viewer Y=10)
      expect(bcfCamera.cameraViewPoint.x).toBeCloseTo(10, 5);
      expect(bcfCamera.cameraViewPoint.y).toBeCloseTo(-10, 5);
      expect(bcfCamera.cameraViewPoint.z).toBeCloseTo(10, 5);

      // Up vector should be {0, 0, 1} in BCF (Z-up)
      // Viewer up {0, 1, 0} → BCF {0, -0, 1} = {0, 0, 1}
      expect(bcfCamera.cameraUpVector.x).toBeCloseTo(0, 5);
      expect(bcfCamera.cameraUpVector.y).toBeCloseTo(0, 5);
      expect(bcfCamera.cameraUpVector.z).toBeCloseTo(1, 5);

      // FOV should be converted from radians to degrees
      expect(bcfCamera.fieldOfView).toBeCloseTo(60, 1);

      // Direction should point from position towards origin
      // Normalized direction in viewer: (-10, -10, -10) / sqrt(300) ≈ (-0.577, -0.577, -0.577)
      // In BCF: (-0.577, 0.577, -0.577) - note Y is flipped
      const len = Math.sqrt(3);
      expect(bcfCamera.cameraDirection.x).toBeCloseTo(-1 / len, 3);
      expect(bcfCamera.cameraDirection.y).toBeCloseTo(1 / len, 3); // -viewer.z becomes +BCF.y
      expect(bcfCamera.cameraDirection.z).toBeCloseTo(-1 / len, 3);
    });

    it('should convert front view correctly', () => {
      // Camera looking at origin from front (positive Z in viewer)
      const viewerCamera: ViewerCameraState = {
        position: { x: 0, y: 0, z: 100 }, // Front in Y-up
        target: { x: 0, y: 0, z: 0 },
        up: { x: 0, y: 1, z: 0 },
        fov: Math.PI / 4,
      };

      const bcfCamera = cameraToPerspective(viewerCamera);

      // In BCF: front view means looking from negative Y
      // Viewer {0, 0, 100} → BCF {0, -100, 0}
      expect(bcfCamera.cameraViewPoint.x).toBeCloseTo(0, 5);
      expect(bcfCamera.cameraViewPoint.y).toBeCloseTo(-100, 5);
      expect(bcfCamera.cameraViewPoint.z).toBeCloseTo(0, 5);

      // Direction should be {0, 1, 0} in BCF (looking forward into +Y)
      expect(bcfCamera.cameraDirection.x).toBeCloseTo(0, 5);
      expect(bcfCamera.cameraDirection.y).toBeCloseTo(1, 5);
      expect(bcfCamera.cameraDirection.z).toBeCloseTo(0, 5);

      // Up should be Z-up in BCF
      expect(bcfCamera.cameraUpVector.z).toBeCloseTo(1, 5);
    });

    it('should convert top-down view correctly', () => {
      // Camera looking down from above
      const viewerCamera: ViewerCameraState = {
        position: { x: 0, y: 100, z: 0 }, // Above in Y-up
        target: { x: 0, y: 0, z: 0 },
        up: { x: 0, y: 0, z: -1 }, // Looking down, "up" is towards -Z in viewer
        fov: Math.PI / 4,
      };

      const bcfCamera = cameraToPerspective(viewerCamera);

      // Viewer {0, 100, 0} → BCF {0, 0, 100}
      expect(bcfCamera.cameraViewPoint.x).toBeCloseTo(0, 5);
      expect(bcfCamera.cameraViewPoint.y).toBeCloseTo(0, 5);
      expect(bcfCamera.cameraViewPoint.z).toBeCloseTo(100, 5);

      // Direction should be {0, 0, -1} in BCF (looking down)
      expect(bcfCamera.cameraDirection.x).toBeCloseTo(0, 5);
      expect(bcfCamera.cameraDirection.y).toBeCloseTo(0, 5);
      expect(bcfCamera.cameraDirection.z).toBeCloseTo(-1, 5);
    });
  });

  describe('perspectiveToCamera (Z-up → Y-up)', () => {
    it('should be inverse of cameraToPerspective', () => {
      const originalViewer: ViewerCameraState = {
        position: { x: 50, y: 30, z: 80 },
        target: { x: 10, y: 5, z: 20 },
        up: { x: 0, y: 1, z: 0 },
        fov: Math.PI / 3,
      };

      // Convert to BCF and back
      const bcfCamera = cameraToPerspective(originalViewer);

      // Calculate distance for reverse conversion
      const dx = originalViewer.target.x - originalViewer.position.x;
      const dy = originalViewer.target.y - originalViewer.position.y;
      const dz = originalViewer.target.z - originalViewer.position.z;
      const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);

      const roundtripped = perspectiveToCamera(bcfCamera, distance);

      // Position should match
      expect(roundtripped.position.x).toBeCloseTo(originalViewer.position.x, 3);
      expect(roundtripped.position.y).toBeCloseTo(originalViewer.position.y, 3);
      expect(roundtripped.position.z).toBeCloseTo(originalViewer.position.z, 3);

      // Target should match (approximately, due to normalization)
      expect(roundtripped.target.x).toBeCloseTo(originalViewer.target.x, 1);
      expect(roundtripped.target.y).toBeCloseTo(originalViewer.target.y, 1);
      expect(roundtripped.target.z).toBeCloseTo(originalViewer.target.z, 1);

      // FOV should match
      expect(roundtripped.fov).toBeCloseTo(originalViewer.fov, 3);
    });
  });

  describe('orthogonal camera (Z-up <-> Y-up)', () => {
    // Only the perspective pair had fixtures; the orthogonal pair — including the
    // view-to-world scale a receiving viewer uses to size the ortho frustum —
    // was entirely unpinned.
    it('carries viewToWorldScale through the round-trip unchanged', () => {
      const viewer: ViewerCameraState = {
        position: { x: 0, y: 100, z: 0 },
        target: { x: 0, y: 0, z: 0 },
        up: { x: 0, y: 0, z: -1 },
        fov: Math.PI / 4,
        isOrthographic: true,
        orthoScale: 42.5,
      };

      const bcf = cameraToOrthogonal(viewer, viewer.orthoScale!);
      expect(bcf.viewToWorldScale).toBe(42.5);
      // Viewer {0,100,0} -> BCF {0,0,100}; looking straight down is BCF -Z.
      expect(bcf.cameraViewPoint).toEqual({ x: 0, y: -0, z: 100 });
      expect(bcf.cameraDirection.z).toBeCloseTo(-1, 6);

      const back = orthogonalToCamera(bcf, 100);
      expect(back.isOrthographic).toBe(true);
      expect(back.orthoScale).toBe(42.5);
      expect(back.position.x).toBeCloseTo(0, 6);
      expect(back.position.y).toBeCloseTo(100, 6);
      expect(back.target.y).toBeCloseTo(0, 6);
    });
  });

  describe('section plane <-> clipping plane', () => {
    const bounds: ViewerBounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 20, z: 30 } };

    // The `enabled` guard is the only thing standing between a disabled section
    // plane and a clipping plane written into the BCF: inverting it silently
    // exports a cut model as un-cut and vice versa.
    it('returns a plane when enabled and null when disabled', () => {
      const enabled: ViewerSectionPlane = { axis: 'down', position: 50, enabled: true, flipped: false };
      const plane = sectionPlaneToClippingPlane(enabled, bounds);
      expect(plane).not.toBeNull();
      // Viewer location {5,10,15} -> BCF {5,-15,10}; viewer dir {0,-1,0} -> BCF z=-1.
      expect(plane!.location.x).toBeCloseTo(5, 6);
      expect(plane!.location.y).toBeCloseTo(-15, 6);
      expect(plane!.location.z).toBeCloseTo(10, 6);
      expect(plane!.direction.z).toBeCloseTo(-1, 6);

      expect(sectionPlaneToClippingPlane({ ...enabled, enabled: false }, bounds)).toBeNull();
    });

    // `flipped` is a two-valued signal; a fixture that only ever exercised the
    // un-flipped case would leave the comparison free to point either way.
    it('recovers axis, position and BOTH flip directions', () => {
      for (const axis of ['down', 'front', 'side'] as const) {
        for (const flipped of [false, true]) {
          const source: ViewerSectionPlane = { axis, position: 25, enabled: true, flipped };
          const plane = sectionPlaneToClippingPlane(source, bounds)!;
          const back = clippingPlaneToSectionPlane(plane, bounds);

          expect(back.axis).toBe(axis);
          expect(back.position).toBeCloseTo(25, 6);
          expect(back.flipped).toBe(flipped);
          expect(back.enabled).toBe(true);
        }
      }
    });

    it('falls back to the midpoint when the axis has zero extent', () => {
      const flat: ViewerBounds = { min: { x: 0, y: 5, z: 0 }, max: { x: 10, y: 5, z: 30 } };
      const plane = sectionPlaneToClippingPlane(
        { axis: 'down', position: 80, enabled: true, flipped: false },
        flat,
      )!;
      expect(clippingPlaneToSectionPlane(plane, flat).position).toBe(50);
    });
  });

  describe('createViewpoint / extractViewpointState', () => {
    const camera: ViewerCameraState = {
      position: { x: 0, y: 10, z: 10 },
      target: { x: 0, y: 0, z: 0 },
      up: { x: 0, y: 1, z: 0 },
      fov: Math.PI / 3,
    };

    // visibleGuids means "isolate these" (defaultVisibility=false) and hiddenGuids
    // means "hide these" (defaultVisibility=true). Getting the flag wrong inverts
    // what the receiving viewer shows, with no error anywhere.
    it('encodes isolation as defaultVisibility=false and hiding as true', () => {
      const isolate = createViewpoint({ camera, visibleGuids: ['KEEPVISIBLE00000000001'] });
      expect(isolate.components?.visibility?.defaultVisibility).toBe(false);
      expect(isolate.components?.visibility?.exceptions).toEqual([{ ifcGuid: 'KEEPVISIBLE00000000001' }]);

      const hide = createViewpoint({ camera, hiddenGuids: ['HIDEME0000000000000001'] });
      expect(hide.components?.visibility?.defaultVisibility).toBe(true);
      expect(hide.components?.visibility?.exceptions).toEqual([{ ifcGuid: 'HIDEME0000000000000001' }]);
    });

    it('round-trips isolation and hiding back into the right bucket', () => {
      const isolate = extractViewpointState(createViewpoint({ camera, visibleGuids: ['A000000000000000000001'] }));
      expect(isolate.visibleGuids).toEqual(['A000000000000000000001']);
      expect(isolate.hiddenGuids).toEqual([]);

      const hide = extractViewpointState(createViewpoint({ camera, hiddenGuids: ['B000000000000000000001'] }));
      expect(hide.hiddenGuids).toEqual(['B000000000000000000001']);
      expect(hide.visibleGuids).toEqual([]);
    });

    it('omits components entirely when nothing is selected, hidden or coloured', () => {
      const bare = createViewpoint({ camera });
      expect(bare.components).toBeUndefined();
      expect(bare.perspectiveCamera).toBeDefined();
      expect(bare.orthogonalCamera).toBeUndefined();

      const state = extractViewpointState(bare);
      expect(state.selectedGuids).toEqual([]);
      expect(state.coloredGuids).toEqual([]);
      expect(state.sectionPlane).toBeUndefined();
    });

    it('uses the orthogonal camera only when the state is orthographic AND scaled', () => {
      const ortho = createViewpoint({ camera: { ...camera, isOrthographic: true, orthoScale: 7 } });
      expect(ortho.orthogonalCamera?.viewToWorldScale).toBe(7);
      expect(ortho.perspectiveCamera).toBeUndefined();

      // isOrthographic with no scale has no usable frustum size -> perspective.
      const noScale = createViewpoint({ camera: { ...camera, isOrthographic: true } });
      expect(noScale.perspectiveCamera).toBeDefined();
      expect(noScale.orthogonalCamera).toBeUndefined();
    });
  });

  describe('Official BCF sample validation', () => {
    it('should match format of buildingSMART sample', () => {
      // Create a camera that would produce similar values to the official sample
      // Official BCF sample has:
      // Position: {19.15, -22.61, 18.35} (Z-up)
      // Direction: {-0.47, 0.57, -0.67} (Z-up)
      // Up: {-0.42, 0.52, 0.74} (Z-up)

      // Convert official BCF back to viewer coordinates to understand the view
      const bcfSample = {
        cameraViewPoint: { x: 19.15, y: -22.61, z: 18.35 },
        cameraDirection: { x: -0.47, y: 0.57, z: -0.67 },
        cameraUpVector: { x: -0.42, y: 0.52, z: 0.74 },
        fieldOfView: 60,
      };

      const viewerState = perspectiveToCamera(bcfSample, 50);

      // Verify the viewer state makes sense:
      // BCF {19.15, -22.61, 18.35} → Viewer {19.15, 18.35, 22.61}
      expect(viewerState.position.x).toBeCloseTo(19.15, 1);
      expect(viewerState.position.y).toBeCloseTo(18.35, 1);
      expect(viewerState.position.z).toBeCloseTo(22.61, 1);

      // The up vector Z component (0.74) becomes Y component in viewer
      // BCF up {-0.42, 0.52, 0.74} → Viewer up {-0.42, 0.74, -0.52}
      expect(viewerState.up.x).toBeCloseTo(-0.42, 1);
      expect(viewerState.up.y).toBeCloseTo(0.74, 1);
      expect(viewerState.up.z).toBeCloseTo(-0.52, 1);
    });
  });
});
