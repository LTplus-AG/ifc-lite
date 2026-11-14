/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { act, useState } from 'react';
import { cleanup, click, render } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { classifyFormFactor } from '@/lib/layout/form-factor';
import { MobilePanelHost, MobilePaneSlotProvider } from './MobilePanelHost';

const original = useViewerStore.getState().formFactor;
afterEach(() => {
  cleanup();
  useViewerStore.getState().setFormFactor(original);
});

function PanelDraft() {
  const [count, setCount] = useState(0);
  return <button onClick={() => setCount(count + 1)}>Draft {count}</button>;
}

it('#9718 keeps child-local draft state and the scroll node across sheet, pane and fold hosts', () => {
  const setSize = (width: number, height: number, folded = false) => act(() => {
    useViewerStore.getState().setFormFactor(classifyFormFactor({ width, height, coarsePointer: true,
      segments: folded ? [{ x: 0, y: 0, width: 412, height: 470 }, { x: 0, y: 490, width: 412, height: 470 }] : null }));
  });
  setSize(412, 960);
  function Shell() {
    const [slot, setSlot] = useState<HTMLDivElement | null>(null);
    return <MobilePaneSlotProvider value={slot}>
      <div data-view><MobilePanelHost title="Properties" onClose={() => {}}><PanelDraft /></MobilePanelHost></div>
      <div ref={setSlot} data-slot />
    </MobilePaneSlotProvider>;
  }
  const ui = render(<Shell />);
  const draft = [...ui.querySelectorAll('button')].find(b => b.textContent === 'Draft 0');
  assert.ok(draft);
  click(draft);
  const scroll = ui.querySelector<HTMLElement>('[data-mobile-panel-scroll]');
  assert.ok(scroll);
  scroll.scrollTop = 127;
  for (const [width, height, folded] of [[960, 412, false], [412, 960, true], [412, 960, false]] as const) {
    setSize(width, height, folded);
    assert.equal(draft.isConnected, true);
    assert.equal(draft.textContent, 'Draft 1');
    assert.equal(ui.querySelector('[data-mobile-panel-scroll]') === scroll, true);
    assert.equal(scroll.scrollTop, 127);
    const parent = ui.querySelector(width > height || folded ? '[data-slot]' : '[data-view]');
    assert.equal(parent?.contains(draft), true);
  }
});
