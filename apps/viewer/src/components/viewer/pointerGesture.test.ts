/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePointerGesture, type PointerGestureInput } from './pointerGesture.js';

const base: PointerGestureInput = {
  tool: 'select', button: 0, shiftKey: false, ctrlKey: false,
  metaKey: false, altKey: false, measureMode: 'drag', flyEnabled: true,
};

const gesture = (overrides: Partial<PointerGestureInput> = {}) =>
  resolvePointerGesture({ ...base, ...overrides });

describe('pointer gesture mapping (#5887)', () => {
  const tools = ['select', 'measure', 'pan', 'walk', 'section', 'addElement', 'split', 'appearance-face'];

  for (const tool of tools) {
    it(`${tool}: Shift+left always pans, including with Ctrl, Meta, or Alt`, () => {
      for (const modifier of [{}, { ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
        assert.equal(gesture({ tool, button: 0, shiftKey: true, ...modifier }), 'pan');
      }
    });

    it(`${tool}: middle pans and right flies while controls are enabled`, () => {
      for (const shiftKey of [false, true]) {
        assert.equal(gesture({ tool, button: 1, shiftKey }), 'pan');
        // #4868 intentionally gives right-button fly priority over pan.
        assert.equal(gesture({ tool, button: 2, shiftKey }), 'fly');
        assert.equal(gesture({ tool, button: 2, shiftKey, flyEnabled: false }), 'pan');
      }
    });
  }

  it('Select claims Ctrl/Meta left for rectangle selection; plain left orbits', () => {
    assert.equal(gesture(), 'orbit');
    assert.equal(gesture({ ctrlKey: true }), 'tool');
    assert.equal(gesture({ metaKey: true }), 'tool');
    assert.equal(gesture({ altKey: true }), 'orbit');
  });

  it('Measure claims only ordinary drag mode, leaving Alt+left and click modes to orbit', () => {
    assert.equal(gesture({ tool: 'measure' }), 'tool');
    assert.equal(gesture({ tool: 'measure', altKey: true }), 'orbit');
    for (const measureMode of ['polyline', 'angle', 'radius'] as const) {
      assert.equal(gesture({ tool: 'measure', measureMode }), 'orbit');
    }
  });

  it('Pan claims plain left; other tools leave plain left for orbit', () => {
    assert.equal(gesture({ tool: 'pan' }), 'pan');
    for (const tool of ['walk', 'section', 'addElement', 'split', 'appearance-face']) {
      assert.equal(gesture({ tool }), 'orbit');
    }
  });
});
