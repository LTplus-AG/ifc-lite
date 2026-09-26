/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Dragging a free panel by its header stops at the toolbar bottom (#5957).
 * The drag clamp floored y at 0, so a header dragged up was dropped under the
 * z-50 toolbar, where nothing could grab it again (the #1245 class).
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { render, cleanup, mouseDown } from '@/test/render.js';
import type { FloatingPanelState } from '@/store';
import { FloatingPanel } from './FloatingPanel';

afterEach(cleanup);

const PANEL: FloatingPanelState = { id: 'properties', snap: 'free', x: 100, y: 200, w: 360, h: 300 };
const AREA = { width: 1280, height: 800, top: 48 };

function mount(onRect: (r: Partial<FloatingPanelState>) => void): HTMLElement {
  const root = render(
    <FloatingPanel
      panel={PANEL}
      title="Properties"
      zIndex={30}
      bounds={null}
      area={AREA}
      onRect={onRect}
      onSnap={() => {}}
      onFocus={() => {}}
      onDock={() => {}}
      onClose={() => {}}
    >
      <div />
    </FloatingPanel>,
  );
  const header = root.querySelector('.cursor-move');
  assert.ok(header, 'title bar (drag handle) rendered');
  return header as HTMLElement;
}

function moveTo(clientX: number, clientY: number): void {
  act(() => {
    window.dispatchEvent(new window.MouseEvent('mousemove', { clientX, clientY }));
  });
}

describe('FloatingPanel header drag (#5957)', () => {
  it('never drops the header above the toolbar bottom', () => {
    const rects: Array<Partial<FloatingPanelState>> = [];
    const header = mount((r) => rects.push(r));
    mouseDown(header, { clientX: 300, clientY: 300 });
    moveTo(300, -500); // far above the window top
    act(() => { window.dispatchEvent(new window.MouseEvent('mouseup')); });
    const last = rects[rects.length - 1];
    assert.equal(last.y, AREA.top, 'the header stops at the toolbar bottom, not under it');
  });

  it('still follows the pointer below the toolbar', () => {
    const rects: Array<Partial<FloatingPanelState>> = [];
    const header = mount((r) => rects.push(r));
    mouseDown(header, { clientX: 300, clientY: 300 });
    moveTo(300, 420);
    act(() => { window.dispatchEvent(new window.MouseEvent('mouseup')); });
    const last = rects[rects.length - 1];
    // happy-dom has no layout, so the drag starts from y = 0; 120px down is y = 120.
    assert.equal(last.y, 120, 'y follows the pointer delta below the toolbar');
  });
});
