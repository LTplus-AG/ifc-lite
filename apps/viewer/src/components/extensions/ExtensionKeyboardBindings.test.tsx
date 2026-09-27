/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { act } from 'react';
import { createBimContext } from '@ifc-lite/sdk';
import { cleanup, render } from '@/test/render';
import { ExtensionHostContext } from '@/sdk/ExtensionHostProvider';
import { ExtensionHostService } from '@/services/extensions/host';

async function loadKeyboardIntegration() {
  // A reverted new module must fail an assertion inside the test, rather than
  // stopping the test file at module loading before any behavior is checked.
  const dispatcher = await import('@/lib/commands/dispatcher').catch(() => null);
  const component = await import('./ExtensionKeyboardBindings').catch(() => null);
  assert.ok(dispatcher && component, 'extension keyboard commands are installed in the shared dispatcher');
  return { registerKeyboardCommand: dispatcher.registerKeyboardCommand,
    ExtensionKeyboardBindings: component.ExtensionKeyboardBindings };
}

class StubHost extends ExtensionHostService {
  readonly runs: string[] = [];

  constructor() {
    super({ sdk: createBimContext({ transport: {
      send: () => Promise.reject(new Error('Transport is unused in this keyboard test')),
      subscribe: () => () => {}, close: () => {},
    } }) });
  }

  override async runCommand(commandId: string, extensionId: string): Promise<undefined> {
    this.runs.push(`${extensionId}:${commandId}`);
    return undefined;
  }
}

afterEach(cleanup);

function press(key: string, options: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options });
  window.dispatchEvent(event);
  return event;
}

test('#5841 installed extension Shift+G runs its own command and unregisters cleanly', async () => {
  const { ExtensionKeyboardBindings } = await loadKeyboardIntegration();
  const host = new StubHost();
  host.slotRegistry.register('ext.alpha', [{
    extensionId: 'ext.alpha', slot: 'keybindings', payload: { command: 'paint', key: 'Shift+G' },
  }]);
  render(<ExtensionHostContext.Provider value={host}><ExtensionKeyboardBindings /></ExtensionHostContext.Provider>);
  press('g');
  assert.deepEqual(host.runs, []);
  assert.equal(press('G', { shiftKey: true }).defaultPrevented, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(host.runs, ['ext.alpha:paint']);
  act(() => host.slotRegistry.unregister('ext.alpha'));
  assert.equal(press('G', { shiftKey: true }).defaultPrevented, false);
});

test('#5841 extension cannot silently shadow a displayed built-in chord', async () => {
  const { ExtensionKeyboardBindings, registerKeyboardCommand } = await loadKeyboardIntegration();
  const host = new StubHost();
  host.slotRegistry.register('ext.alpha', [{
    extensionId: 'ext.alpha', slot: 'keybindings', payload: { command: 'stealTheme', key: 'T' },
  }]);
  const warnings: string[] = [];
  const priorWarn = console.warn;
  console.warn = (value: string) => { warnings.push(value); };
  const calls: string[] = [];
  const removeTheme = registerKeyboardCommand('ui.toggleTheme', () => { calls.push('theme'); });
  try {
    render(<ExtensionHostContext.Provider value={host}><ExtensionKeyboardBindings /></ExtensionHostContext.Provider>);
    press('t');
    assert.deepEqual(calls, ['theme']);
    assert.deepEqual(host.runs, []);
    assert.ok(warnings.some((warning) => warning.includes('ui.toggleTheme')));
  } finally {
    removeTheme();
    console.warn = priorWarn;
  }
});
