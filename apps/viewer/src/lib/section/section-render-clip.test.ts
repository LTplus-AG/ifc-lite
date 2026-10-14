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
  id: 'p', name: 'A', showGizmo: true,
  axis: 'down', position: 40, enabled: true, flipped: false, showCap: true, showOutlines: false, capStyle, ...over,
});

describe('sectionRenderClip', () => {
  it('hidden by the visibility toggle, nothing clips, whatever the store holds', () => {
    assert.deepEqual(sectionRenderClip(false, plane({ box: { min: [0, 0, 0], max: [1, 1, 1] } }), { min: 0, max: 8 }, 'section'), {});
  });

  it('visible, a plane cut passes the plane through with its range and cap settings, and no clip box — even outside the Section tool (#5893)', () => {
    const out = sectionRenderClip(true, plane(), { min: -1, max: 3 }, 'measure');
    assert.equal(out.clipBox, undefined);
    assert.deepEqual(out.sectionPlane, {
      id: 'p', showGizmo: true,
      axis: 'down', position: 40, enabled: true, flipped: false, showCap: true, showOutlines: false, capStyle,
      min: -1, max: 3, normal: undefined, distance: undefined,
    });
  });

  it('a face-picked plane hands the shader its normal and distance', () => {
    const custom = { normal: [1, 0, 0] as [number, number, number], distance: 2.5, pickedAt: [2.5, 0, 0] as [number, number, number], tangent: [0, 1, 0] as [number, number, number], bitangent: [0, 0, 1] as [number, number, number] };
    const out = sectionRenderClip(true, plane({ custom }), null, 'section');
    assert.deepEqual(out.sectionPlane?.normal, [1, 0, 0]);
    assert.equal(out.sectionPlane?.distance, 2.5);
  });

  it('box mode clips to the box and hands the renderer NO plane, so no preview quad haunts the box', () => {
    const out = sectionRenderClip(true, plane({ box: { min: [0, -1, 0], max: [10, 3, 8] } }), { min: -1, max: 3 }, 'select');
    assert.deepEqual(out, { clipBox: { min: [0, -1, 0], max: [10, 3, 8], enabled: true } });
  });

  it('Cut off in box mode disables the box and still passes no plane', () => {
    const out = sectionRenderClip(true, plane({ enabled: false, box: { min: [0, 0, 0], max: [1, 1, 1] } }), null, 'select');
    assert.deepEqual(out, { clipBox: { min: [0, 0, 0], max: [1, 1, 1], enabled: false } });
  });

  it('a plane that is not cutting is a preview: handed over inside the Section tool only (#6374)', () => {
    const off = plane({ enabled: false });
    assert.equal(sectionRenderClip(true, off, null, 'section').sectionPlane?.enabled, false);
    assert.deepEqual(sectionRenderClip(true, off, null, 'select'), {});
    assert.deepEqual(sectionRenderClip(true, off, null, 'measure'), {});
  });

  describe('cutting planes beyond the active one (#7545)', () => {
    const second = plane({ id: 'q', name: 'B', axis: 'side', position: 25, flipped: true });

    it('hands each inactive plane over for the renderer to resolve, with its id and no cap or range', () => {
      const out = sectionRenderClip(true, plane(), { min: 0, max: 8 }, 'select', [second]);
      assert.deepEqual(out.extraSectionPlanes, [
        { id: 'q', showGizmo: true, axis: 'side', position: 25, enabled: true, flipped: true, normal: undefined, distance: undefined },
      ]);
      assert.equal(out.sectionPlane?.axis, 'down', 'the active plane is still the primary');
    });

    it('a face-picked inactive plane carries its own normal and distance', () => {
      const custom = { normal: [0, 0, 1] as [number, number, number], distance: 4, pickedAt: [0, 0, 4] as [number, number, number], tangent: [1, 0, 0] as [number, number, number], bitangent: [0, 1, 0] as [number, number, number] };
      const out = sectionRenderClip(true, plane(), null, 'select', [plane({ id: 'q', custom })]);
      assert.deepEqual(out.extraSectionPlanes?.[0]?.normal, [0, 0, 1]);
      assert.equal(out.extraSectionPlanes?.[0]?.distance, 4);
    });

    it('a plane that is not cutting is handed over disabled (the renderer clips nothing with it), and a hidden cut hides all of them', () => {
      assert.equal(sectionRenderClip(true, plane(), null, 'select', [plane({ id: 'q', enabled: false })]).extraSectionPlanes?.[0]?.enabled, false);
      assert.deepEqual(sectionRenderClip(false, plane(), null, 'select', [second]), {});
    });

    it('they keep cutting when the active plane is only a preview outside the Section tool', () => {
      const out = sectionRenderClip(true, plane({ enabled: false }), null, 'select', [second]);
      assert.equal(out.sectionPlane, undefined, 'no preview quad outside the tool (#6374)');
      assert.equal(out.extraSectionPlanes?.length, 1);
    });

    it('a boxed inactive plane clips by its box when the active plane has none, and the active box wins the slot', () => {
      const boxed = plane({ id: 'q', name: 'B', box: { min: [0, 0, 0], max: [2, 2, 2] } });
      const fallback = sectionRenderClip(true, plane(), null, 'select', [boxed]);
      assert.deepEqual(fallback.clipBox, { min: [0, 0, 0], max: [2, 2, 2], enabled: true });
      assert.equal(fallback.extraSectionPlanes, undefined, 'a boxed plane adds no plane');
      const active = sectionRenderClip(true, plane({ box: { min: [5, 5, 5], max: [6, 6, 6] } }), null, 'select', [boxed]);
      assert.deepEqual(active.clipBox, { min: [5, 5, 5], max: [6, 6, 6], enabled: true });
    });

    it('a box plus a normal cut clip the same whichever of the two is active (selection never changes the cut)', () => {
      const box = { min: [0, 0, 0] as [number, number, number], max: [2, 2, 2] as [number, number, number] };
      const boxPlane = plane({ id: 'b', name: 'B', box });
      const sidePlane = plane({ id: 'c', name: 'C', axis: 'side', position: 30 });
      // What clips, as the renderer sees it: the box, and every enabled plane (primary or extra).
      const clipping = (out: ReturnType<typeof sectionRenderClip>) => ({
        box: out.clipBox,
        planes: [out.sectionPlane, ...(out.extraSectionPlanes ?? [])]
          .filter((p) => p?.enabled)
          .map((p) => [p!.axis, p!.position]),
      });

      const boxActive = sectionRenderClip(true, boxPlane, null, 'select', [sidePlane]);
      const sideActive = sectionRenderClip(true, sidePlane, null, 'select', [boxPlane]);

      assert.deepEqual(clipping(boxActive), { box: { ...box, enabled: true }, planes: [['side', 30]] }, 'the box and the normal cut both clip');
      assert.deepEqual(clipping(sideActive), clipping(boxActive), 'activating the other plane must not drop or add a cut');
      assert.equal(sideActive.sectionPlane?.axis, 'side', 'the active normal plane stays the renderer\'s primary plane');
    });

    it('an active box that is switched off does not hold the box slot against one that is cutting', () => {
      const off = plane({ id: 'a', enabled: false, box: { min: [5, 5, 5], max: [6, 6, 6] } });
      const on = plane({ id: 'b', box: { min: [0, 0, 0], max: [2, 2, 2] } });
      assert.deepEqual(sectionRenderClip(true, off, null, 'select', [on]).clipBox, { min: [0, 0, 0], max: [2, 2, 2], enabled: true });
      assert.deepEqual(sectionRenderClip(true, off, null, 'select', []).clipBox, { min: [5, 5, 5], max: [6, 6, 6], enabled: false }, 'alone, it is simply off');
    });

    it('a disabled boxed plane does not clip, and the active normal cut still does', () => {
      const boxed = plane({ id: 'b', name: 'B', enabled: false, box: { min: [0, 0, 0], max: [2, 2, 2] } });
      const out = sectionRenderClip(true, plane({ axis: 'side', position: 30 }), null, 'select', [boxed]);
      assert.equal(out.clipBox, undefined);
      assert.equal(out.sectionPlane?.enabled, true);
    });

    it('every plane carries the same slider range along its own axis (so a percentage means one place), custom planes none', () => {
      const bounds = { min: { x: 0, y: -1, z: 10 }, max: { x: 8, y: 3, z: 30 } };
      const out = sectionRenderClip(true, plane(), { min: -1, max: 3 }, 'select', [
        plane({ id: 'q', axis: 'side' }), plane({ id: 'r', axis: 'front' }), plane({ id: 's', axis: 'down' }),
        plane({ id: 't', custom: { normal: [0, 0, 1], distance: 4, pickedAt: [0, 0, 4], tangent: [1, 0, 0], bitangent: [0, 1, 0] } }),
      ], bounds);
      assert.deepEqual(out.extraSectionPlanes!.map((p) => [p.min, p.max]), [[0, 8], [10, 30], [-1, 3], [undefined, undefined]]);
    });

    it('with one plane the result is what it was before the set existed', () => {
      assert.deepEqual(sectionRenderClip(true, plane(), null, 'select', []), sectionRenderClip(true, plane(), null, 'select'));
      assert.equal('extraSectionPlanes' in sectionRenderClip(true, plane(), null, 'select', []), false);
    });
  });
});
