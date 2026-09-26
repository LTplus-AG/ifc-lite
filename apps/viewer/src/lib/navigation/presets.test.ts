/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseNavigationPreset,
  resolveNavigationPointerGesture,
  resolveWheelNavigation,
  type NavigationPreset,
} from './presets.js';
import type { PointerGestureInput } from '@/components/viewer/pointerGesture.js';

const pointer: PointerGestureInput = {
  tool: 'select', button: 0, shiftKey: false, ctrlKey: false,
  metaKey: false, altKey: false, measureMode: 'drag', flyEnabled: true,
};

describe('navigation presets (#5889)', () => {
  it('parses persisted values without accepting an unknown preset', () => {
    for (const preset of ['default', 'navisworks', 'trackpad'] as const) {
      assert.equal(parseNavigationPreset(preset), preset);
    }
    assert.equal(parseNavigationPreset('obsolete'), 'default');
    assert.equal(parseNavigationPreset(null), 'default');
  });

  for (const preset of ['default', 'navisworks', 'trackpad'] as const) {
    it(`${preset}: pointer mapping stays consistent across tools`, () => {
      for (const tool of ['select', 'measure', 'pan', 'walk', 'section']) {
        assert.equal(resolveNavigationPointerGesture(preset, { ...pointer, tool, shiftKey: true }), 'pan');
        assert.equal(resolveNavigationPointerGesture(preset, { ...pointer, tool, button: 2 }), 'fly');
        assert.equal(resolveNavigationPointerGesture(preset, { ...pointer, tool, button: 2, flyEnabled: false }), 'pan');
        assert.equal(resolveNavigationPointerGesture(preset, { ...pointer, tool, button: 1 }), 'pan');
      }
    });
  }

  it('Navisworks-like Shift + middle orbits while ordinary middle pans', () => {
    assert.equal(resolveNavigationPointerGesture('navisworks', { ...pointer, button: 1 }), 'pan');
    assert.equal(resolveNavigationPointerGesture('navisworks', { ...pointer, button: 1, shiftKey: true }), 'orbit');
    assert.equal(resolveNavigationPointerGesture('default', { ...pointer, button: 1, shiftKey: true }), 'pan');
  });

  const wheelCases: {
    preset: NavigationPreset;
    input: { deltaX: number; deltaY: number; ctrlKey: boolean };
    expected: { panX: number; panY: number; zoom: boolean };
  }[] = [
    { preset: 'trackpad', input: { deltaX: 30, deltaY: 0, ctrlKey: false }, expected: { panX: -30, panY: 0, zoom: false } },
    { preset: 'trackpad', input: { deltaX: 0, deltaY: 40, ctrlKey: false }, expected: { panX: 0, panY: -40, zoom: false } },
    { preset: 'trackpad', input: { deltaX: 0, deltaY: 40, ctrlKey: true }, expected: { panX: 0, panY: 0, zoom: true } },
    { preset: 'default', input: { deltaX: 30, deltaY: 0, ctrlKey: false }, expected: { panX: -30, panY: 0, zoom: false } },
    { preset: 'default', input: { deltaX: 30, deltaY: 40, ctrlKey: false }, expected: { panX: -30, panY: 0, zoom: true } },
    { preset: 'default', input: { deltaX: 0, deltaY: 40, ctrlKey: false }, expected: { panX: 0, panY: 0, zoom: true } },
    { preset: 'navisworks', input: { deltaX: 30, deltaY: 40, ctrlKey: false }, expected: { panX: 0, panY: 0, zoom: true } },
  ];

  for (const { preset, input, expected } of wheelCases) {
    it(`${preset}: wheel ${JSON.stringify(input)} resolves to camera input`, () => {
      assert.deepEqual(resolveWheelNavigation(preset, input), expected);
    });
  }
});
