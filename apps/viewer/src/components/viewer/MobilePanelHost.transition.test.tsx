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
import { moveMobilePanel } from './move-mobile-panel';
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
    if (width > height || folded) assert.equal(ui.querySelector('[role="region"]')?.getAttribute('aria-label'), 'Properties');
  }
});

// Model the browser's native blur on ordinary removal: happy-dom does not blur
// on appendChild, so an uninstrumented focus assertion would miss this defect.
it('#9718 restores input focus and selection on the appendChild fallback', () => {
  const source = document.createElement('div');
  const target = document.createElement('div');
  const container = document.createElement('div');
  const input = document.createElement('input');
  input.value = 'panel draft';
  container.appendChild(input);
  source.appendChild(container);
  document.body.append(source, target);
  const append = target.appendChild.bind(target);
  Object.defineProperty(target, 'moveBefore', { value: undefined, configurable: true });
  target.appendChild = <T extends Node>(child: T): T => {
    input.blur();
    input.setSelectionRange(0, 0);
    return append(child);
  };
  try {
    input.focus();
    input.setSelectionRange(2, 7, 'backward');
    moveMobilePanel(target, container);
    assert.equal(document.activeElement === input, true);
    assert.deepEqual([input.selectionStart, input.selectionEnd, input.selectionDirection], [2, 7, 'backward']);
    assert.equal(target.contains(input), true);
  } finally {
    source.remove();
    target.remove();
  }
});
