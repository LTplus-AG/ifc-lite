/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5391: the Section tool's hint strip stacks above the 2D drawing window.
 *
 * The hint used to be z-30 under the 2D panel's z-40 (its left half hidden at
 * 1600 px). happy-dom has no layout, so this pins the stacking and anchoring
 * RULES on the rendered strip; `tests/e2e/section-overlays.e2e.spec.ts`
 * checks the real paint order in a browser. The Clip toggle that shared this
 * strip is the Section bar's Cut toggle since #5499 (`SectionToolbar.test`);
 * the strip itself becomes a `HudHint` in #5500, which retires this file.
 */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, render } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { SectionOverlay } from './SectionPanel.js';

/** The 2D drawing window's docked stacking level (`z-40`). */
const SECTION_2D_PANEL_Z = 40;

afterEach(cleanup);
beforeEach(() => {
  useViewerStore.setState({ activeTool: 'section' });
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

describe('Section tool hint strip (#5391)', () => {
  it('stacks above the 2D drawing window', () => {
    const container = render(<SectionOverlay />);
    const hint = container.querySelector('[data-section-hint]');
    assert.ok(hint, 'hint renders');
    assert.ok(zOf(strip(hint)) > SECTION_2D_PANEL_Z, `strip z ${zOf(strip(hint))} must exceed the 2D panel's ${SECTION_2D_PANEL_Z}`);
  });
});
