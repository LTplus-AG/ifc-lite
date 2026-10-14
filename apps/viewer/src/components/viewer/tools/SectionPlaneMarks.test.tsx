/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Every plane marked in the scene (#7545): a name tag per plane, an arrow to the
 * side that stays, a dashed outline for the planes the GPU draws no quad for.
 * The renderer is a stub that answers `getSectionPlaneFrames` for the planes it
 * is handed, so what is asserted is what the viewer asks for and draws from it.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { getDefaultSectionPlane } from '@/store/slices/sectionSlice.js';
import { setGlobalRendererRef } from '@/hooks/useBCF';
import type { Renderer, SectionPlaneFrame } from '@ifc-lite/renderer';
import { renderScene } from '../../viewport-ui/scene/test/scene-test-support.js';
import { SectionPlaneMarks } from './SectionPlaneMarks.js';

const s = () => useViewerStore.getState();

/** A renderer that places every plane it is given on `x = 10 * (index + 1)`, with a unit +x normal. */
function stubRenderer(asked: Array<{ primary: unknown; extras: unknown[] }>): Renderer {
  return {
    getSectionPlaneFrames: (planes?: { primary: { id?: string; enabled: boolean; flipped?: boolean } | null; extras: Array<{ id?: string; enabled: boolean; flipped?: boolean }> }) => {
      asked.push({ primary: planes?.primary, extras: planes?.extras ?? [] });
      const all = [...(planes?.primary ? [{ plane: planes.primary, primary: true }] : []), ...(planes?.extras ?? []).map((plane) => ({ plane, primary: false }))];
      return all.map(({ plane, primary }, index): SectionPlaneFrame => {
        const x = 10 * (index + 1);
        return {
          id: plane.id ?? null, primary, enabled: plane.enabled, flipped: plane.flipped === true,
          normal: [1, 0, 0], distance: x, anchor: [x, 50, 0],
          corners: [[x, 0, 0], [x, 100, 0], [x, 100, 100], [x, 0, 100]],
        };
      });
    },
  } as unknown as Renderer;
}

let asked: Array<{ primary: unknown; extras: unknown[] }>;
beforeEach(() => {
  asked = [];
  setGlobalRendererRef({ current: stubRenderer(asked) });
  useViewerStore.setState({
    activeTool: 'section', sectionPlane: getDefaultSectionPlane(), inactiveSectionPlanes: [], sectionUndo: null,
    sceneState: { section: { visible: true }, measurements: { visible: true } },
    sectionPickMode: false, sectionPickPreview: null, sectionPickTarget: 'replace',
  } as unknown as Partial<ReturnType<typeof useViewerStore.getState>>);
});
afterEach(() => {
  cleanup();
  setGlobalRendererRef({ current: null });
});

function mount() {
  const scene = renderScene(<SectionPlaneMarks />);
  scene.flush();
  return scene;
}
const tags = (c: HTMLElement) => [...c.querySelectorAll<HTMLElement>('[data-scene-primitive="plane-tag"]')];
const tagNames = (c: HTMLElement) => tags(c).map((t) => t.textContent?.trim());
const outlines = (c: HTMLElement) => c.querySelectorAll('[data-scene-primitive="plane-outline"]').length;
const arrows = (c: HTMLElement) => c.querySelectorAll('[data-scene-primitive="axis-arrow"]').length;

describe('plane marks in the scene (#7545)', () => {
  it('a tag per plane, named, in creation order; the tag of the active plane is the accented one', () => {
    s().addSectionPlane('down');
    s().addSectionPlane('side');
    const { container } = mount();
    assert.deepEqual(tagNames(container), ['A', 'B']);
    const accent = (el: HTMLElement) => el.firstElementChild!.className.includes('text-overlay-accent');
    assert.deepEqual(tags(container).map(accent), [false, true]);
  });

  it('only the planes the GPU draws no quad for get an outline (the active one has its own quad)', () => {
    s().addSectionPlane('down');
    s().addSectionPlane('side');
    s().addSectionPlane('front');
    const { container } = mount();
    assert.equal(outlines(container), 2);
  });

  it('a plane that is cutting gets the kept-side arrow, and one that is only a preview does not', () => {
    s().addSectionPlane('down');
    s().addSectionPlane('side');
    s().setSectionPlaneCutting(s().sectionPlane.id, false);
    const { container } = mount();
    assert.equal(arrows(container), 1);
  });

  it('Show off removes a plane\'s tag, outline and arrow; the cut stays', () => {
    s().addSectionPlane('down');
    s().addSectionPlane('side');
    s().setSectionPlaneShowGizmo(s().inactiveSectionPlanes[0]!.id, false);
    const { container } = mount();
    assert.deepEqual(tagNames(container), ['B']);
    assert.equal(outlines(container), 0);
    assert.equal(s().inactiveSectionPlanes[0]!.enabled, true);
  });

  it('draws nothing while the cut is hidden by the visibility toggle', () => {
    s().addSectionPlane('down');
    s().setSectionVisible(false);
    const { container } = mount();
    assert.deepEqual(tagNames(container), []);
  });

  it('asks the renderer with the store\'s NEWEST planes, so a plane that just moved is placed where it is', () => {
    s().addSectionPlane('down');
    mount();
    asked.length = 0;
    act(() => s().setSectionPlanePosition(80));
    const last = asked[asked.length - 1]!;
    assert.equal((last.primary as { position: number }).position, 80);
  });

  it('marks nothing with no plane yet: the untouched placeholder is not a cut', () => {
    const { container } = mount();
    assert.deepEqual(tagNames(container), []);
    assert.equal(arrows(container), 0);
  });

  it('a box has no plane to mark: no tag or arrow for it, and the renderer is not asked for its frame', () => {
    s().addSectionPlane('down');
    s().addSectionPlane('side');
    s().setSectionBox({ min: [0, 0, 0], max: [1, 1, 1] }); // the active plane becomes the box
    const { container } = mount();
    assert.deepEqual(tagNames(container), ['A'], 'only the real plane is tagged');
    assert.equal(asked[asked.length - 1]!.primary, null, 'the box plane is not handed over as a primary plane');
  });

  it('draws nothing before the renderer has a frame', () => {
    setGlobalRendererRef({ current: null });
    s().addSectionPlane('down');
    const { container } = mount();
    assert.equal(outlines(container), 0);
    // An arrow with nowhere to point is mounted but never shown.
    const shownArrows = [...container.querySelectorAll<SVGElement>('[data-scene-primitive="axis-arrow"]')].filter((a) => a.style.display !== 'none');
    assert.equal(shownArrows.length, 0);
    assert.equal(tags(container).filter((t) => t.style.display !== 'none').length, 0);
  });
});
