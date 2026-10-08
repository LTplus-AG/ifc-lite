/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { render, cleanup, advance, click } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { newFlowDocument } from '@/lib/flow/persistence';
import { readStartupFlowId, saveStartupFlowId } from '@/lib/flow/startup-preference';
import { FlowStartupPrompt } from './FlowStartupPrompt';
import { FlowStartupPreference } from './FlowStartupPreference';

afterEach(cleanup);

describe('startup workflow UI (#6612)', () => {
  it('opt-in offers once, waits behind a modal and opens Player without running', async () => {
    const doc = newFlowDocument('Startup review');
    localStorage.clear();
    useViewerStore.setState({ savedFlows: [{ doc, updatedAt: 1 }], activeFlowId: doc.id,
      flowDoc: doc, flowRunning: false, flowLastRun: null, flowPanelVisible: false });
    const preference = render(<FlowStartupPreference />);
    const checkbox = preference.querySelector('input'); assert.ok(checkbox);
    click(checkbox);
    assert.equal(readStartupFlowId(), doc.id);
    cleanup();
    useViewerStore.setState({ activeFlowId: null, flowDoc: null });
    const blocker = document.createElement('div'); blocker.setAttribute('role', 'dialog'); document.body.appendChild(blocker);
    render(<FlowStartupPrompt />);
    await advance(550);
    assert.equal(document.body.textContent?.includes('Open your saved workflow?'), false);
    blocker.remove();
    await advance(550);
    const open = [...document.body.querySelectorAll('button')].find((button) => button.textContent === 'Open workflow');
    assert.ok(open); click(open);
    assert.equal(useViewerStore.getState().activeFlowId, doc.id);
    assert.equal(useViewerStore.getState().flowPanelVisible, true);
    assert.equal(useViewerStore.getState().flowView, 'player');
    assert.equal(useViewerStore.getState().flowRunning, false);
    assert.equal(useViewerStore.getState().flowLastRun, null);
    cleanup();
    useViewerStore.setState({ activeFlowId: null, flowDoc: null });
    saveStartupFlowId(doc.id);
    render(<FlowStartupPrompt />);
    await advance(550);
    assert.equal(document.body.textContent?.includes('Open your saved workflow?'), false);
  });
});
