/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { createSectionSlice, customPlaneCenter, type SectionSlice } from './sectionSlice.js';
import { SECTION_PLANE_DEFAULTS } from '../constants.js';
import type { CustomSectionPlane } from '../types.js';

describe('SectionSlice', () => {
  let state: SectionSlice;
  let setState: (partial: Partial<SectionSlice> | ((state: SectionSlice) => Partial<SectionSlice>)) => void;

  beforeEach(() => {
    // Create a mock set function that updates state
    setState = (partial) => {
      if (typeof partial === 'function') {
        const updates = partial(state);
        state = { ...state, ...updates };
      } else {
        state = { ...state, ...partial };
      }
    };

    // Create slice with mock set function
    state = createSectionSlice(setState, () => state, {} as any);
  });

  describe('initial state', () => {
    it('should have default section plane values', () => {
      assert.strictEqual(state.sectionPlane.axis, SECTION_PLANE_DEFAULTS.AXIS);
      assert.strictEqual(state.sectionPlane.position, SECTION_PLANE_DEFAULTS.POSITION);
      assert.strictEqual(state.sectionPlane.enabled, SECTION_PLANE_DEFAULTS.ENABLED);
      assert.strictEqual(state.sectionPlane.flipped, SECTION_PLANE_DEFAULTS.FLIPPED);
    });
  });

  describe('setSectionPlaneAxis', () => {
    it('should update the axis', () => {
      state.setSectionPlaneAxis('front');
      assert.strictEqual(state.sectionPlane.axis, 'front');
    });

    it('should preserve other section plane properties', () => {
      state.sectionPlane.position = 75;
      state.setSectionPlaneAxis('side');
      assert.strictEqual(state.sectionPlane.axis, 'side');
      assert.strictEqual(state.sectionPlane.position, 75);
    });

    it('should auto-enable the clip so the axis change is immediately visible', () => {
      // Simulate a user who disabled clipping, then picks a new axis — they
      // almost certainly want to see the new cut, not stay in "Clip off".
      state.sectionPlane.enabled = false;
      state.setSectionPlaneAxis('front');
      assert.strictEqual(state.sectionPlane.enabled, true);
    });
  });

  describe('setSectionPlanePosition', () => {
    it('should update the position', () => {
      state.setSectionPlanePosition(75);
      assert.strictEqual(state.sectionPlane.position, 75);
    });

    it('should clamp position to minimum 0', () => {
      state.setSectionPlanePosition(-10);
      assert.strictEqual(state.sectionPlane.position, 0);
    });

    it('should clamp position to maximum 100', () => {
      state.setSectionPlanePosition(150);
      assert.strictEqual(state.sectionPlane.position, 100);
    });

    it('should handle NaN by defaulting to 0', () => {
      state.setSectionPlanePosition(NaN);
      assert.strictEqual(state.sectionPlane.position, 0);
    });

    it('should coerce string numbers', () => {
      state.setSectionPlanePosition('50' as any);
      assert.strictEqual(state.sectionPlane.position, 50);
    });

    it('should auto-enable the clip when the slider moves', () => {
      // This is the fix for the "it jitters, doesn't cut" user report: moving
      // the slider implicitly turns on clipping so the user doesn't have to
      // hunt for the toggle.
      state.sectionPlane.enabled = false;
      state.setSectionPlanePosition(42);
      assert.strictEqual(state.sectionPlane.enabled, true);
      assert.strictEqual(state.sectionPlane.position, 42);
    });
  });

  describe('setSectionPlaneEnabled', () => {
    it('should set enabled to true explicitly', () => {
      state.sectionPlane.enabled = false;
      state.setSectionPlaneEnabled(true);
      assert.strictEqual(state.sectionPlane.enabled, true);
    });

    it('should set enabled to false explicitly', () => {
      state.setSectionPlaneEnabled(false);
      assert.strictEqual(state.sectionPlane.enabled, false);
    });
  });

  describe('setSectionShowCap', () => {
    it('should toggle the showCap flag without touching clipping', () => {
      assert.strictEqual(state.sectionPlane.showCap, true);
      state.setSectionShowCap(false);
      assert.strictEqual(state.sectionPlane.showCap, false);
      // Clipping unchanged — cap is a visual-only add-on.
      assert.strictEqual(state.sectionPlane.enabled, true);
    });
  });

  describe('setSectionShowOutlines', () => {
    it('should toggle the showOutlines flag independently of showCap and clipping', () => {
      assert.strictEqual(state.sectionPlane.showOutlines, true);
      state.setSectionShowOutlines(false);
      assert.strictEqual(state.sectionPlane.showOutlines, false);
      assert.strictEqual(state.sectionPlane.showCap, true);
      assert.strictEqual(state.sectionPlane.enabled, true);
    });

    it('should set showOutlines back to true', () => {
      state.setSectionShowOutlines(false);
      state.setSectionShowOutlines(true);
      assert.strictEqual(state.sectionPlane.showOutlines, true);
    });
  });

  describe('setSectionCapStyle', () => {
    it('should partially update the cap style without clobbering other fields', () => {
      const before = state.sectionPlane.capStyle;
      state.setSectionCapStyle({ pattern: 'concrete' });
      assert.strictEqual(state.sectionPlane.capStyle.pattern, 'concrete');
      assert.strictEqual(state.sectionPlane.capStyle.spacingPx, before.spacingPx);
      assert.strictEqual(state.sectionPlane.capStyle.angleRad,  before.angleRad);
    });

    it('should accept custom fill and stroke colours', () => {
      state.setSectionCapStyle({
        fillColor:   [0.2, 0.3, 0.4, 1.0],
        strokeColor: [0.9, 0.1, 0.1, 1.0],
      });
      assert.deepStrictEqual(state.sectionPlane.capStyle.fillColor,   [0.2, 0.3, 0.4, 1.0]);
      assert.deepStrictEqual(state.sectionPlane.capStyle.strokeColor, [0.9, 0.1, 0.1, 1.0]);
    });
  });

  describe('toggleSectionPlane', () => {
    it('should toggle enabled from true to false', () => {
      assert.strictEqual(state.sectionPlane.enabled, true);
      state.toggleSectionPlane();
      assert.strictEqual(state.sectionPlane.enabled, false);
    });

    it('should toggle enabled from false to true', () => {
      state.sectionPlane.enabled = false;
      state.toggleSectionPlane();
      assert.strictEqual(state.sectionPlane.enabled, true);
    });
  });

  describe('flipSectionPlane', () => {
    it('should toggle flipped from false to true', () => {
      assert.strictEqual(state.sectionPlane.flipped, false);
      state.flipSectionPlane();
      assert.strictEqual(state.sectionPlane.flipped, true);
    });

    it('should toggle flipped from true to false', () => {
      state.sectionPlane.flipped = true;
      state.flipSectionPlane();
      assert.strictEqual(state.sectionPlane.flipped, false);
    });
  });

  describe('face-pick (custom plane)', () => {
    it('setSectionPlaneFromFace stores a unit-length normal + signed distance', () => {
      // Non-unit input: the slice should renormalise before persisting.
      state.setSectionPlaneFromFace([2, 0, 0], [3, 4, 5]);
      const c = state.sectionPlane.custom;
      assert.ok(c, 'custom plane should be set');
      assert.deepStrictEqual(c!.normal, [1, 0, 0]);
      assert.strictEqual(c!.distance, 3); // dot([3,4,5], [1,0,0])
      assert.deepStrictEqual(c!.pickedAt, [3, 4, 5]);
      assert.strictEqual(state.sectionPlane.enabled, true);
      assert.strictEqual(state.sectionPickMode, false);
    });

    it('setSectionPlaneFromFace updates axis + flipped to the signed-dominant cardinal', () => {
      // CR P1 from #581: dropping the sign produced inverted exports.
      state.setSectionPlaneFromFace([-1, 0, 0], [0, 0, 0]);
      assert.strictEqual(state.sectionPlane.axis, 'side');
      assert.strictEqual(state.sectionPlane.flipped, true);

      state.setSectionPlaneFromFace([0, 0, 1], [0, 0, 0]);
      assert.strictEqual(state.sectionPlane.axis, 'front');
      assert.strictEqual(state.sectionPlane.flipped, false);
    });

    it('setSectionPlaneFromFace updates position % when bounds are supplied', () => {
      // CR P2 from #581: leaving position stale produced wrong fallback cuts.
      state.setSectionPlaneFromFace(
        [0, 1, 0],
        [0, 5, 0],
        { min: [0, 0, 0], max: [10, 10, 10] },
      );
      assert.strictEqual(state.sectionPlane.position, 50);
    });

    it('setSectionPlaneFromFace stores an orthonormal tangent + bitangent', () => {
      state.setSectionPlaneFromFace([0, 0, 1], [0, 0, 0]);
      const c = state.sectionPlane.custom!;
      const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
      assert.ok(Math.abs(dot([...c.normal], [...c.tangent])) < 1e-9);
      assert.ok(Math.abs(dot([...c.normal], [...c.bitangent])) < 1e-9);
      assert.ok(Math.abs(dot([...c.tangent], [...c.bitangent])) < 1e-9);
    });

    it('setSectionPlaneFromFace ignores a degenerate (zero-length) normal', () => {
      state.setSectionPickMode(true);
      state.setSectionPlaneFromFace([0, 0, 0], [1, 2, 3]);
      assert.strictEqual(state.sectionPlane.custom, undefined);
      assert.strictEqual(state.sectionPickMode, false);
    });

    it('setSectionPlaneAxis clears any custom plane', () => {
      state.setSectionPlaneFromFace([1, 0, 0], [5, 0, 0]);
      assert.ok(state.sectionPlane.custom);
      state.setSectionPlaneAxis('down');
      assert.strictEqual(state.sectionPlane.custom, undefined);
      assert.strictEqual(state.sectionPlane.axis, 'down');
    });

    it('flipSectionPlane toggles `flipped` without mutating custom geometry', () => {
      // The renderer applies `flipped` independently in the clip shader
      // (`side = flipped ? -1 : 1`). Mutating `normal` / `distance` here
      // as well would double-cancel and the flip button would have no
      // visible effect — see flipSectionPlane in the slice.
      state.setSectionPlaneFromFace([0, 0, 1], [0, 0, 5]);
      const before = state.sectionPlane.custom!;
      assert.strictEqual(state.sectionPlane.flipped, false);
      assert.strictEqual(before.distance, 5);

      state.flipSectionPlane();
      const after = state.sectionPlane.custom!;
      assert.strictEqual(state.sectionPlane.flipped, true);
      // Geometry is untouched — only the `flipped` boolean changes.
      assert.deepStrictEqual(after.normal,    before.normal);
      assert.strictEqual(    after.distance,  before.distance);
      assert.deepStrictEqual(after.pickedAt,  before.pickedAt);
      assert.deepStrictEqual(after.tangent,   before.tangent);
      assert.deepStrictEqual(after.bitangent, before.bitangent);
    });

    it('flipSectionPlane is its own inverse — two flips return to the original state', () => {
      state.setSectionPlaneFromFace([0, 0, 1], [0, 0, 5]);
      const original = state.sectionPlane.custom!;
      const originalFlipped = state.sectionPlane.flipped;

      state.flipSectionPlane();
      state.flipSectionPlane();

      const after = state.sectionPlane.custom!;
      assert.strictEqual(state.sectionPlane.flipped, originalFlipped);
      // Geometry must never have been mutated through the round-trip.
      assert.deepStrictEqual(after.normal,    original.normal);
      assert.strictEqual(    after.distance,  original.distance);
      assert.deepStrictEqual(after.pickedAt,  original.pickedAt);
      assert.deepStrictEqual(after.tangent,   original.tangent);
      assert.deepStrictEqual(after.bitangent, original.bitangent);
    });

    it('flipSectionPlane toggles `flipped` for cardinal planes too (no custom)', () => {
      assert.strictEqual(state.sectionPlane.custom, undefined);
      assert.strictEqual(state.sectionPlane.flipped, false);
      state.flipSectionPlane();
      assert.strictEqual(state.sectionPlane.flipped, true);
      assert.strictEqual(state.sectionPlane.custom, undefined);
      state.flipSectionPlane();
      assert.strictEqual(state.sectionPlane.flipped, false);
    });

    it('setSectionCustomDistance updates distance without touching anything else', () => {
      state.setSectionPlaneFromFace([0, 1, 0], [0, 3, 0]);
      const before = state.sectionPlane.custom!;
      state.setSectionCustomDistance(7);
      const after = state.sectionPlane.custom!;
      assert.strictEqual(after.distance, 7);
      assert.deepStrictEqual(after.normal,    before.normal);
      assert.deepStrictEqual(after.pickedAt,  before.pickedAt);
      assert.deepStrictEqual(after.tangent,   before.tangent);
    });

    it('setSectionCustomDistance is a no-op without a custom plane', () => {
      assert.strictEqual(state.sectionPlane.custom, undefined);
      state.setSectionCustomDistance(42);
      assert.strictEqual(state.sectionPlane.custom, undefined);
    });

    it('setSectionPickMode arms / disarms pick mode', () => {
      assert.strictEqual(state.sectionPickMode, false);
      state.setSectionPickMode(true);
      assert.strictEqual(state.sectionPickMode, true);
      state.setSectionPickMode(false);
      assert.strictEqual(state.sectionPickMode, false);
    });

    it('resetSectionPlane clears the custom plane and disarms pick mode', () => {
      state.setSectionPlaneFromFace([1, 0, 0], [5, 0, 0]);
      state.setSectionPickMode(true);
      state.resetSectionPlane();
      assert.strictEqual(state.sectionPlane.custom, undefined);
      assert.strictEqual(state.sectionPickMode, false);
    });
  });

  describe('customPlaneCenter', () => {
    // Bug guard for the cap polygons + 3D drag gizmo "anchored at original
    // pick" regression: as `distance` drifts (drag/slider) the visual
    // center of the plane must slide along the normal, not stay glued to
    // the original pickedAt — otherwise the cap and gizmo render at the
    // pick location while the geometry clip moves to the new distance.
    it('returns pickedAt unchanged when distance == dot(pickedAt, normal)', () => {
      const plane: CustomSectionPlane = {
        normal:    [1, 0, 0],
        distance:  10,
        pickedAt:  [10, 0, 0],
        tangent:   [0, 1, 0],
        bitangent: [0, 0, 1],
      };
      const center = customPlaneCenter(plane);
      assert.deepStrictEqual(center, [10, 0, 0]);
    });

    it('slides along the normal as distance changes (axis-aligned)', () => {
      const base: CustomSectionPlane = {
        normal:    [1, 0, 0],
        distance:  25,
        pickedAt:  [10, 0, 0],
        tangent:   [0, 1, 0],
        bitangent: [0, 0, 1],
      };
      assert.deepStrictEqual(customPlaneCenter(base), [25, 0, 0]);

      const zeroed: CustomSectionPlane = { ...base, distance: 0 };
      assert.deepStrictEqual(customPlaneCenter(zeroed), [0, 0, 0]);
    });

    it('produces a point that satisfies dot(center, normal) == distance for an arbitrary normal', () => {
      const inv = 1 / Math.sqrt(3);
      const plane: CustomSectionPlane = {
        normal:    [inv, inv, inv],
        distance:  4.2,
        pickedAt:  [1, 2, 3],
        tangent:   [1, 0, 0], // unused by the projection
        bitangent: [0, 1, 0],
      };
      const c = customPlaneCenter(plane);
      const dot = c[0] * plane.normal[0] + c[1] * plane.normal[1] + c[2] * plane.normal[2];
      assert.ok(Math.abs(dot - plane.distance) < 1e-9, `dot(center, normal) = ${dot}, want ${plane.distance}`);
    });

    it('preserves the lateral (in-plane) offset of pickedAt — center is the perpendicular projection', () => {
      // Slide pickedAt along the normal only — the projection should land
      // exactly on the plane and keep the orthogonal components intact.
      const plane: CustomSectionPlane = {
        normal:    [0, 1, 0],
        distance:  5,
        pickedAt:  [7, 9, 4],   // off-plane by (9 − 5) = 4 along +Y
        tangent:   [1, 0, 0],
        bitangent: [0, 0, 1],
      };
      const c = customPlaneCenter(plane);
      // X and Z (in-plane) preserved; Y projected to the plane.
      assert.deepStrictEqual(c, [7, 5, 4]);
    });
  });

  describe('resetSectionPlane', () => {
    it('should reset to default values', () => {
      state.setSectionPlaneAxis('side');
      state.setSectionPlanePosition(25);
      state.setSectionPlaneEnabled(false);
      state.flipSectionPlane();
      state.setSectionShowCap(false);
      state.setSectionShowOutlines(false);
      state.setSectionCapStyle({ pattern: 'brick' });

      state.resetSectionPlane();

      assert.strictEqual(state.sectionPlane.axis, SECTION_PLANE_DEFAULTS.AXIS);
      assert.strictEqual(state.sectionPlane.position, SECTION_PLANE_DEFAULTS.POSITION);
      assert.strictEqual(state.sectionPlane.enabled, SECTION_PLANE_DEFAULTS.ENABLED);
      assert.strictEqual(state.sectionPlane.flipped, SECTION_PLANE_DEFAULTS.FLIPPED);
      assert.strictEqual(state.sectionPlane.showCap, SECTION_PLANE_DEFAULTS.SHOW_CAP);
      assert.strictEqual(state.sectionPlane.showOutlines, SECTION_PLANE_DEFAULTS.SHOW_OUTLINES);
      // Default cap pattern restored.
      assert.strictEqual(state.sectionPlane.capStyle.pattern, 'diagonal');
    });
  });
});
