/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { afterEach, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { IfcParser } from '@ifc-lite/parser';
import { createBimContext } from '@ifc-lite/sdk';
import { ExtensionHostContext } from '@/sdk/ExtensionHostProvider';
import { ExtensionHostService } from '@/services/extensions/host';
import { cleanup, click, render, waitFor } from '@/test/render';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { useViewerStore } from '@/store';
import { resolve as translate } from '@/i18n/registry';
import { renderPanelBody } from './renderPanelBody';
import { loadGanttPanel, loadListPanel, loadExtensionsPanel } from './deferred-panel-modules';

const initial = useViewerStore.getState();
const hosts: ExtensionHostService[] = [];
afterEach(async () => {
  cleanup();
  useViewerStore.setState(initial, true);
  await Promise.all(hosts.splice(0).map(host => host.dispose()));
});

// Entry diet: exercise the shared router against actual cold feature modules.
for (const [id, load] of [['gantt', loadGanttPanel], ['lists', loadListPanel], ['extensions', loadExtensionsPanel]] as const) {
  it(`entry diet: ${id} mounts from cold and retains the action requested before readiness`, { timeout: 30_000 }, async () => {
    const bytes = readFileSync(new URL('../../../public/samples/building-architecture.ifc', import.meta.url));
    const ifcDataStore = await new IfcParser().parseColumnar(new Uint8Array(bytes).buffer);
    useViewerStore.setState({ ...fixtureModels({ ...fixtureModel('m'), ifcDataStore }), isMobile: false,
      extensionsRequestedView: id === 'extensions' ? 'ideas' : null, loading: false });
    const host = new ExtensionHostService({ sdk: createBimContext({ transport: {
      send: async () => { throw new Error('This panel fixture must not send an SDK request'); },
      subscribe: () => () => {}, close: () => {},
    } }) });
    hosts.push(host);
    let closed = 0;
    const ui = render(<ExtensionHostContext.Provider value={host}>
      {renderPanelBody(id, () => { closed++; })}
    </ExtensionHostContext.Provider>);
    assert.ok(ui.querySelector('output'), 'a cold feature first retains its loading shell');
    await load();
    await waitFor(() => ui.querySelector('output') === null, 'real feature replaced the loading shell');
    if (id === 'lists') {
      const add = [...ui.querySelectorAll('button')].find(b => b.textContent?.includes(translate('lists.panel.newList')));
      assert.ok(add, 'Lists authoring is ready');
      click(add);
      await waitFor(() => ui.querySelector(`input[aria-label="${translate('lists.builder.nameInputLabel')}"]`) !== null, 'the real list builder mounted');
    } else if (id === 'gantt') {
      assert.ok(ui.querySelector('input[type="file"][accept=".xml,.csv,.txt"]'), 'schedule file import is ready');
    } else {
      await waitFor(() => useViewerStore.getState().extensionsRequestedView === null, 'deep-link request consumed on mount');
      assert.equal(ui.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.includes('Ideas'), true);
      const close = ui.querySelector(`button[aria-label="${translate('extensionsFlavors.extensionsPanel.closeAriaLabel')}"]`);
      assert.ok(close);
      click(close);
      assert.equal(closed, 1);
    }
  });
}
