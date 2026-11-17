/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #8802 R3b: docked in the bottom strip, the Drawing's cut label and actions
 *  move into the strip's tab row (its header slot) instead of stacking a
 *  second title row under the tab; outside the strip (floating, popped out)
 *  they keep their own row. */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { render, cleanup } from '@/test/render';
import { useViewerStore } from '@/store';
import { BottomStripHeaderSlotContext } from '../bottom-strip-header-slot';
import { DrawingPanel } from './DrawingPanel';

beforeEach(() => {
  const s = useViewerStore.getState();
  useViewerStore.setState({
    activeTool: 'select', drawing2D: null, drawing2DStatus: 'idle', drawing2DPanelVisible: true,
    annotation2DActiveTool: 'none', inactiveSectionPlanes: [],
    sectionPlane: { ...s.sectionPlane, axis: 'down', position: 50, enabled: true, custom: undefined, parked: false },
  } as Partial<ReturnType<typeof useViewerStore.getState>>);
});
afterEach(() => cleanup());

it('portals the cut menu and actions into the strip header slot', () => {
  const slot = document.createElement('div');
  document.body.appendChild(slot);
  const ui = render(
    <BottomStripHeaderSlotContext.Provider value={slot}>
      <DrawingPanel />
    </BottomStripHeaderSlotContext.Provider>,
  );
  // Primitive asserts only: a failing assert on a happy-dom node inspects the whole DOM.
  assert.equal(ui.querySelector('[data-drawing-header]') === null, true, 'no title row inside the panel');
  const header = slot.querySelector('[data-drawing-header]');
  assert.ok(header, 'the header is in the slot');
  const cut = header!.querySelector('[aria-label^="Section source:"]');
  assert.ok(cut, 'with the cut menu');
  assert.equal(cut!.textContent, 'Cut plane: Down 50%', 'a labelled cut, without a trailing .0');
  assert.ok(header!.querySelector('[aria-label="Export"]'), 'and the Export menu');
  assert.ok(header!.querySelector('[aria-label="Regenerate"]'), 'and Regenerate');
  // The toolbar is the panel's first row.
  assert.ok(ui.querySelector('[role="radiogroup"]'), 'the toolbar stays in the panel');
  slot.remove();
});

it('outside the strip it draws its own header row', () => {
  const ui = render(<DrawingPanel />);
  const header = ui.querySelector('[data-drawing-header]');
  assert.ok(header, 'its own row');
  assert.ok(header!.querySelector('[aria-label="Export"]'));
  assert.doesNotMatch(header!.textContent ?? '', /^Drawing/, 'the panel title is the host\'s, not repeated here');
});
