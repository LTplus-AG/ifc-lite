/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildSectionPlaneOption } from './renderSectionPlaneOption.js';
import type { SectionPlane } from '@/store';
import { DEFAULT_CAP_STYLE } from '@ifc-lite/renderer';

const basePlane: SectionPlane = {
  axis: 'down', position: 50, enabled: true, flipped: false,
  showCap: true, showOutlines: true, capStyle: DEFAULT_CAP_STYLE,
};

describe('buildSectionPlaneOption (#5390 extraction from useAnimationLoop.ts)', () => {
  it('returns undefined when the section tool is not active, regardless of plane state', () => {
    assert.equal(buildSectionPlaneOption(false, basePlane, { min: 0, max: 10 }), undefined);
  });

  it('carries the plane fields and the resolved range when the tool is active', () => {
    const out = buildSectionPlaneOption(true, basePlane, { min: 1, max: 9 });
    assert.deepEqual(out, {
      axis: 'down', position: 50, enabled: true, flipped: false,
      showCap: true, showOutlines: true, capStyle: DEFAULT_CAP_STYLE,
      min: 1, max: 9, normal: undefined, distance: undefined,
    });
  });

  it('prefers the custom (face-picked) plane over axis/position for the clip math', () => {
    const withCustom: SectionPlane = {
      ...basePlane,
      custom: { normal: [0, 1, 0], distance: 5, pickedAt: [0, 0, 0], tangent: [1, 0, 0], bitangent: [0, 0, 1] },
    };
    const out = buildSectionPlaneOption(true, withCustom, null);
    assert.equal(out?.normal, withCustom.custom?.normal);
    assert.equal(out?.distance, 5);
    assert.equal(out?.min, undefined);
    assert.equal(out?.max, undefined);
  });
});
