/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';
import { act, useState } from 'react';
import { createBimContext } from '@ifc-lite/sdk';
import type { GeometryResult } from '@ifc-lite/geometry';
import { BimReactContext } from '@/sdk/BimProvider';
import { ExtensionHostContext } from '@/sdk/ExtensionHostProvider';
import { ExtensionHostService } from '@/services/extensions/host';
import { setLocale } from '@/i18n';
import { useViewerStore } from '@/store';
import { cleanup, click, render, waitFor } from '@/test/render';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { CommandPalette } from './CommandPalette';
import { surfaceCommand } from './surface-commands';

const original = useViewerStore.getState();
const hosts: ExtensionHostService[] = [];
afterEach(async () => {
  cleanup();
  mock.restoreAll();
  useViewerStore.setState(original, true);
  localStorage.clear();
  for (const host of hosts.splice(0)) await host.dispose();
});

function frameRow() {
  const row = document.querySelector<HTMLButtonElement>('[data-command-id="view:frame"]');
  assert.ok(row, 'the real Frame Selection command is discoverable');
  return row;
}

test('#8947 retained closed palette skips table evaluation and reopens with current prerequisites and host', async () => {
  setLocale('en');
  localStorage.clear();
  useViewerStore.setState({
    ...fixtureModels(fixtureModel('closed-model', { entities: [{ expressId: 1, type: 'IfcWall' }] })),
    selectedEntityId: null, selectedEntityIds: new Set(), collabRole: null, loading: false,
    cameraCallbacks: { frameSelection: () => {} },
  });
  const definition = surfaceCommand('view:frame', 'palette');
  const enabled = definition.enabled;
  let evaluations = 0;
  // Count real catalogue evaluation; preserve the production predicate and availability rules.
  mock.method(definition, 'enabled', (...args: Parameters<typeof enabled>) => {
    evaluations++;
    return enabled(...args);
  });
  const sdk = createBimContext({ transport: {
    send: () => Promise.reject(new Error('SDK transport is outside this regression')),
    subscribe: () => () => {}, close: () => {},
  } });
  const previous = new ExtensionHostService({ sdk });
  const current = new ExtensionHostService({ sdk });
  hosts.push(previous, current);
  const owner = 'com.regression.closed-palette';
  previous.slotRegistry.register(owner, [{ extensionId: owner, slot: 'commandPalette',
    payload: { id: 'previous', title: 'Previous host command' } }]);
  current.slotRegistry.register(owner, [{ extensionId: owner, slot: 'commandPalette',
    payload: { id: 'current', title: 'Current host command' } }]);
  function Surface() {
    const [open, setOpen] = useState(true);
    const [host, setHost] = useState(previous);
    return <BimReactContext.Provider value={sdk}>
      <ExtensionHostContext.Provider value={host}>
        <button onClick={() => setOpen(true)}>Reopen palette</button>
        <button onClick={() => setHost(current)}>Replace host</button>
        <CommandPalette open={open} onOpenChange={setOpen} />
      </ExtensionHostContext.Provider>
    </BimReactContext.Provider>;
  }
  const surface = render(<Surface />);
  assert.ok(evaluations > 0, 'opening evaluates the production command table');
  assert.equal(frameRow().getAttribute('aria-disabled'), 'true', 'no selection disables framing');
  const close = document.querySelector<HTMLButtonElement>('[role="dialog"] button[aria-label="Close"]');
  assert.ok(close);
  click(close);
  await waitFor(() => document.querySelector('[role="dialog"]') === null, 'palette closes');
  const closedEvaluations = evaluations;

  const zero = { x: 0, y: 0, z: 0 };
  const geometry: GeometryResult = { meshes: [], totalTriangles: 0, totalVertices: 0,
    coordinateInfo: { originShift: zero, originalBounds: { min: zero, max: zero },
      shiftedBounds: { min: zero, max: zero }, hasLargeCoordinates: false } };
  act(() => useViewerStore.setState({ geometryResult: geometry }));
  act(() => useViewerStore.setState({
    ...fixtureModels({ ...fixtureModel('closed-model'), geometryResult: geometry, visible: false }),
  }));
  act(() => useViewerStore.setState({ selectedEntityId: 1, selectedEntityIds: new Set([1]) }));
  act(() => useViewerStore.setState(state => ({
    typeVisibility: { ...state.typeVisibility, spaces: !state.typeVisibility.spaces },
    mutationVersion: state.mutationVersion + 1,
  })));
  const replace = [...surface.querySelectorAll('button')].find(button => button.textContent === 'Replace host');
  assert.ok(replace);
  click(replace);
  assert.equal(evaluations, closedEvaluations,
    'geometry, model, selection, visibility, mutation and provider updates do not evaluate a closed table');

  const reopen = [...surface.querySelectorAll('button')].find(button => button.textContent === 'Reopen palette');
  assert.ok(reopen);
  click(reopen);
  assert.ok(evaluations > closedEvaluations, 'reopening evaluates current prerequisites');
  assert.equal(frameRow().getAttribute('aria-disabled'), null, 'latest selection enables framing');
  const rows = [...document.querySelectorAll('[role="option"]')];
  assert.ok(rows.some(row => row.textContent?.includes('Current host command')));
  assert.ok(rows.every(row => !row.textContent?.includes('Previous host command')));
});
