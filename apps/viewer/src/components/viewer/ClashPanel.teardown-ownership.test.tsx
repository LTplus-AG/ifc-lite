/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5829: closing the Clash panel must release only the isolation / ghost that
 * clash itself installed. It used to call `clearIsolation()` and
 * `clearGhost()` unconditionally, so a user who isolated a storey (or set an
 * X-ray) and then opened and closed Clash lost it. Runs already follow the
 * owner-scoped rule (`useClash` discardSolidPresentation); the teardown now
 * does too. Ids span two models (the second offset), as a federation's do.
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useViewerStore } from '@/store';
import { ClashPanel } from './ClashPanel.js';

Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { get: () => 800, configurable: true });
Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { get: () => 600, configurable: true });

/** Global ids from model A (offset 0) and model B (offset 1000). */
const IDS = [3, 7, 1003, 1007];

async function openAndClose(): Promise<void> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  await act(async () => { root.render(<ClashPanel />); });
  await act(async () => root.unmount());
  container.remove();
}

afterEach(() => {
  useViewerStore.setState({ isolatedEntities: null, ghostExceptEntities: null, clashVisibilityOwned: null });
});

describe('ClashPanel unmount releases only clash-owned visibility (#5829)', () => {
  it("keeps an isolation clash did not install", async () => {
    useViewerStore.setState({ isolatedEntities: new Set(IDS), clashVisibilityOwned: null });
    await openAndClose();
    assert.deepEqual([...useViewerStore.getState().isolatedEntities ?? []], IDS);
  });

  it("keeps a ghost (X-ray) clash did not install", async () => {
    useViewerStore.setState({ ghostExceptEntities: new Set(IDS), clashVisibilityOwned: null });
    await openAndClose();
    assert.deepEqual([...useViewerStore.getState().ghostExceptEntities ?? []], IDS);
  });

  it('still releases the isolation clash itself installed', async () => {
    const own = new Set(IDS);
    useViewerStore.setState({ isolatedEntities: own, clashVisibilityOwned: { channel: 'isolate', ids: new Set(IDS) } });
    await openAndClose();
    const s = useViewerStore.getState();
    assert.equal(s.isolatedEntities, null, 'the clash focus isolation must not outlive the panel');
    assert.equal(s.clashVisibilityOwned, null);
  });
});
