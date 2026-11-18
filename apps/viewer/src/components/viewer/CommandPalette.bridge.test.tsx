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
import { render, cleanup, waitFor, advance, type as typeInto } from '@/test/render';
import { act, useState } from 'react';
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

// #10525 review: retaining the owner must not retain a closed cold-load query
// or an unfinished IME composition, which would keep the owner unmounted.
test('closing a composing cold palette clears input and retains agent commands across reopen', async () => {
  seed([model('hello', await parseHelloWall())]);
  updateAgentBridgeState({ status: { kind: 'connected', port: 21517, permission: 'read-only', since: 1, readOnlyCeiling: false } });
  let changeOpen!: (open: boolean) => void;
  function Harness() {
    const [open, setOpen] = useState(true);
    changeOpen = setOpen;
    return <BimReactContext.Provider value={viewerBim()}>
      <CommandPaletteHost open={open} onOpenChange={setOpen} />
    </BimReactContext.Provider>;
  }
  render(<Harness />);
  const coldInput = document.querySelector<HTMLInputElement>('input[type="search"]');
  assert.ok(coldInput, 'cold-load dialog is available synchronously');
  typeInto(coldInput, 'stale cold query');
  act(() => coldInput.dispatchEvent(new window.Event('compositionstart', { bubbles: true })));
  await advance(0);
  assert.equal(document.querySelector('input[role="combobox"]'), null, 'unfinished composition retains the cold input');
  act(() => changeOpen(false));
  await waitFor(() => getAgentCommandHost() !== null, 'closing composition must allow the command owner to mount');
  assert.equal(document.querySelector('[role="dialog"]'), null);
  act(() => changeOpen(true));
  await waitFor(() => document.querySelector('input[role="combobox"]') !== null, 'reopened real palette');
  const reopened = document.querySelector<HTMLInputElement>('input[role="combobox"]');
  assert.equal(reopened?.value, '', 'a closed cold-load query cannot leak into the next open');
  assert.ok(getAgentCommandHost(), 'reopening preserves command ownership');
});
