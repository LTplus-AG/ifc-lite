/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The local agent bridge's UI (#9523): a pairing link opens a confirm dialog
 * and nothing connects until Connect; Cancel leaves no trace; the status-bar
 * chip says the connection is live and read-only, shows the activity log and
 * disconnects.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ReactNode } from 'react';
import { buildPairingUrl } from '@ifc-lite/mcp/bridge-protocol';
import { createBimContext } from '@ifc-lite/sdk';
import { cleanup, click, render, type, waitFor } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { LocalBackend } from '@/sdk/local-backend';
import { BimReactContext } from '@/sdk/BimProvider';
import { takePairingFragment } from '@/lib/agent-bridge/pairing-fragment';
import { getAgentBridgeState, resetAgentBridgeStateForTests, updateAgentBridgeState } from '@/lib/agent-bridge/state';
import { AgentBridgeHost, AgentBridgeStatusSlot } from './AgentBridgeHost';
import { AgentBridgeDialog, type AgentBridgeSessionModule } from './AgentBridgeDialog';

const CODE = 'ABCDE-FGHJK-MNPQR-STVWX';

/** Records every socket the code under test opens; none ever connects. */
class SpySocket {
  static urls: string[] = [];
  readyState = 0;
  onopen = null; onmessage = null; onclose = null; onerror = null;
  constructor(url: string) { SpySocket.urls.push(url); }
  send(): void {}
  close(): void {}
}

const realWebSocket = globalThis.WebSocket;
const bim = createBimContext({ backend: new LocalBackend(useViewerStore) });

function withBim(node: ReactNode) {
  return <BimReactContext.Provider value={bim}>{node}</BimReactContext.Provider>;
}

function dialog(): HTMLElement | null {
  return document.body.querySelector('[data-agent-bridge-dialog]');
}

function button(name: RegExp): HTMLButtonElement {
  const found = [...document.body.querySelectorAll('button')].find((b) => name.test(b.textContent ?? ''));
  assert.ok(found, `a button named ${name}`);
  return found as HTMLButtonElement;
}

function storageSnapshot(): string {
  const dump = (s: Storage) => JSON.stringify(Object.keys(s).sort().map((k) => [k, s.getItem(k)]));
  return dump(window.localStorage) + dump(window.sessionStorage);
}

beforeEach(() => {
  SpySocket.urls = [];
  globalThis.WebSocket = SpySocket as unknown as typeof WebSocket;
  resetAgentBridgeStateForTests();
});

afterEach(() => {
  cleanup();
  globalThis.WebSocket = realWebSocket;
  resetAgentBridgeStateForTests();
  window.history.replaceState(null, '', '/');
});

describe('pairing link (#9523)', () => {
  it('the code leaves the URL first; the dialog explains the access; nothing connects until Connect', async () => {
    window.history.replaceState(null, '', `/?model=demo${new URL(buildPairingUrl('https://ifclite.com', 21518, CODE)).hash}`);
    takePairingFragment(window.location, window.history);
    assert.equal(window.location.hash, '', 'the fragment is gone before the viewer renders');
    assert.equal(window.location.search, '?model=demo', 'the rest of the URL is intact');
    assert.ok(!window.location.href.includes('STVWX'));

    render(withBim(<AgentBridgeHost />));
    await waitFor(() => dialog() !== null, 'the pairing link opened the connect dialog');
    const text = dialog()?.textContent ?? '';
    assert.match(text, /A program on this computer will be able to read the model\(s\) open in this tab, including unsaved edits/);
    assert.match(text, /Read-only/);
    assert.match(text, /only to this computer \(127\.0\.0\.1, port 21518\)/);
    assert.match(text, /Local network access/);
    const inputs = [...document.body.querySelectorAll('input')];
    assert.deepEqual(inputs.map((input) => input.value), [CODE, '21518'], 'code and port come from the link');
    assert.deepEqual(SpySocket.urls, [], 'no socket before the user confirms');
    assert.equal(getAgentBridgeState().status.kind, 'idle');

    click(button(/^Connect$/));
    await waitFor(() => SpySocket.urls.length > 0, 'Connect opened the socket');
    assert.deepEqual(SpySocket.urls, ['ws://127.0.0.1:21518/']);
    assert.equal(getAgentBridgeState().status.kind, 'connecting');
    const session = await import('@/lib/agent-bridge/session');
    session.disconnectAgentBridge();
  });

  it('a pairing link opened in the tab that already holds the model (a hashchange) is taken the same way', async () => {
    render(withBim(<AgentBridgeHost />));
    assert.equal(dialog(), null);
    window.history.replaceState(null, '', new URL(buildPairingUrl('https://ifclite.com', 21519, CODE)).hash);
    takePairingFragment(window.location, window.history); // what the boot module's hashchange listener does
    assert.equal(window.location.hash, '');
    await waitFor(() => dialog() !== null, 'the dialog opened on the later link');
    assert.equal((document.body.querySelectorAll('input')[1] as HTMLInputElement).value, '21519');
    assert.deepEqual(SpySocket.urls, []);
  });

  it('Cancel leaves no trace: no socket, no status, no storage, no code in the URL', async () => {
    const before = storageSnapshot();
    window.history.replaceState(null, '', new URL(buildPairingUrl('https://ifclite.com', 21517, CODE)).hash);
    takePairingFragment(window.location, window.history);
    render(withBim(<AgentBridgeHost />));
    await waitFor(() => dialog() !== null, 'the dialog opened');
    click(button(/^Cancel$/));
    await waitFor(() => dialog() === null, 'the dialog closed');
    assert.deepEqual(SpySocket.urls, []);
    assert.deepEqual(getAgentBridgeState(), { status: { kind: 'idle' }, dialog: null, activity: [] });
    assert.equal(storageSnapshot(), before);
    assert.equal(window.location.hash, '');
  });

  it('an unreadable link says so and leaves the code to be typed', async () => {
    render(withBim(<AgentBridgeDialog request={{ source: 'link', fragment: '#mcp-bridge=1&port=nope' }} onClose={() => {}} />));
    await waitFor(() => dialog() !== null, 'the dialog rendered');
    assert.match(dialog()?.querySelector('[role="alert"]')?.textContent ?? '', /could not be read/);
    assert.equal(document.body.querySelector('input')?.value, '');
  });
});

describe('connect dialog outcomes (#9523)', () => {
  it('a manual connect validates input, loads the session only on Connect and explains an unreachable bridge', async () => {
    const calls: { port: number; code: string }[] = [];
    let loads = 0;
    const load = async (): Promise<AgentBridgeSessionModule> => {
      loads++;
      return {
        connectAgentBridge: ({ port, code }) => {
          calls.push({ port, code });
          updateAgentBridgeState({ status: { kind: 'error', code: 'unreachable', port } });
        },
        disconnectAgentBridge: () => {},
      };
    };
    render(withBim(<AgentBridgeDialog request={{ source: 'manual' }} onClose={() => {}} load={load} />));
    await waitFor(() => dialog() !== null, 'the dialog rendered');
    assert.match(dialog()?.textContent ?? '', /npx @ifc-lite\/mcp --bridge/, 'the start command is shown');
    click(button(/^Connect$/));
    assert.match(dialog()?.textContent ?? '', /Enter the pairing code/);
    assert.equal(loads, 0, 'invalid input loads nothing');

    const [codeInput, portInput] = [...document.body.querySelectorAll('input')] as HTMLInputElement[];
    type(codeInput, 'abcde fghjk');
    type(portInput, '70000');
    click(button(/^Connect$/));
    assert.match(dialog()?.textContent ?? '', /port from 1 to 65535/);
    assert.equal(loads, 0);

    type(portInput, '21600');
    click(button(/^Connect$/));
    await waitFor(() => calls.length === 1, 'the session was asked to connect');
    assert.deepEqual(calls, [{ port: 21600, code: 'abcde fghjk' }]);
    await waitFor(() => /Could not connect to the bridge on port 21600/.test(dialog()?.textContent ?? ''), 'the failure is explained');
    assert.match(dialog()?.textContent ?? '', /npx @ifc-lite\/mcp --bridge --bridge-port 21600/);
    assert.ok(button(/^Try again$/));
  });

  for (const [code, pattern] of [
    ['pairing-failed', /did not accept this code/],
    ['protocol-mismatch', /Update the bridge \(npx @ifc-lite\/mcp@latest --bridge\)/],
    ['permission-denied', /allow "Local network access"/],
  ] as const) {
    it(`explains ${code}`, async () => {
      const load = async (): Promise<AgentBridgeSessionModule> => ({
        connectAgentBridge: () => updateAgentBridgeState({ status: { kind: 'error', code, port: 21517 } }),
        disconnectAgentBridge: () => {},
      });
      render(withBim(<AgentBridgeDialog request={{ source: 'manual' }} onClose={() => {}} load={load} />));
      await waitFor(() => dialog() !== null, 'the dialog rendered');
      type(document.body.querySelector('input') as HTMLInputElement, CODE);
      click(button(/^Connect$/));
      await waitFor(() => pattern.test(dialog()?.textContent ?? ''), `${code} is explained`);
    });
  }

  it('closes itself once connected', async () => {
    let closed = 0;
    const load = async (): Promise<AgentBridgeSessionModule> => ({
      connectAgentBridge: ({ port }) => updateAgentBridgeState({ status: { kind: 'connected', port, permission: 'read-only', since: Date.now() } }),
      disconnectAgentBridge: () => {},
    });
    render(withBim(<AgentBridgeDialog request={{ source: 'manual' }} onClose={() => { closed++; }} load={load} />));
    await waitFor(() => dialog() !== null, 'the dialog rendered');
    type(document.body.querySelector('input') as HTMLInputElement, CODE);
    click(button(/^Connect$/));
    await waitFor(() => closed === 1, 'the dialog asked to close');
  });
});

describe('status-bar chip (#9523)', () => {
  it('shows nothing while idle or after a failed attempt', () => {
    const ui = render(<AgentBridgeStatusSlot />);
    assert.equal(ui.textContent, '');
    updateAgentBridgeState({ status: { kind: 'error', code: 'unreachable', port: 21517 } });
    assert.equal(ui.textContent, '');
  });

  it('says connected and read-only, lists activity without arguments, and disconnects', async () => {
    updateAgentBridgeState({
      status: { kind: 'connected', port: 21517, permission: 'read-only', since: Date.now() },
      activity: [
        { seq: 2, tool: 'get_entity', modelId: 'model-a', startedAt: 0, durationMs: 12.4, outcome: 'error', errorCode: 'ENTITY_NOT_FOUND' },
        { seq: 1, tool: 'count_entities', modelId: null, startedAt: 0, durationMs: 3, outcome: 'ok' },
      ],
    });
    const ui = render(<AgentBridgeStatusSlot />);
    await waitFor(() => ui.querySelector('[data-agent-bridge-chip]') !== null, 'the chip loaded');
    assert.match(ui.textContent ?? '', /Local agent connected · read-only/);
    click(ui.querySelector('[data-agent-bridge-chip]') as HTMLElement);
    await waitFor(() => document.body.querySelector('[data-agent-bridge-disconnect]') !== null, 'the chip opened');
    const rows = [...document.body.querySelectorAll('[data-agent-bridge-activity]')].map((row) => row.textContent);
    assert.deepEqual(rows, ['get_entitymodel-a12 mserror ENTITY_NOT_FOUND', 'count_entitiesno model3 msok']);
    assert.match(document.body.textContent ?? '', /Arguments and results are not kept/);

    click(document.body.querySelector('[data-agent-bridge-disconnect]') as HTMLElement);
    assert.equal(getAgentBridgeState().status.kind, 'idle');
    await waitFor(() => ui.querySelector('[data-agent-bridge-chip]') === null, 'the chip is gone');
  });

  it('after a drop it says why and offers to pair again', async () => {
    updateAgentBridgeState({ status: { kind: 'disconnected', reason: 'replaced' } });
    const ui = render(<AgentBridgeStatusSlot />);
    await waitFor(() => ui.querySelector('[data-agent-bridge-chip]') !== null, 'the chip loaded');
    assert.match(ui.textContent ?? '', /Local agent disconnected/);
    click(ui.querySelector('[data-agent-bridge-chip]') as HTMLElement);
    await waitFor(() => /replaced this one/.test(document.body.textContent ?? ''), 'the reason is shown');
    click(button(/^Pair again$/));
    assert.deepEqual(getAgentBridgeState().dialog, { source: 'manual' });
  });
});
