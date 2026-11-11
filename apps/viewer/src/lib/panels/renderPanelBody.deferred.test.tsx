/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { afterEach, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { IfcParser } from '@ifc-lite/parser';
import { cleanup, click, render, waitFor } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { resolve as translate } from '@/i18n/registry';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { renderPanelBody } from './renderPanelBody';
import { formFactorState } from '@/test/form-factor-state';

const initial = useViewerStore.getState();
afterEach(() => { cleanup(); useViewerStore.setState(initial, true); });

// All hosts (dock, float, pop-out), shortcuts and deep links use this router.
for (const [id, load] of [
  ['bcf', () => import('@/components/viewer/BCFPanel')],
  ['validation', () => import('@/components/viewer/validation/ValidationPanel')],
  ['lens', () => import('@/components/viewer/LensPanel')],
] as const) {
  it(`eager-JS diet: the real ${id} panel arrives on demand with a working close`, { timeout: 30_000 }, async () => {
    // Mount the feature against a real store, not a partial structural stub.
    const bytes = readFileSync(new URL('../../../public/samples/building-architecture.ifc', import.meta.url));
    const ifcDataStore = await new IfcParser().parseColumnar(new Uint8Array(bytes).buffer);
    useViewerStore.setState({ ...fixtureModels({ ...fixtureModel('m'), ifcDataStore }), ...formFactorState(false), loading: false });
    let closed = 0;
    const ui = render(renderPanelBody(id, () => { closed++; }));
    assert.ok(ui.querySelector('output'), 'cold routing paints a loading shell');
    // Do not hold act() open across a dynamic import; bound the observable
    // transition so a missing feature fails instead of pinning a fleet slot.
    await load();
    await waitFor(() => ui.querySelector('output') === null, 'the feature replaced the shell');
    // Storage notices can legitimately be alerts. Prove the feature's own
    // action is present instead of banning every alert in its subtree.
    const buttons = [...ui.querySelectorAll('button')];
    const featureAction = id === 'bcf'
      ? ui.querySelector('button[data-panel-action="bcf-import"]') !== null
      : buttons.some(button => button.textContent?.trim() === translate(id === 'validation'
        ? 'validationPanel.entry.newRuleSet' : 'lensPanel.newRuleLensButton'));
    assert.equal(featureAction, true, 'the actual feature action mounted');
    // Lens owns a custom header; select the accessible control, not a
    // PanelHeader implementation detail (review of #9634).
    const closeLabel = translate(id === 'lens' ? 'lensPanel.closeAriaLabel' : 'panelHeader.close');
    const close = [...ui.querySelectorAll('button')].find(button => button.getAttribute('aria-label') === closeLabel);
    assert.ok(close, 'loaded panel has its own close control');
    click(close);
    assert.equal(closed, 1);
  });
}
