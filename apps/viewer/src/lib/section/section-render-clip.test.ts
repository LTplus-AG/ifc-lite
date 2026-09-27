/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `sectionRenderClip` (#5513, #5893): what the renderer is handed for a
 * plane cut, a box cut, a cut that is off, and a cut hidden by
 * `sceneState.section.visible` (independent of the Section tool, #5893 —
 * the renderer must keep receiving the plane while another tool, e.g.
 * Measure, is active).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sectionRenderClip } from './section-render-clip.js';
import type { SectionPlane } from '@/store/types';

const capStyle: SectionPlane['capStyle'] = {
  fillColor: [1, 1, 1, 1], strokeColor: [0, 0, 0, 1], pattern: 'solid', spacingPx: 8, angleRad: 0, widthPx: 1, secondaryAngleRad: 0,
};
const plane = (over: Partial<SectionPlane> = {}): SectionPlane => ({
  axis: 'down', position: 40, enabled: true, flipped: false, showCap: true, showOutlines: false, capStyle, ...over,
});

describe('sectionRenderClip', () => {
  it('hidden by the visibility toggle, nothing clips, whatever the store holds', () => {
    assert.deepEqual(sectionRenderClip(false, plane({ box: { min: [0, 0, 0], max: [1, 1, 1] } }), { min: 0, max: 8 }), {});
  });

  it('visible, a plane cut passes the plane through with its range and cap settings, and no clip box — even outside the Section tool (#5893)', () => {
    const out = sectionRenderClip(true, plane(), { min: -1, max: 3 });
    assert.equal(out.clipBox, undefined);
    assert.deepEqual(out.sectionPlane, {
      axis: 'down', position: 40, enabled: true, flipped: false, showCap: true, showOutlines: false, capStyle,
      min: -1, max: 3, normal: undefined, distance: undefined,
    });
  });

  it('a face-picked plane hands the shader its normal and distance', () => {
    const custom = { normal: [1, 0, 0] as [number, number, number], distance: 2.5, pickedAt: [2.5, 0, 0] as [number, number, number], tangent: [0, 1, 0] as [number, number, number], bitangent: [0, 0, 1] as [number, number, number] };
    const out = sectionRenderClip(true, plane({ custom }), null);
    assert.deepEqual(out.sectionPlane?.normal, [1, 0, 0]);
    assert.equal(out.sectionPlane?.distance, 2.5);
  });

  it('box mode clips to the box and hands the renderer NO plane, so no preview quad haunts the box', () => {
    const out = sectionRenderClip(true, plane({ box: { min: [0, -1, 0], max: [10, 3, 8] } }), { min: -1, max: 3 });
    assert.deepEqual(out, { clipBox: { min: [0, -1, 0], max: [10, 3, 8], enabled: true } });
  });

  it('Cut off in box mode disables the box and still passes no plane', () => {
    const out = sectionRenderClip(true, plane({ enabled: false, box: { min: [0, 0, 0], max: [1, 1, 1] } }), null);
    assert.deepEqual(out, { clipBox: { min: [0, 0, 0], max: [1, 1, 1], enabled: false } });
  });
});
