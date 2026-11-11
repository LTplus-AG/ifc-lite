/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, it } from 'node:test';
import { act, useState } from 'react';
import { cleanup, click, render } from '@/test/render';
import { useViewerStore } from '@/store';
import { DeferredPanel, type DeferredPanelLoader } from './DeferredPanel';

const initial = useViewerStore.getState();
afterEach(() => { cleanup(); useViewerStore.setState(initial, true); });

for (const mobile of [false, true]) for (const id of ['bcf', 'validation', 'lens', 'gantt', 'lists', 'extensions'] as const) {
  it(`#9742 ${mobile ? 'mobile' : 'desktop'} ${id} loads without suspending and preserves its mounted state`, async () => {
    useViewerStore.setState({ isMobile: mobile });
    function Feature() {
      const [count, setCount] = useState(0);
      return <button onClick={() => setCount(value => value + 1)}>Feature {count}</button>;
    }
    let resolve!: (module: { default: typeof Feature }) => void;
    const pending = new Promise<{ default: typeof Feature }>(done => { resolve = done; });
    const load = () => pending;
    let closed = 0;
    function Host() {
      const [parentCount, setParentCount] = useState(0);
      return <><button onClick={() => setParentCount(value => value + 1)}>Parent {parentCount}</button>
        <DeferredPanel id={id} onClose={() => { closed++; }} load={load} /></>;
    }
    const ui = render(<Host />);
    assert.ok(ui.querySelector('output[aria-live="polite"]'), 'pending body announces its loading state');
    const close = ui.querySelector('button[aria-label="Close"]');
    assert.ok(close); click(close); assert.equal(closed, 1);
    await act(async () => { resolve({ default: Feature }); await pending; });
    const feature = [...ui.querySelectorAll('button')].find(button => button.textContent === 'Feature 0');
    assert.ok(feature, 'settled import commits through ordinary state without waiting for a Suspense reveal');
    click(feature);
    click([...ui.querySelectorAll('button')].find(button => button.textContent === 'Parent 0')!);
    assert.equal(feature.isConnected, true, 'parent renders do not switch the component type and remount it');
    assert.equal(feature.textContent, 'Feature 1');
    assert.equal(ui.querySelector('output'), null);
  });
}

for (const mobile of [false, true]) {
  it(`#9742 ${mobile ? 'mobile' : 'desktop'} loader rejection remains contained and closable`, async () => {
    useViewerStore.setState({ isMobile: mobile });
    let reject!: (error: Error) => void;
    const pending = new Promise<never>((_resolve, fail) => { reject = fail; });
    const load: DeferredPanelLoader = () => pending;
    let closed = 0;
    const ui = render(<DeferredPanel id="gantt" onClose={() => { closed++; }} load={load} />);
    await act(async () => { reject(new Error('Failed to fetch dynamically imported module: panel.js')); await assert.rejects(pending, /Failed to fetch dynamically imported module/); });
    assert.ok(ui.querySelector('[role="alert"]'));
    const close = ui.querySelector('button[aria-label="Close"]'); assert.ok(close); click(close);
    assert.equal(closed, 1);
  });
}

it('#9742 a host-owned header remains the sole exit through loading and failure', async () => {
  const { PanelHostHeaderContext } = await import('./DeferredPanel');
  assert.ok(PanelHostHeaderContext, 'host header ownership must be explicit');
  let reject!: (error: Error) => void;
  const pending = new Promise<never>((_resolve, fail) => { reject = fail; });
  let closed = 0;
  const ui = render(<div><h2>Schedule</h2><button aria-label="Close" onClick={() => { closed++; }}>Close</button>
    <PanelHostHeaderContext.Provider value={true}><DeferredPanel id="gantt" onClose={() => { closed++; }} load={() => pending} /></PanelHostHeaderContext.Provider>
  </div>);
  assert.ok(ui.querySelector('output[aria-live="polite"]'));
  assert.equal(ui.querySelectorAll('button[aria-label="Close"]').length, 1);
  await act(async () => { reject(new Error('Failed to fetch dynamically imported module: panel.js')); await assert.rejects(pending, /Failed to fetch dynamically imported module/); });
  assert.ok(ui.querySelector('[role="alert"]'));
  assert.equal(ui.querySelectorAll('button[aria-label="Close"]').length, 1);
  assert.ok([...ui.querySelectorAll('button')].some(button => button.textContent?.includes('Reload')), 'chunk boundary retains its reload action');
  click(ui.querySelector('button[aria-label="Close"]')!); assert.equal(closed, 1);
});
