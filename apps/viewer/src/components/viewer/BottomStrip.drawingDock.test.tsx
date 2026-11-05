/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The docked Drawing gets room to be read (#8802 R3b): until the user
 * resizes the strip while the Drawing shows, it takes half of the layout
 * container instead of the 300 px every other bottom panel opens at; the
 * height the user drags it to is remembered for the Drawing alone; and the
 * Drawing's cut label and actions sit in the strip's tab row, not in a
 * second title row under it.
 */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { act, useRef } from 'react';
import { cleanup, mouseDown, render } from '@/test/render.js';
import { installLayout } from '@/test/dom-layout.js';
import { useViewerStore } from '@/store';
import { usePanelControls } from '@/hooks/usePanelControls';
import { bottomPanelFlags, type BottomPanelId } from '@/lib/panels/bottom-panels';
import {
  BOTTOM_STRIP_DEFAULT_HEIGHT,
  loadBottomStripDrawingHeight,
  loadBottomStripHeight,
} from '@/lib/panels/bottom-strip-persistence';
import { BottomStrip } from './BottomStrip';

installLayout(); // every element reports an 800 px clientHeight

function Harness({ dockedPanel }: { dockedPanel: BottomPanelId }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { closePanel } = usePanelControls();
  return (
    <div ref={containerRef} style={{ height: 800 }}>
      <BottomStrip dockedPanel={dockedPanel} analysisExtension={null} containerRef={containerRef} closePanel={closePanel} />
    </div>
  );
}

function seed(panel: BottomPanelId): void {
  useViewerStore.setState({ ...bottomPanelFlags(panel), floatingPanels: [], poppedOutIds: [], documents: [], activeDocumentId: null, listDefinitions: [] });
}

const stripOf = (ui: HTMLElement) => ui.querySelector('[data-detach-root]') as HTMLElement;
const px = (el: HTMLElement) => Number.parseFloat(el.style.height);

async function drag(ui: HTMLElement, fromY: number, toY: number): Promise<void> {
  mouseDown(ui.querySelector('.cursor-row-resize')!, { clientY: fromY });
  await act(async () => { document.dispatchEvent(new window.MouseEvent('mousemove', { clientY: toY, bubbles: true })); });
  await act(async () => { document.dispatchEvent(new window.MouseEvent('mouseup', { clientY: toY, bubbles: true })); });
}

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

it('a docked Drawing opens at half of the layout; other bottom panels keep the 300 px default', async () => {
  seed('drawing');
  const ui = render(<Harness dockedPanel="drawing" />);
  await act(async () => {});
  assert.equal(px(stripOf(ui)), 400, 'half of the 800 px container');

  cleanup();
  seed('lists');
  const ui2 = render(<Harness dockedPanel="lists" />);
  await act(async () => {});
  assert.equal(px(stripOf(ui2)), BOTTOM_STRIP_DEFAULT_HEIGHT, 'Lists keeps the shared default');
});

it("the Drawing's resized height is remembered apart from the shared one", async () => {
  seed('drawing');
  const ui = render(<Harness dockedPanel="drawing" />);
  await act(async () => {});
  await drag(ui, 400, 350); // 50 px taller
  assert.equal(px(stripOf(ui)), 450, 'the drag grew the Drawing strip');
  assert.equal(loadBottomStripDrawingHeight(), 450, "persisted as the Drawing's height");
  assert.equal(loadBottomStripHeight(), BOTTOM_STRIP_DEFAULT_HEIGHT, 'the shared height is untouched');

  cleanup();
  seed('lists');
  const ui2 = render(<Harness dockedPanel="lists" />);
  await act(async () => {});
  assert.equal(px(stripOf(ui2)), BOTTOM_STRIP_DEFAULT_HEIGHT, 'Lists still opens at the shared height');

  cleanup();
  seed('drawing');
  const ui3 = render(<Harness dockedPanel="drawing" />);
  await act(async () => {});
  assert.equal(px(stripOf(ui3)), 450, 'the Drawing reopens at the height the user chose');
});

it("a live Reset layout forgets the Drawing's height", async () => {
  seed('drawing');
  const ui = render(<Harness dockedPanel="drawing" />);
  await act(async () => {});
  await drag(ui, 400, 300);
  assert.equal(px(stripOf(ui)), 500);
  act(() => useViewerStore.getState().bumpLayoutResetEpoch());
  await act(async () => {});
  assert.equal(loadBottomStripDrawingHeight(), null, 'the remembered Drawing height is cleared');
  assert.equal(px(stripOf(ui)), 400, 'the strip returns to half of the layout');
});

it('the tab row carries a header slot for the docked panel, between the tabs and the strip controls', async () => {
  seed('drawing');
  const ui = render(<Harness dockedPanel="drawing" />);
  await act(async () => {});
  const slot = ui.querySelector('[data-bottom-strip-header-slot]');
  assert.ok(slot, 'the slot is rendered');
  const row = slot!.parentElement!;
  assert.ok(row.querySelector('[role="tablist"]'), 'in the same row as the tabs');
  assert.ok(row.querySelector('[aria-label="Close"]'), 'and the strip controls');
  // Its content (the Drawing's header) is covered by DrawingPanel.headerSlot.test.tsx.
});
