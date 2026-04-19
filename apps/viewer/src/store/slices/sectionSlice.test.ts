/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { createSectionSlice, type SectionSlice } from './sectionSlice.js';
import { SECTION_PLANE_DEFAULTS } from '../constants.js';

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
