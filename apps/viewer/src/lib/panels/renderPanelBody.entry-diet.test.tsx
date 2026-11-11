/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { afterEach, it } from 'node:test';
import { readFileSync } from 'node:fs';
import type { ListDefinition } from '@ifc-lite/lists';
import { IfcParser } from '@ifc-lite/parser';
import { createBimContext } from '@ifc-lite/sdk';
import { ExtensionHostContext } from '@/sdk/ExtensionHostProvider';
import { ExtensionHostService } from '@/services/extensions/host';
import { cleanup, click, render, waitFor } from '@/test/render';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { useViewerStore } from '@/store';
import { resolve as translate } from '@/i18n/registry';
import { renderPanelBody } from './renderPanelBody';

const initial = useViewerStore.getState();
const hosts: ExtensionHostService[] = [];
const pendingDraft: ListDefinition = {
  id: 'pending-entry-diet', name: 'Draft requested before the Lists chunk', createdAt: 0, updatedAt: 0,
  entityTypes: [], groups: [], columns: [{ id: 'name', source: 'attribute', propertyName: 'Name' }],
};
afterEach(async () => {
  cleanup();
  useViewerStore.setState(initial, true);
  await Promise.all(hosts.splice(0).map(host => host.dispose()));
});

// #9742: exercise the shared router against actual cold feature modules.
for (const [id, load] of [
  ['gantt', () => import('@/components/viewer/schedule/GanttPanel')],
  ['lists', () => import('@/components/viewer/lists/ListPanel')],
  ['extensions', () => import('@/components/extensions/ExtensionsPanel')],
] as const) {
  it(`entry diet: ${id} mounts from cold and retains the action requested before readiness`, { timeout: 30_000 }, async () => {
    const bytes = readFileSync(new URL('../../../public/samples/building-architecture.ifc', import.meta.url));
    const ifcDataStore = await new IfcParser().parseColumnar(new Uint8Array(bytes).buffer);
    useViewerStore.setState({ ...fixtureModels({ ...fixtureModel('m'), ifcDataStore }), isMobile: false,
      extensionsRequestedView: id === 'extensions' ? 'ideas' : null,
      pendingListDraft: id === 'lists' ? pendingDraft : null, generateScheduleDialogOpen: id === 'gantt', loading: false });
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
    if (id === 'lists') assert.equal(useViewerStore.getState().pendingListDraft, pendingDraft, 'the loading shell preserves the queued draft');
    if (id === 'gantt') assert.equal(useViewerStore.getState().generateScheduleDialogOpen, true, 'the loading shell preserves the command request');
    await load();
    await waitFor(() => ui.querySelector('output') === null, 'real feature replaced the loading shell');
    if (id === 'lists') {
      // #9742: Search's draft hand-off must survive the production lazy boundary.
      await waitFor(() => ui.querySelector(`input[aria-label="${translate('lists.builder.nameInputLabel')}"]`) !== null, 'the queued draft opened the real builder');
      const name = ui.querySelector<HTMLInputElement>(`input[aria-label="${translate('lists.builder.nameInputLabel')}"]`);
      assert.equal(name?.value, pendingDraft.name, 'the requested draft, not a blank new list, was applied');
      assert.equal(useViewerStore.getState().pendingListDraft, null, 'the mounted builder consumed the one-shot request');
    } else if (id === 'gantt') {
      // #9742: schedule:generate queues this flag before Gantt can mount.
      await waitFor(() => document.body.querySelector('[role="dialog"]') !== null, 'the queued Generate schedule dialog opened');
      const dialog = document.body.querySelector('[role="dialog"]');
      assert.ok(dialog?.textContent?.includes(translate('schedule.generateDialog.title')));
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
