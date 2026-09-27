/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The side-by-side 2D/3D layout preset (#5515): the bottom strip's
 * "dock beside" toggle appears only on the Drawing tab, flips the reported
 * orientation, and — while docked to the side — the strip drops its own
 * fixed height and row-resize handle, because that sizing then belongs to
 * the host `Panel`/resize-handle `ViewerLayout` wraps it in, not to this
 * component (which still owns everything else: tabs, maximize, Close).
 */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { act, useRef } from 'react';
import { cleanup, click, render } from '@/test/render.js';
import { installLayout } from '@/test/dom-layout.js';
import { useViewerStore } from '@/store';
import { usePanelControls } from '@/hooks/usePanelControls';
import { bottomPanelFlags } from '@/lib/panels/bottom-panels';
import type { BottomPanelId } from '@/lib/panels/bottom-panels';
import {
  loadBottomStripOrientation,
  persistBottomStripOrientation,
  type BottomStripOrientation,
} from '@/lib/panels/bottom-strip-persistence';
import { BottomStrip } from './BottomStrip';

installLayout();

function Harness({
  dockedPanel,
  orientation,
  onToggleOrientation,
}: {
  dockedPanel: BottomPanelId;
  orientation: BottomStripOrientation;
  onToggleOrientation: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { closePanel } = usePanelControls();
  return (
    <div ref={containerRef} style={{ height: 800 }}>
      <BottomStrip
        dockedPanel={dockedPanel}
        analysisExtension={null}
        containerRef={containerRef}
        closePanel={closePanel}
        orientation={orientation}
        onToggleOrientation={onToggleOrientation}
      />
    </div>
  );
}

function seed(patch: Partial<ReturnType<typeof useViewerStore.getState>>): void {
  useViewerStore.setState({ ...bottomPanelFlags(null), floatingPanels: [], poppedOutIds: [], ...patch });
}

beforeEach(() => {
  window.localStorage.clear();
  seed({});
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

it('the dock-beside toggle appears only on the Drawing tab, and clicking it calls the handler', async () => {
  seed(bottomPanelFlags('lists'));
  let toggled = 0;
  const ui = render(
    <Harness dockedPanel="lists" orientation="bottom" onToggleOrientation={() => { toggled += 1; }} />,
  );
  await act(async () => {});
  assert.equal(
    ui.querySelector('button[aria-label="Dock beside 3D view"]'),
    null,
    'Lists has no side-by-side control — it is Drawing-only',
  );

  cleanup();
  seed(bottomPanelFlags('drawing'));
  const ui2 = render(
    <Harness dockedPanel="drawing" orientation="bottom" onToggleOrientation={() => { toggled += 1; }} />,
  );
  await act(async () => {});
  const toggle = ui2.querySelector('button[aria-label="Dock beside 3D view"]');
  assert.ok(toggle, 'Drawing offers the side-by-side control');
  click(toggle!);
  assert.equal(toggled, 1, 'clicking it invokes the handler exactly once');
});

it('side orientation drops the strip\'s own height and row-resize handle; bottom orientation keeps them', async () => {
  seed(bottomPanelFlags('drawing'));
  const ui = render(<Harness dockedPanel="drawing" orientation="side" onToggleOrientation={() => {}} />);
  await act(async () => {});
  const sideStrip = ui.querySelector('[data-detach-root]') as HTMLElement;
  assert.equal(sideStrip.style.height, '', 'side mode fills its host Panel instead of sizing itself');
  assert.equal(ui.querySelector('.cursor-row-resize'), null, 'no row-resize handle while docked to the side');
  assert.ok(
    ui.querySelector('button[aria-label="Dock below 3D view"]'),
    'the toggle label reflects the current side (side -> offers dock below)',
  );

  cleanup();
  seed(bottomPanelFlags('drawing'));
  const ui2 = render(<Harness dockedPanel="drawing" orientation="bottom" onToggleOrientation={() => {}} />);
  await act(async () => {});
  const bottomStrip = ui2.querySelector('[data-detach-root]') as HTMLElement;
  assert.notEqual(bottomStrip.style.height, '', 'bottom mode keeps its own fixed, resizable height');
  assert.ok(ui2.querySelector('.cursor-row-resize'), 'the row-resize handle is back');
});

it('the dock-side preference round-trips through persistence, independent of any mounted strip', () => {
  assert.equal(loadBottomStripOrientation(), 'bottom', 'default is bottom-docked');
  persistBottomStripOrientation('side');
  assert.equal(loadBottomStripOrientation(), 'side', 'persists and reloads the chosen side');
  persistBottomStripOrientation('bottom');
  assert.equal(loadBottomStripOrientation(), 'bottom', 'and back');
});
