/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { BimReactContext } from '@/sdk/BimProvider';
import { getAgentCommandHost } from '@/lib/agent-bridge/command-host';
import { updateAgentBridgeState, resetAgentBridgeStateForTests } from '@/lib/agent-bridge/state';
import { dispatchMainViewerTool } from '@/lib/agent-tools/main-viewer-dispatch';
import { viewerBim, viewerHost, seed, model, parseHelloWall } from '@/test/agent-tools-fixture';
import { useViewerStore } from '@/store';
import { render, cleanup, waitFor, advance } from '@/test/render';
import { act } from 'react';
import { CommandPaletteHost } from './CommandPaletteHost';

const initial = useViewerStore.getState();
afterEach(async () => {
  cleanup();
  resetAgentBridgeStateForTests();
  useViewerStore.setState(initial);
  await advance(0);
});

test('bridge connection mounts the real command owner without opening the palette; unmount retires it', async () => {
  seed([model('hello', await parseHelloWall())]);
  render(<BimReactContext.Provider value={viewerBim()}>
    <CommandPaletteHost open={false} onOpenChange={() => {}} />
  </BimReactContext.Provider>);
  assert.equal(getAgentCommandHost(), null, 'does not eagerly mount the palette');
  act(() => updateAgentBridgeState({ status: { kind: 'connected', port: 21517, permission: 'read-only', since: 1, readOnlyCeiling: false } }));
  await waitFor(() => getAgentCommandHost() !== null, 'connected bridge mounts palette commands');
  assert.equal(document.querySelector('[role="dialog"]'), null, 'no unsolicited palette dialog');
  const discovered = await dispatchMainViewerTool(viewerHost(), 'viewer_commands', { query: 'clash' });
  assert.equal(discovered.isError, false, discovered.text);
  assert.match(discovered.text, /panel:clash/);
  let run!: Awaited<ReturnType<typeof dispatchMainViewerTool>>;
  await act(async () => {
    run = await dispatchMainViewerTool(viewerHost(), 'viewer_command_run', { command_id: 'panel:clash' }, { canEdit: () => true });
  });
  assert.equal(run.isError, false, run.text);
  assert.equal(useViewerStore.getState().clashPanelVisible, true, 'uses the real mounted panel callback');
  cleanup();
  assert.equal(getAgentCommandHost(), null);
  assert.equal((await dispatchMainViewerTool(viewerHost(), 'viewer_command_run', { command_id: 'panel:clash' }, { canEdit: () => true })).isError, true);
});
