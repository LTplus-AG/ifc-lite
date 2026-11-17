/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #10604: the Supports & loads switch reports the drawn layer, not the stored preference. */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, click, render } from '@/test/render.js';
import { resolve } from '@/i18n/registry';
import { useViewerStore, type ViewerState } from '@/store';
import { ClassVisibilityControls } from './ClassVisibilityMenu.js';

let initial: ViewerState;
beforeEach(() => { initial = useViewerStore.getState(); });
afterEach(() => {
  cleanup();
  act(() => useViewerStore.setState(initial, true));
});

/** The glyph row, found by its visible label. */
function glyphRow(): HTMLLabelElement {
  const row = [...document.querySelectorAll('label')]
    .find((label) => label.textContent?.startsWith(resolve('classVisibility.structuralGlyphs.label')));
  assert.ok(row, 'the Supports & loads row is mounted');
  return row;
}
const switchState = () => glyphRow().querySelector('[role="switch"]')?.getAttribute('aria-checked');

it('reads off and explains why while Physical masks the glyphs, and showing them leaves Physical', () => {
  act(() => useViewerStore.setState({
    structuralViewMode: 'physical',
    typeVisibility: { ...useViewerStore.getState().typeVisibility, structuralGlyphs: true },
  }));
  render(<ClassVisibilityControls />);
  assert.equal(switchState(), 'false', 'nothing draws in Physical, so the switch is off');
  assert.ok(glyphRow().textContent?.includes(resolve('classVisibility.structuralGlyphs.maskedHint')));

  const toggle = glyphRow().querySelector('[role="switch"]');
  assert.ok(toggle);
  click(toggle);
  assert.equal(useViewerStore.getState().structuralViewMode, 'both');
  assert.equal(useViewerStore.getState().typeVisibility.structuralGlyphs, true);
  assert.equal(switchState(), 'true');
  assert.ok(glyphRow().textContent?.includes(resolve('classVisibility.structuralGlyphs.description')), 'the hint goes with the mask');
});

it('keeps the plain toggle outside Physical', () => {
  act(() => useViewerStore.setState({
    structuralViewMode: 'analytical',
    typeVisibility: { ...useViewerStore.getState().typeVisibility, structuralGlyphs: true },
  }));
  render(<ClassVisibilityControls />);
  assert.equal(switchState(), 'true');
  const toggle = glyphRow().querySelector('[role="switch"]');
  assert.ok(toggle);
  click(toggle);
  assert.equal(useViewerStore.getState().typeVisibility.structuralGlyphs, false);
  assert.equal(useViewerStore.getState().structuralViewMode, 'analytical');
  assert.equal(switchState(), 'false');
});
