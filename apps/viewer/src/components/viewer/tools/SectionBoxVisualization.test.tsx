/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The section box gizmo on the scene kernel (#5513): six faces and six
 * handles on the one projector, a drag along a face's screen-projected
 * normal moves that face by pixels / (px per metre), the opposite face
 * bounds it, and an edge-on face takes no drag (#5403 capture rule). The
 * stub camera maps world x/y to screen px (an off-canvas point is hidden,
 * so the box sits inside it); the drag test scales it to 2 px/m so a +X
 * normal spans 2 px/m and 30 px = 15 m (a mutation that drops the
 * px-per-metre division reads 30 m and fails). A Z face is edge-on.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { getDefaultSectionPlane } from '@/store/slices/sectionSlice.js';
import { renderScene } from '../../viewport-ui/scene/test/scene-test-support.js';
import { SectionBoxVisualization } from './SectionBoxVisualization.js';

const s = () => useViewerStore.getState();

function pointer(target: Element, type: string, x: number, y = 100): void {
  act(() => target.dispatchEvent(new window.PointerEvent(type, {
    bubbles: true, cancelable: true, pointerId: 7, clientX: x, clientY: y,
  })));
}

/** Handles in `SECTION_BOX_FACES` order: minX, maxX, minY, maxY, minZ, maxZ. */
const FACE = { minX: 0, maxX: 1, minY: 2, maxY: 3, minZ: 4, maxZ: 5 } as const;

function mount() {
  act(() => s().setSectionBox({ min: [2, 1, 0], max: [12, 5, 8] }));
  const scene = renderScene(<SectionBoxVisualization />);
  scene.source.dirty = true;
  scene.flush();
  const handles = [...scene.container.querySelectorAll<SVGCircleElement>('[data-scene-primitive="handle"] circle')];
  assert.equal(handles.length, 6, 'one handle per face');
  return { ...scene, handles };
}

beforeEach(() => {
  useViewerStore.setState({ sectionPlane: getDefaultSectionPlane(), sectionPickMode: false, sectionPickPreview: null, pointCloudAssetCount: 1, pointCloudPreviewStride: 1 });
});
afterEach(cleanup);

describe('SectionBoxVisualization (#5513)', () => {
  it('draws nothing outside box mode and six faces + six handles inside it, on the shared projector', () => {
    const empty = renderScene(<SectionBoxVisualization />);
    assert.equal(empty.container.querySelectorAll('[data-scene-primitive]').length, 0);
    cleanup();
    const { container, projector } = mount();
    assert.equal(container.querySelectorAll('[data-scene-primitive="plane-outline"]').length, 6);
    assert.equal(container.querySelectorAll('[data-scene-primitive="axis-arrow"]').length, 0, 'no arrows until a drag');
    assert.ok(projector.anchorCount >= 12 + 6 + 24, 'faces, handles and corners all ride the one projector');
  });

  it('places each handle at its face centre', () => {
    const { handles } = mount();
    const g = (i: number) => handles[i].closest<SVGGElement>('[data-scene-primitive="handle"]')!;
    const xy = (i: number) => /translate\(([-\d.]+)px, ([-\d.]+)px/.exec(g(i).style.transform)!.slice(1, 3).map(Number);
    assert.deepEqual(xy(FACE.maxX), [12, 3], 'maxX face centre (x = 12, y = mid of [1, 5])');
    assert.deepEqual(xy(FACE.minY), [7, 1], 'minY face centre');
  });

  it('a drag along the +X face\'s projected normal grows the box by pixels / (px per metre); the opposite face stops it', () => {
    const { handles, container, source, flush } = mount();
    source.camera.projectToScreen = (p) => ({ x: p.x * 2, y: p.y * 2 });
    flush();
    const h = handles[FACE.maxX];
    pointer(h, 'pointerdown', 24, 6);
    assert.equal(h.hasPointerCapture(7), true);
    assert.equal(s().pointCloudPreviewStride, 4, 'a scan is thinned while dragging');
    assert.equal(container.querySelectorAll('[data-scene-primitive="axis-arrow"]').length, 1, 'the dragged face shows its normal');
    pointer(h, 'pointermove', 54, 6);
    assert.deepEqual(s().sectionPlane.box, { min: [2, 1, 0], max: [27, 5, 8] }, '30 px along a 2 px/m normal is 15 m');
    pointer(h, 'pointermove', 24, 60);
    assert.deepEqual(s().sectionPlane.box, { min: [2, 1, 0], max: [12, 5, 8] }, 'movement perpendicular to the normal does nothing');
    pointer(h, 'pointermove', -60, 6);
    assert.ok(s().sectionPlane.box!.max[0] > 2 && s().sectionPlane.box!.max[0] < 2.1, 'stopped just past the min face');
    pointer(h, 'pointerup', -60, 6);
    assert.equal(h.hasPointerCapture(7), false);
    assert.equal(s().pointCloudPreviewStride, 1);
    assert.equal(container.querySelectorAll('[data-scene-primitive="axis-arrow"]').length, 0);
  });

  it('a min face moves against its outward normal: dragging -X outward shrinks min x', () => {
    const { handles } = mount();
    const h = handles[FACE.minX];
    pointer(h, 'pointerdown', 2, 3);
    pointer(h, 'pointermove', -18, 3);
    assert.equal(s().sectionPlane.box!.min[0], -18, '20 px outward (toward -x) lowers min x by 20 m');
  });

  it('an edge-on face (Z on this camera) starts no drag and takes no capture', () => {
    const { handles } = mount();
    const h = handles[FACE.maxZ];
    pointer(h, 'pointerdown', 7, 3);
    assert.equal(h.hasPointerCapture(7), false, 'nothing would ever release this capture');
    pointer(h, 'pointermove', 50, 3);
    assert.deepEqual(s().sectionPlane.box, { min: [2, 1, 0], max: [12, 5, 8] });
    assert.equal(s().pointCloudPreviewStride, 1);
  });

  it('the marks follow a box changed from the bar (Fit), waking an idle projector', () => {
    const { handles, flush, projector, source } = mount();
    const g = handles[FACE.maxX].closest<SVGGElement>('[data-scene-primitive="handle"]')!;
    // A static camera: the projector goes idle, so only a wake can move the marks.
    source.dirty = false;
    flush();
    flush();
    assert.equal(projector.isRunning, false, 'idle with a static camera');
    const ticks = projector.dirtyTicks;
    act(() => s().setSectionBox({ min: [3, 2, 1], max: [5, 4, 3] }));
    flush();
    assert.ok(projector.dirtyTicks > ticks, 'the value change woke the one projector');
    assert.match(g.style.transform, /translate\(5px, 3px/);
  });
});
