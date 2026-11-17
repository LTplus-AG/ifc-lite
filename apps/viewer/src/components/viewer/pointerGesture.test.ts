/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pressPastClickSlop, resolvePointerGesture, type PointerGestureInput } from './pointerGesture.js';

const base: PointerGestureInput = {
  tool: 'select', button: 0, shiftKey: false, ctrlKey: false,
  metaKey: false, altKey: false, measureMode: 'drag', flyEnabled: true,
};

const gesture = (overrides: Partial<PointerGestureInput> = {}) =>
  resolvePointerGesture({ ...base, ...overrides });

describe('pointer gesture mapping (#5887)', () => {
  const tools = ['select', 'measure', 'pan', 'walk', 'section', 'command', 'appearance-face'];

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

  it('Shift+left finishes a pending distance instead of panning; Shift+Alt still pans (#8771)', () => {
    assert.equal(gesture({ tool: 'measure', shiftKey: true, distancePending: true }), 'tool');
    assert.equal(gesture({ tool: 'measure', shiftKey: true, distancePending: false }), 'pan');
    assert.equal(gesture({ tool: 'measure', shiftKey: true, altKey: true, distancePending: true }), 'pan');
    assert.equal(gesture({ tool: 'select', shiftKey: true, distancePending: true }), 'pan');
    assert.equal(gesture({ tool: 'measure', measureMode: 'polyline', shiftKey: true, distancePending: true }), 'pan');
  });

  it('a press is a click until it moves past the slop on either axis (#8740)', () => {
    const press = { startX: 100, startY: 100 };
    assert.equal(pressPastClickSlop(press, { clientX: 103, clientY: 97 }), false);
    assert.equal(pressPastClickSlop(press, { clientX: 104, clientY: 100 }), true);
    assert.equal(pressPastClickSlop(press, { clientX: 100, clientY: 96 }), true);
  });

  it('Pan claims plain left; modelling owns left; other tools leave it for orbit (#6232)', () => {
    assert.equal(gesture({ tool: 'pan' }), 'pan');
    assert.equal(gesture({ tool: 'command' }), 'tool');
    for (const tool of ['walk', 'section', 'appearance-face']) {
      assert.equal(gesture({ tool }), 'orbit');
    }
  });
});
