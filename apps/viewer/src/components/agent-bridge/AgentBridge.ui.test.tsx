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
import { advance as advanceMs, cleanup, click, render, type, waitFor } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { LocalBackend } from '@/sdk/local-backend';
import { BimReactContext } from '@/sdk/BimProvider';
import { installPairingFragmentStrip } from '@/lib/agent-bridge/pairing-fragment';
import {
  getAgentBridgeState, registerAgentBridgeControls, resetAgentBridgeStateForTests, updateAgentBridgeState,
  type AgentBridgePermission, type AgentBridgeStatus,
} from '@/lib/agent-bridge/state';
import { AgentBridgeHost, AgentBridgeStatusSlot } from './AgentBridgeHost';
import { AgentBridgeDialog, PERMISSION_HINT_DELAY_MS, type AgentBridgeSessionModule } from './AgentBridgeDialog';
import type { SurfaceCommandDefinition, SurfaceCommandState } from '@/components/viewer/surface-command-types';

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

let uninstallStrip: () => void = () => {};
beforeEach(() => {
  uninstallStrip = installPairingFragmentStrip(window);
  SpySocket.urls = [];
  globalThis.WebSocket = SpySocket as unknown as typeof WebSocket;
  resetAgentBridgeStateForTests();
});

afterEach(() => {
  uninstallStrip();
  cleanup();
  globalThis.WebSocket = realWebSocket;
  resetAgentBridgeStateForTests();
  window.history.replaceState(null, '', '/');
});

/** Open a pairing link the way a user does: in this tab, through the boot-installed strip and a real event. */
function openLink(port: number, event: 'popstate' | 'hashchange' = 'hashchange'): void {
  window.history.replaceState(null, '', `/?model=demo${new URL(buildPairingUrl('https://ifclite.com', port, CODE)).hash}`);
  window.dispatchEvent(event === 'popstate' ? new window.PopStateEvent('popstate') : new window.HashChangeEvent('hashchange'));
}

/** A session module that loads only when the test says so. */
function deferredSession() {
  const calls: { port: number; code: string }[] = [];
  let resolveLoad: () => void = () => {};
  const loaded = new Promise<void>((resolve) => { resolveLoad = resolve; });
  const load = async (): Promise<AgentBridgeSessionModule> => {
    await loaded;
    return { connectAgentBridge: ({ port, code }) => { calls.push({ port, code }); }, disconnectAgentBridge: () => {} };
  };
  return { calls, load, resolveLoad };
}

describe('pairing link (#9523)', () => {
  it('a link opened in this tab: the code leaves the URL, the dialog states what is true, nothing connects until Connect', async () => {
    render(withBim(<AgentBridgeHost />));
    openLink(21518);
    assert.equal(window.location.hash, '', 'the fragment is gone');
    assert.equal(window.location.search, '?model=demo', 'the rest of the URL is intact');
    await waitFor(() => dialog() !== null, 'the pairing link opened the connect dialog');
    const text = dialog()?.textContent ?? '';
    assert.match(text, /The viewer cannot tell who made the link/);
    assert.match(text, /Whatever program is listening on 127\.0\.0\.1, port 21518, will be able to read the model\(s\) open in this tab, including unsaved edits/);
    assert.match(text, /cannot check what that program is\. Connect only if you started ifc-lite-mcp --bridge yourself/);
    assert.match(text, /the agent may send what it reads to its AI provider/);
    assert.match(text, /bSDD tools also send IFC class names to bSDD/);
    assert.match(text, /Read-only at first: the agent cannot change the model/);
    assert.doesNotMatch(text, /not sent to ifclite\.com or any other server|from the ifc-lite agent bridge/, 'no over-claim');
    assert.equal(dialog()?.querySelector('[data-agent-bridge-target]')?.textContent?.trim(), 'Connects to 127.0.0.1:21518');
    const inputs = [...document.body.querySelectorAll('input')];
    assert.deepEqual(inputs.map((input) => input.value), [CODE, '21518'], 'code and port come from the link');
    assert.deepEqual(SpySocket.urls, [], 'no socket before the user confirms');

    click(button(/^Connect$/));
    await waitFor(() => SpySocket.urls.length > 0, 'Connect opened the socket');
    assert.deepEqual(SpySocket.urls, ['ws://127.0.0.1:21518/']);
    const session = await import('@/lib/agent-bridge/session');
    session.disconnectAgentBridge();
  });

  it('Cancel leaves no trace: no socket, no status, no storage, no code in the URL', async () => {
    const before = storageSnapshot();
    render(withBim(<AgentBridgeHost />));
    openLink(21517, 'popstate');
    await waitFor(() => dialog() !== null, 'the dialog opened');
    click(button(/^Cancel$/));
    await waitFor(() => dialog() === null, 'the dialog closed');
    assert.deepEqual(SpySocket.urls, []);
    assert.deepEqual(getAgentBridgeState(), { status: { kind: 'idle' }, dialog: null, activity: [] });
    assert.equal(storageSnapshot(), before);
    assert.equal(window.location.hash, '');
  });

  it('Cancel while the connection module is still loading opens no socket', async () => {
    const session = deferredSession();
    render(withBim(<AgentBridgeDialog request={{ source: 'manual' }} onClose={() => {}} load={session.load} />));
    type(document.body.querySelector('input') as HTMLInputElement, CODE);
    click(button(/^Connect$/));
    click(button(/^Cancel$/));
    session.resolveLoad();
    await advanceMs(20);
    assert.deepEqual(session.calls, [], 'the cancelled attempt never connected');
  });

  it('unmounting the dialog while loading opens no socket', async () => {
    const session = deferredSession();
    render(withBim(<AgentBridgeDialog request={{ source: 'manual' }} onClose={() => {}} load={session.load} />));
    type(document.body.querySelector('input') as HTMLInputElement, CODE);
    click(button(/^Connect$/));
    cleanup();
    session.resolveLoad();
    await advanceMs(20);
    assert.deepEqual(session.calls, []);
  });

  it('a second link while the first is still loading replaces the dialog, and the first never connects', async () => {
    const first = deferredSession();
    const ui = render(withBim(<AgentBridgeDialog key="a" request={{ source: 'link', fragment: new URL(buildPairingUrl('https://ifclite.com', 21600, CODE)).hash }} onClose={() => {}} load={first.load} />));
    click(button(/^Connect$/));
    // What the host does for a new request: a fresh dialog (a new key) replaces the old one.
    cleanup();
    render(withBim(<AgentBridgeDialog key="b" request={{ source: 'link', fragment: new URL(buildPairingUrl('https://ifclite.com', 21601, CODE)).hash }} onClose={() => {}} />));
    first.resolveLoad();
    await advanceMs(20);
    assert.deepEqual(first.calls, [], 'the superseded attempt never connected');
    assert.equal(dialog()?.querySelector('[data-agent-bridge-target]')?.textContent?.trim(), 'Connects to 127.0.0.1:21601');
    assert.deepEqual(SpySocket.urls, []);
    void ui;
  });

  it('a link arriving while a connection is live says Connect replaces it, and does nothing until Connect', async () => {
    updateAgentBridgeState({ status: { kind: 'connected', port: 21517, permission: 'read-only', since: Date.now(), readOnlyCeiling: false } });
    render(withBim(<AgentBridgeHost />));
    openLink(21650);
    await waitFor(() => dialog() !== null, 'the dialog opened');
    assert.match(dialog()?.textContent ?? '', /already connected on port 21517\. Connecting replaces it/);
    assert.equal(getAgentBridgeState().status.kind, 'connected', 'the live connection is untouched');
    assert.deepEqual(SpySocket.urls, []);
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
    ['permission-denied', /"Apps on device" in Chrome, "Device apps and services" in Firefox/],
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

  /** Render a manual dialog whose session reports `status` on Connect, type a code and press Connect. */
  async function connectReporting(status: AgentBridgeStatus): Promise<void> {
    const load = async (): Promise<AgentBridgeSessionModule> => ({
      connectAgentBridge: () => updateAgentBridgeState({ status }), disconnectAgentBridge: () => {},
    });
    render(withBim(<AgentBridgeDialog request={{ source: 'manual' }} onClose={() => {}} load={load} />));
    type(document.body.querySelector('input') as HTMLInputElement, CODE);
    click(button(/^Connect$/));
    await waitFor(() => getAgentBridgeState().status.kind === status.kind, `status ${status.kind}`);
  }

  for (const permission of ['prompt', undefined] as const) {
    it(`an unreachable bridge with permission ${permission ?? 'unknown'} ${permission ? 'says the browser prompt may be waiting or dismissed' : 'adds no prompt hint'}`, async () => {
      await connectReporting({ kind: 'error', code: 'unreachable', port: 21517, permission });
      await waitFor(() => /Could not connect to the bridge/.test(dialog()?.textContent ?? ''), 'the failure is shown');
      const hint = document.body.querySelector('[data-agent-bridge-permission-hint]');
      if (permission) assert.match(hint?.textContent ?? '', /may still be waiting for an answer to its permission prompt, or the prompt was dismissed/);
      else assert.equal(hint, null);
    });
  }

  for (const opened of [false, true]) {
    it(`Connecting ${opened ? 'with an open socket shows no permission hint' : 'with no open socket for 1.5 s points at the browser prompt'}`, async () => {
      await connectReporting({ kind: 'connecting', port: 21517, opened });
      assert.equal(document.body.querySelector('[data-agent-bridge-permission-wait]'), null, 'not at once');
      await advanceMs(PERMISSION_HINT_DELAY_MS + 100);
      const hint = document.body.querySelector('[data-agent-bridge-permission-wait]');
      if (opened) assert.equal(hint, null, 'an open socket is past the prompt');
      else assert.match(hint?.textContent ?? '', /may be asking whether this site may access other apps and services on this device/);
    });
  }

  it('closes itself once connected', async () => {
    let closed = 0;
    const load = async (): Promise<AgentBridgeSessionModule> => ({
      connectAgentBridge: ({ port }) => updateAgentBridgeState({ status: { kind: 'connected', port, permission: 'read-only', since: Date.now(), readOnlyCeiling: false } }),
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
      status: { kind: 'connected', port: 21517, permission: 'read-only', since: Date.now(), readOnlyCeiling: false },
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
    assert.match(document.body.textContent ?? '', /arguments and results are not kept/i);

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

const CONNECTED = { kind: 'connected', port: 21517, permission: 'read-only', since: Date.now(), readOnlyCeiling: false } as const;

describe('a live connection is visible with Disconnect in every layout (#9523 review)', () => {
  afterEach(() => useViewerStore.setState({ isMobile: false }));

  it('desktop: the status-bar chip; phone: a persistent pill with Disconnect; switching layouts while connected', async () => {
    useViewerStore.setState({ isMobile: false });
    updateAgentBridgeState({ status: CONNECTED });
    const ui = render(withBim(<><AgentBridgeHost /><AgentBridgeStatusSlot /></>));
    await waitFor(() => ui.querySelector('[data-agent-bridge-chip="connected"]') !== null, 'desktop chip');
    assert.equal(document.body.querySelector('[data-agent-bridge-mobile]'), null, 'no phone pill on desktop');

    // The window narrows into the phone layout: the status bar goes away (ViewerLayout renders it on desktop only).
    useViewerStore.setState({ isMobile: true });
    await waitFor(() => document.body.querySelector('[data-agent-bridge-mobile="connected"]') !== null, 'phone pill appears');
    const pill = document.body.querySelector('[data-agent-bridge-mobile]') as HTMLElement;
    assert.match(pill.textContent ?? '', /Local agent connected · read-only/);
    click(pill);
    await waitFor(() => document.body.querySelector('[data-agent-bridge-disconnect]') !== null, 'the pill opens Disconnect');
    assert.match(document.body.textContent ?? '', /arguments and results are not kept/i, 'and the activity log');
    click(document.body.querySelector('[data-agent-bridge-disconnect]') as HTMLElement);
    assert.equal(getAgentBridgeState().status.kind, 'idle');
    await waitFor(() => document.body.querySelector('[data-agent-bridge-mobile]') === null, 'the pill is gone');
  });

  it('the Sources row shows the live connection with Disconnect and the activity log', async () => {
    const { LocalAgentSourceRow } = await import('@/components/sources/LocalAgentSourceRow');
    updateAgentBridgeState({
      status: CONNECTED,
      activity: [{ seq: 1, tool: 'count_entities', modelId: 'm', startedAt: 0, durationMs: 4, outcome: 'ok' }],
    });
    const ui = render(<LocalAgentSourceRow />);
    assert.match(ui.textContent ?? '', /Local agent connected · read-only/);
    assert.equal(ui.querySelector('[data-agent-bridge-activity]'), null, 'activity sits behind a toggle');
    click(button(/^Show activity$/));
    assert.equal(ui.querySelectorAll('[data-agent-bridge-activity]').length, 1);
    click(ui.querySelector('[data-agent-bridge-disconnect]') as HTMLElement);
    assert.equal(getAgentBridgeState().status.kind, 'idle');
    assert.ok(button(/^Connect local agent$/), 'back to the connect action');
  });

  it('a drop while no dialog is open is announced with a toast and stays in the Sources row', async () => {
    const { Toaster } = await import('@/components/ui/toast');
    const { latestToast } = await import('@/test/toasts');
    const { LocalAgentSourceRow } = await import('@/components/sources/LocalAgentSourceRow');
    const session = await import('@/lib/agent-bridge/session');
    class LiveSocket {
      static last: LiveSocket | null = null;
      readyState = 0;
      onopen: ((e: unknown) => void) | null = null; onmessage: ((e: { data: unknown }) => void) | null = null;
      onclose: ((e: { code: number; reason: string }) => void) | null = null; onerror: ((e: unknown) => void) | null = null;
      constructor() { LiveSocket.last = this; }
      send(): void {}
      close(): void { this.readyState = 3; }
    }
    render(<><Toaster /><LocalAgentSourceRow /></>);
    session.connectAgentBridge({ port: 21517, code: CODE, bim, WebSocket: LiveSocket as unknown as NonNullable<Parameters<typeof session.connectAgentBridge>[0]['WebSocket']> });
    const socket = LiveSocket.last as LiveSocket;
    socket.readyState = 1;
    socket.onopen?.({});
    socket.onmessage?.({ data: JSON.stringify({ type: 'welcome', protocol: 1, sessionId: 's', permission: 'read-only', readOnlyCeiling: false, bridge: { name: 'b', version: '1' } }) });
    assert.equal(getAgentBridgeState().status.kind, 'connected');
    socket.readyState = 3;
    socket.onclose?.({ code: 4400, reason: '' });
    assert.deepEqual(getAgentBridgeState().status, { kind: 'disconnected', reason: 'connection-lost' });
    await waitFor(() => /Local agent disconnected/.test(latestToast()), 'a toast says so');
    assert.match(latestToast(), /connection to the bridge was lost/);
    assert.match(document.body.querySelector('[data-local-agent-row]')?.textContent ?? '', /connection to the bridge was lost/);
    session.dismissAgentBridgeStatus();
  });
});

describe('a framed viewer never connects (#9523 review)', () => {
  let realTop: PropertyDescriptor | undefined;
  beforeEach(() => {
    realTop = Object.getOwnPropertyDescriptor(window, 'top');
    Object.defineProperty(window, 'top', { configurable: true, get: () => ({}) });
  });
  afterEach(() => { if (realTop) Object.defineProperty(window, 'top', realTop); });

  it('ignores pairing links, disables Connect in the dialog, the Sources row and the palette, and says why', async () => {
    render(withBim(<AgentBridgeHost />));
    openLink(21517);
    assert.equal(window.location.hash, '', 'the code is still stripped');
    await advanceMs(20);
    assert.equal(dialog(), null, 'no dialog for a link in a frame');

    const { LocalAgentSourceRow } = await import('@/components/sources/LocalAgentSourceRow');
    const row = render(<LocalAgentSourceRow />);
    assert.match(row.textContent ?? '', /embedded in another page/);
    assert.equal(button(/^Connect local agent$/).disabled, true);

    const { PANEL_SURFACE_COMMANDS } = await import('@/components/viewer/surface-commands-panels');
    const command: SurfaceCommandDefinition | undefined = PANEL_SURFACE_COMMANDS.find((c) => c.id === 'panel:agentBridge');
    assert.ok(command, 'the palette entry exists');
    assert.equal(command.enabled({ canEditInSession: true, collabEnabled: false } as SurfaceCommandState), false);

    cleanup();
    render(withBim(<AgentBridgeDialog request={{ source: 'manual' }} onClose={() => {}} />));
    assert.match(dialog()?.textContent ?? '', /embedded in another page/);
    assert.equal((document.body.querySelector('[data-agent-bridge-connect]') as HTMLButtonElement).disabled, true);
    assert.deepEqual(SpySocket.urls, []);
  });
});

describe('allowing the agent to edit (#9523)', () => {
  beforeEach(() => resetAgentBridgeStateForTests());
  afterEach(() => cleanup());

  it('the switch is off on a fresh connection, and toggling it asks the session to grant or revoke', async () => {
    const { AgentBridgeConnectionPanel } = await import('./AgentBridgeConnectionPanel');
    const asked: AgentBridgePermission[] = [];
    registerAgentBridgeControls({ disconnect: () => {}, dismiss: () => {}, setPermission: (p) => { asked.push(p); } });
    updateAgentBridgeState({ status: CONNECTED });
    const ui = render(<AgentBridgeConnectionPanel />);
    const toggle = () => ui.querySelector('[data-agent-bridge-allow-edits]') as HTMLButtonElement;
    assert.equal(toggle().getAttribute('aria-checked'), 'false', 'off by default');
    assert.match(ui.textContent ?? '', /Allow the agent to edit this model/);
    click(toggle());
    assert.deepEqual(asked, ['read-write']);

    updateAgentBridgeState({ status: { ...CONNECTED, permission: 'read-write' } });
    await waitFor(() => toggle().getAttribute('aria-checked') === 'true', 'the switch follows the grant');
    assert.match(ui.textContent ?? '', /Local agent connected · can edit/);
    click(toggle());
    assert.deepEqual(asked, ['read-write', 'read-only']);
  });

  it('is disabled, with the reason, when the bridge runs --read-only', async () => {
    const { AgentBridgeConnectionPanel } = await import('./AgentBridgeConnectionPanel');
    updateAgentBridgeState({ status: { ...CONNECTED, readOnlyCeiling: true } });
    const ui = render(<AgentBridgeConnectionPanel />);
    assert.equal((ui.querySelector('[data-agent-bridge-allow-edits]') as HTMLButtonElement).disabled, true);
    assert.match(ui.textContent ?? '', /started with --read-only/);
  });

  it('marks edit rows in the activity log and says what an applied edit changed', async () => {
    const { AgentBridgeActivityLog } = await import('./AgentBridgeConnectionPanel');
    updateAgentBridgeState({
      status: { ...CONNECTED, permission: 'read-write' },
      activity: [
        { seq: 3, tool: 'entity_set_property', modelId: 'm', startedAt: 0, durationMs: 2, outcome: 'error', errorCode: 'READ_ONLY', mutating: true },
        { seq: 2, tool: 'entity_set_property', modelId: 'm', startedAt: 0, durationMs: 2, outcome: 'ok', mutating: true,
          edit: { modelId: 'm', expressId: 7, globalId: '2JUHrTM_j3UxZiBnyBfByx', entityType: 'IfcWall', field: 'Pset_WallCommon.FireRating', before: null, after: 'EI60', changed: true } },
        { seq: 1, tool: 'count_entities', modelId: 'm', startedAt: 0, durationMs: 4, outcome: 'ok' },
      ],
    });
    const ui = render(<AgentBridgeActivityLog />);
    const rows = [...ui.querySelectorAll('[data-agent-bridge-activity]')];
    assert.deepEqual(rows.map((row) => row.getAttribute('data-agent-bridge-edit')), ['not-applied', 'applied', null]);
    assert.match(rows[1].textContent ?? '', /IfcWall #7 · Pset_WallCommon\.FireRating: — → “EI60”/);
    assert.doesNotMatch(rows[2].textContent ?? '', /→/);
  });
});
