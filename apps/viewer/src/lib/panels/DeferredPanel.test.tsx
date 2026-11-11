/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, it } from 'node:test';
import { act, lazy, useState } from 'react';
import { cleanup, click, render } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { DeferredPanel } from './DeferredPanel';
import { resolve as translate } from '@/i18n/registry';

// Independent expectations: a swapped registry mapping must fail these cases.
const titleKeys = { bcf: 'bcf.panel.title', validation: 'validationPanel.title', lens: 'lensPanel.title' } as const;
const initial = useViewerStore.getState();
afterEach(() => { cleanup(); useViewerStore.setState(initial, true); });

// Eager-JS diet: a delayed chunk must not leave a blank or undismissible panel.
for (const mobile of [false, true]) {
  for (const id of ['bcf', 'validation', 'lens'] as const) {
    it(`${mobile ? 'mobile' : 'desktop'} ${id} shows loading, remains closable, and mounts an interactive cold chunk`, async () => {
      useViewerStore.setState({ isMobile: mobile });
      let complete!: (module: { default: typeof Feature }) => void;
      const pending = new Promise<{ default: typeof Feature }>(resolve => { complete = resolve; });
      function Feature() {
        const [used, setUsed] = useState(false);
        return <button onClick={() => setUsed(true)}>{used ? 'Used feature' : 'Use feature'}</button>;
      }
      const Cold = lazy(() => pending);
      let closed = 0;
      const ui = render(<DeferredPanel id={id} onClose={() => { closed++; }}><Cold /></DeferredPanel>);
      assert.ok(ui.querySelector('output'));
      assert.ok(ui.textContent?.includes(translate(titleKeys[id])), 'pending shell retains its title on every layout');
      const close = ui.querySelector('button[aria-label="Close"]');
      assert.ok(close);
      click(close);
      assert.equal(closed, 1);
      await act(async () => { complete({ default: Feature }); await pending; });
      assert.equal(ui.querySelector('output') === null, true);
      click(ui.querySelector('button')!);
      assert.match(ui.textContent ?? '', /Used feature/);
    });
  }
}

for (const mobile of [false, true]) {
  for (const id of ['bcf', 'validation', 'lens'] as const) {
    it(`${mobile ? 'mobile' : 'desktop'} ${id} chunk failure keeps a close control and does not poison a different deferred panel`, async () => {
      useViewerStore.setState({ isMobile: mobile });
      const Failed = lazy(async () => { throw new Error('Failed to fetch dynamically imported module: panel.js'); });
      let closed = 0;
      function Host() {
        const [switched, setSwitched] = useState(false);
        return <><button onClick={() => setSwitched(true)}>Switch</button>
          <DeferredPanel id={switched ? (id === 'lens' ? 'bcf' : 'lens') : id} onClose={() => { closed++; }}>
            {switched ? <p>Healthy feature</p> : <Failed />}
          </DeferredPanel></>;
      }
      const ui = render(<Host />);
      await act(async () => { await Promise.resolve(); });
      assert.ok(ui.querySelector('[role="alert"]'));
      assert.ok(ui.textContent?.includes(translate(titleKeys[id])), 'failed shell retains its title');
      click(ui.querySelector('button[aria-label="Close"]')!);
      assert.equal(closed, 1);
      click(ui.querySelector('button')!);
      assert.equal(ui.querySelector('[role="alert"]') === null, true);
      assert.match(ui.textContent ?? '', /Healthy feature/);
    });
  }
}
