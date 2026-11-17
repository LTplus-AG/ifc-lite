/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** What the 2D section control does to the drawing (#9026 items 15, 19): it only
 * clears the sheet while it opens the panel, so `useDrawingGeneration` sees the
 * panel open with nothing drawn. With the panel already open it never clears. */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Drawing2D } from '@ifc-lite/drawing-2d';
import { useViewerStore } from '@/store';
import { cleanup, click, render } from '@/test/render.js';
import { HudPopover } from '../../viewport-ui/hud';
import { SectionActivePlaneRow } from './SectionActivePlaneRow';

const SHEET = { lines: [], cutPolygons: [] } as unknown as Drawing2D;
const control = (root: HTMLElement) => root.querySelector<HTMLElement>('[aria-label="2D section"]');
const mount = () => render(<HudPopover><SectionActivePlaneRow /></HudPopover>); // The toolbar owns the Cap popover.
const closed = { drawing2DPanelVisible: false, floatingPanels: [], poppedOutIds: [] };

describe('the 2D section control', () => {
  beforeEach(() => useViewerStore.setState({ activeTool: 'section', drawing2D: SHEET, drawing2DStatus: 'ready', ...closed }));
  afterEach(() => { cleanup(); useViewerStore.setState({ drawing2D: null, drawing2DStatus: 'idle', ...closed }); });

  it('clears the sheet as it opens the panel', () => {
    const ui = mount();
    click(control(ui)!);
    const s = useViewerStore.getState();
    assert.equal(s.drawing2D, null);
    assert.equal(s.drawing2DPanelVisible, true);
  });

  const opened: ReadonlyArray<readonly [string, () => void]> = [
    ['docked', () => useViewerStore.setState({ drawing2DPanelVisible: true })],
    ['floating', () => {
      useViewerStore.getState().floatPanel('drawing');
      assert.ok(useViewerStore.getState().floatingPanels.some((p) => p.id === 'drawing'));
    }],
    ['popped out', () => useViewerStore.setState({ poppedOutIds: ['drawing'] })],
  ];
  for (const [how, open] of opened) {
    it(`leaves the sheet alone while the panel is ${how}: nothing is left empty without a request`, () => {
      open();
      const ui = mount();
      click(control(ui)!);
      assert.equal(useViewerStore.getState().drawing2D, SHEET);
    });
  }
});
