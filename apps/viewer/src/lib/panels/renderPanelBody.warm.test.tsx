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
import { cleanup, render } from '@/test/render';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { useViewerStore } from '@/store';
import { preloadDeferredPanel } from './deferred-panel-modules';
import { renderPanelBody } from './renderPanelBody';

const initial = useViewerStore.getState();
const hosts: ExtensionHostService[] = [];
afterEach(async () => {
  cleanup(); useViewerStore.setState(initial, true);
  await Promise.all(hosts.splice(0).map(host => host.dispose()));
});

for (const [id, accept] of [
  ['bcf', '.bcf,.bcfzip'], ['validation', '.ids,.xml'], ['lens', '.json'],
  ['gantt', '.xml,.csv,.txt'], ['lists', '.json'], ['extensions', '.iflx'],
] as const) {
  it(`#9742 a preloaded ${id} mounts its real content synchronously without a loading flash`, async () => {
    const bytes = readFileSync(new URL('../../../public/samples/building-architecture.ifc', import.meta.url));
    const ifcDataStore = await new IfcParser().parseColumnar(new Uint8Array(bytes).buffer);
    useViewerStore.setState({ ...fixtureModels({ ...fixtureModel('m'), ifcDataStore }), loading: false });
    const host = new ExtensionHostService({ sdk: createBimContext({ transport: {
      send: async () => { throw new Error('Warm panel fixture must not send an SDK request'); },
      subscribe: () => () => {}, close: () => {},
    } }) });
    hosts.push(host);
    // The real tour preload is allowed to complete before this panel ever mounts.
    await preloadDeferredPanel(id);
    const ui = render(<ExtensionHostContext.Provider value={host}>{renderPanelBody(id, () => {})}</ExtensionHostContext.Provider>);
    // Keep an intentional revert failure scalar instead of serializing a DOM graph.
    assert.ok(!ui.querySelector('output'), 'a warm module must never paint the loading shell');
    assert.ok(ui.querySelector(`input[type="file"][accept="${accept}"]`), 'real panel content is present in the first commit');
  });
}
