/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, it } from 'node:test';
import { act } from 'react';
import { cleanup, click, render } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { renderPanelBody } from './renderPanelBody';

const initial = useViewerStore.getState();
afterEach(() => { cleanup(); useViewerStore.setState(initial, true); });

// All hosts (dock, float, pop-out), shortcuts and deep links use this router.
for (const [id, load] of [
  ['bcf', () => import('@/components/viewer/BCFPanel')],
  ['validation', () => import('@/components/viewer/validation/ValidationPanel')],
  ['lens', () => import('@/components/viewer/LensPanel')],
] as const) {
  it(`eager-JS diet: the real ${id} panel arrives on demand with a working close`, async () => {
    useViewerStore.setState({ ...fixtureModels(fixtureModel('m')), isMobile: false, loading: false });
    let closed = 0;
    const ui = render(renderPanelBody(id, () => { closed++; }));
    assert.ok(ui.querySelector('[role="status"]'), 'cold routing paints a loading shell');
    await act(async () => { await load(); });
    assert.equal(ui.querySelector('[role="status"]'), null, 'the feature replaced the shell');
    assert.equal(ui.querySelector('[role="alert"]'), null, 'the actual feature mounted');
    const close = ui.querySelector('button[data-panel-close]');
    assert.ok(close, 'loaded panel has its own close control');
    click(close);
    assert.equal(closed, 1);
  });
}
