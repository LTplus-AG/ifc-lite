/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5391: the Section tool's hint and Clip toggle ride one strip that stacks
 * above the 2D Section panel and stays off the Presentation dock's anchor.
 *
 * The hint used to be z-30 under the 2D panel's z-40 (its left half hidden at
 * 1600 px), and the toggle sat at `bottom-4 left-1/2`, exactly where the
 * Presentation pill (`BasketPresentationDock`) is drawn, so it was covered.
 * happy-dom has no layout, so this pins the stacking and anchoring RULES on the
 * rendered strip; `tests/e2e/section-overlays.e2e.spec.ts` checks the real
 * paint order in a browser.
 */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, render } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { SectionOverlay } from './SectionPanel.js';

/** The 2D Section panel's docked stacking level (`Section2DPanel`, `z-40`). */
const SECTION_2D_PANEL_Z = 40;
/** The Presentation pill's anchor (`BasketPresentationDock`, collapsed). */
const PRESENTATION_PILL_BOTTOM = 'bottom-4';

afterEach(cleanup);
beforeEach(() => {
  useViewerStore.setState({ activeTool: 'section', basketPresentationVisible: false });
});

/** The nearest positioned ancestor (the element the offsets and z apply to). */
function strip(el: Element): HTMLElement {
  let cur: HTMLElement | null = el as HTMLElement;
  while (cur && !/\babsolute\b/.test(cur.className)) cur = cur.parentElement;
  assert.ok(cur, 'the element sits inside an absolutely positioned strip');
  return cur;
}
function zOf(el: HTMLElement): number {
  const m = /(?:^|\s)z-(?:\[(\d+)\]|(\d+))(?=\s|$)/.exec(el.className);
  assert.ok(m, `the strip declares a z-index: ${el.className}`);
  return Number(m[1] ?? m[2]);
}
function bottomOf(el: HTMLElement): string | undefined {
  return /\bbottom-\S+/.exec(el.className)?.[0];
}

describe('Section tool bottom strip (#5391)', () => {
  it('hint and Clip toggle share one strip stacked above the 2D Section panel', () => {
    const container = render(<SectionOverlay />);
    const hint = container.querySelector('[data-section-hint]');
    const toggle = container.querySelector('[data-section-clip-toggle]');
    assert.ok(hint && toggle, 'hint and toggle render');
    assert.equal(strip(hint), strip(toggle), 'one strip, so they can never drift onto different layers');
    assert.ok(zOf(strip(hint)) > SECTION_2D_PANEL_Z, `strip z ${zOf(strip(hint))} must exceed the 2D panel's ${SECTION_2D_PANEL_Z}`);
  });

  it('never shares the Presentation pill anchor, and steps over the expanded dock', () => {
    const container = render(<SectionOverlay />);
    const toggle = container.querySelector('[data-section-clip-toggle]')!;
    const collapsedBottom = bottomOf(strip(toggle));
    assert.notEqual(collapsedBottom, PRESENTATION_PILL_BOTTOM, 'the toggle must not sit on the pill');
    act(() => useViewerStore.setState({ basketPresentationVisible: true }));
    const expandedBottom = bottomOf(strip(container.querySelector('[data-section-clip-toggle]')!));
    assert.notEqual(expandedBottom, collapsedBottom, 'the strip moves up when the dock expands');
  });
});
