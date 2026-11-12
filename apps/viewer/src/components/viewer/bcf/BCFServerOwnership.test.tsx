/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * BCF server dialog: the connect -> pick project -> load topics flow, with
 * the server faked at the global fetch boundary. Assertions are on OUTPUT —
 * the topics that land in the store's `bcfProject` and the author identity —
 * not on wiring.
 */

import '@/test/setup-dom.js';
import { it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { act, StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BCFServerConnectForm } from './BCFServerConnectForm.js';
import { render, cleanup, click } from '@/test/render.js';
import { useViewerStore } from '@/store';
import {
  clearBcfServerConfig,
  saveBcfServerConfig,
  loadBcfServerConfig,
} from '@/services/bcf-server';
import { toast } from '@/components/ui/toast';
import { BCFServerDialog } from './BCFServerDialog.js';

const realFetch = globalThis.fetch;

/** One-project fake BCF server with two topics and no viewpoints. */
function installFakeServer(): void {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname;
    if (path === '/bcf/2.1/auth') {
      return json({ oauth2_token_url: 'https://fake.example/bcf/oauth2/token', oauth2_auth_url: 'https://fake.example/authorize' });
    }
    if (path === '/bcf/oauth2/token') {
      const form = new URLSearchParams(String(init?.body));
      if (form.get('grant_type') === 'password' && form.get('password') !== 'right') {
        return json({ error: 'invalid_grant', error_description: 'bad credentials' }, 400);
      }
      return json({ access_token: 'token-1', expires_in: 3600 });
    }
    if (path === '/bcf/2.1/current-user') return json({ id: 'tester@example.com' });
    if (path === '/bcf/2.1/projects') return json([{ project_id: 'p1', name: 'Project One' }]);
    if (path === '/bcf/2.1/projects/p1') return json({ project_id: 'p1', name: 'Project One' });
    if (path.endsWith('/extensions')) return json({ topic_status: ['Open', 'Resolved'] });
    if (path.endsWith('/topics')) {
      return json([
        { guid: 't1', title: 'First topic', topic_status: 'Open' },
        { guid: 't2', title: 'Second topic', topic_status: 'Resolved' },
      ]);
    }
    if (path.endsWith('/comments')) return json([{ guid: 'c1', comment: 'hi', author: 'a@b.c' }]);
    if (path.endsWith('/viewpoints')) return json([]);
    return json({ message: `unhandled ${path}` }, 500);
  }) as typeof fetch;
}

/** Poll until `predicate` holds, flushing React between checks. */
async function waitFor(predicate: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  assert.ok(predicate(), `timed out waiting for: ${what}`);
}

/** The dialog portals onto body, so controls are looked up there. */
function input(id: string): HTMLInputElement {
  const el = document.body.querySelector(`#${id}`);
  assert.ok(!!el, `input #${id} must render`);
  return el as HTMLInputElement;
}

function button(label: string): HTMLButtonElement {
  const el = [...document.body.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === label,
  );
  assert.ok(!!el, `button "${label}" must render`);
  return el as HTMLButtonElement;
}

/** Drive a React-controlled input the way typing does. */
function type(el: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value',
  )?.set;
  assert.ok(typeof setter === 'function', 'HTMLInputElement value setter must exist');
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}

beforeEach(() => {
  clearBcfServerConfig();
  useViewerStore.setState({ bcfProject: null, bcfAuthor: 'user@example.com' });
});

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  clearBcfServerConfig();
  document.body.innerHTML = '';
});

// Async-run ownership regressions (PR #9583, BCF server dialog/connect).
for (const close of ['external', 'button', 'unmount', 'strict-root'] as const) it(`closing (${close}) during a pull leaves an empty workspace empty and preserves the saved project choice (PR #9583)`, async t => {
  installFakeServer();
  saveBcfServerConfig({ serverUrl: 'https://fake.example/bcf', userId: 'tester@example.com',
    accessToken: 'token-1', refreshToken: '', tokenExpiresAt: 0, clientId: '', clientSecret: '',
    tokenRelay: '', projectId: 'previous', projectName: 'Previously selected' });
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const server = globalThis.fetch;
  let pulling = false, notices = 0;
  let topicSignal: AbortSignal | null | undefined;
  t.mock.method(toast, 'success', () => { notices++; });
  t.mock.method(toast, 'info', () => { notices++; });
  globalThis.fetch = async (input, init) => {
    const response = await server(input, init);
    if (new URL(String(input)).pathname.endsWith('/topics')) {
      topicSignal = init?.signal;
      response.json = async () => { pulling = true; await held; return []; };
    }
    return response;
  };
  function Harness() {
    const [open, setOpen] = useState(true);
    return <><button onClick={() => setOpen(false)}>External close</button><BCFServerDialog open={open} onOpenChange={setOpen} /></>;
  }
  if (close === 'strict-root') {
    const container = document.createElement('div'); document.body.append(container);
    const root = createRoot(container);
    t.after(() => { act(() => root.unmount()); container.remove(); });
    act(() => root.render(<StrictMode><Harness /></StrictMode>));
  } else render(<Harness />);
  await waitFor(() => document.body.textContent?.includes('Project One') ?? false, 'projects: '+document.body.textContent);
  click(button('Load topics'));
  await waitFor(() => pulling, 'pending pull');
  if (close === 'unmount') cleanup();
  else click(button(close === 'button' ? 'Close' : 'External close'));
  release();
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 100)); });
  assert.equal(useViewerStore.getState().bcfProject === null, true);
  assert.equal(loadBcfServerConfig()?.projectId, 'previous');
  assert.equal(loadBcfServerConfig()?.projectName, 'Previously selected');
  assert.equal(topicSignal?.aborted, true, 'dismissal aborts pull HTTP work');
  assert.equal(notices, 0, 'a cancelled pull shows no message');
});

it('unmounting an OAuth form closes its popup and cancels the callback listener', async t => {
  const realOpen = window.open;
  let closes = 0, signedIn = 0, channelCloses = 0;
  const closeChannel = BroadcastChannel.prototype.close;
  t.mock.method(BroadcastChannel.prototype, 'close', function(this: BroadcastChannel) { channelCloses++; closeChannel.call(this); });
  const popup = { closed: false, location: { href: '' }, close() { closes++; } };
  window.open = (() => popup) as unknown as typeof window.open;
  globalThis.fetch = async () => new Response(JSON.stringify({
    oauth2_auth_url: 'https://fake.example/authorize', oauth2_token_url: 'https://fake.example/token',
  }), { headers: { 'Content-Type': 'application/json' } });
  try {
    render(<BCFServerConnectForm initialServerUrl="https://api.bimdata.io/bcf" initialUsername="" onSignedIn={() => { signedIn++; }} />);
    type(input('bcf-server-oauth-client-id'), 'test-client');
    click(button('Connect'));
    await waitFor(() => !!popup.location.href, 'OAuth navigation');
    cleanup();
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    assert.ok(closes > 0, 'unmount must close the pending popup immediately');
    assert.equal(signedIn, 0);
    assert.ok(channelCloses > 0, 'unmount must release the OAuth callback channel');
  } finally {
    if (popup.location.href) {
      const state = new URL(popup.location.href).searchParams.get('state');
      const channel = new BroadcastChannel('ifc-lite:oauth-callback');
      channel.postMessage({ type: 'ifc-lite:oauth-callback', state, url: `${window.location.origin}/oauth/bcf/callback?error=access_denied&state=${state}` });
      channel.close();
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    }
    window.open = realOpen;
  }
});

it('unmounting during sign-in suppresses the late onSignedIn callback', async () => {
  installFakeServer();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const server = globalThis.fetch;
  let identifying = false, signedIn = 0;
  globalThis.fetch = async (input, init) => {
    if (new URL(String(input)).pathname.endsWith('/current-user')) { identifying = true; await held; }
    return server(input, init);
  };
  render(<BCFServerConnectForm initialServerUrl="https://fake.example/bcf" initialUsername="tester@example.com" onSignedIn={() => { signedIn++; }} />);
  type(input('bcf-server-password'), 'right');
  click(button('Connect'));
  await waitFor(() => identifying, 'pending user identity');
  cleanup();
  release();
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
  assert.equal(signedIn, 0);
  assert.equal(loadBcfServerConfig() === null, true, 'dismissed sign-in cannot save a connection (PR #9583 B1)');
  assert.equal(useViewerStore.getState().bcfAuthor, 'user@example.com');
});

it('unmounting during OAuth discovery never navigates the abandoned popup', async () => {
  const realOpen = window.open;
  const popup = { closed: false, location: { href: '' }, close() { this.closed = true; } };
  window.open = (() => popup) as unknown as typeof window.open;
  let release!: () => void, discovering = false;
  let discoverySignal: AbortSignal | null | undefined;
  const held = new Promise<void>(resolve => { release = resolve; });
  globalThis.fetch = async (_input, init) => {
    discoverySignal = init?.signal; discovering = true; await held;
    return new Response(JSON.stringify({ oauth2_auth_url: 'https://fake.example/authorize', oauth2_token_url: 'https://fake.example/token' }),
      { headers: { 'Content-Type': 'application/json' } });
  };
  try {
    render(<BCFServerConnectForm initialServerUrl="https://api.bimdata.io/bcf" initialUsername="" onSignedIn={() => { throw new Error('abandoned sign-in'); }} />);
    type(input('bcf-server-oauth-client-id'), 'test-client'); click(button('Connect'));
    await waitFor(() => discovering, 'held discovery');
    cleanup(); assert.equal(popup.closed, true, 'popup closes while discovery is still held');
    assert.equal(discoverySignal?.aborted, true, 'discovery HTTP receives cancellation'); release();
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
    assert.equal(popup.closed, true);
    assert.equal(popup.location.href, '');
  } finally {
    // Even a failed assertion against the old implementation must let discovery
    // finish before declining its OAuth request, otherwise its timer keeps Node alive.
    await act(async () => { release(); await new Promise(resolve => setTimeout(resolve, 50)); });
    if (popup.location.href) {
      const state = new URL(popup.location.href).searchParams.get('state');
      const channel = new BroadcastChannel('ifc-lite:oauth-callback');
      channel.postMessage({ type: 'ifc-lite:oauth-callback', state, url: `${window.location.origin}/oauth/bcf/callback?error=access_denied&state=${state}` });
      channel.close(); await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    }
    window.open = realOpen;
  }
});

it('a resolved OAuth callback cannot exchange a code after its form unmounts', async t => {
  const realOpen = window.open;
  const popup = { closed: false, location: { href: '' }, close() {} };
  window.open = (() => popup) as unknown as typeof window.open;
  let exchanges = 0, callbackClosed = false;
  const closeChannel = BroadcastChannel.prototype.close;
  t.mock.method(BroadcastChannel.prototype, 'close', function(this: BroadcastChannel) {
    closeChannel.call(this);
    if (!callbackClosed) { callbackClosed = true; cleanup(); }
  });
  globalThis.fetch = async input => {
    if (String(input).includes('/token')) exchanges++;
    return new Response(JSON.stringify({ oauth2_auth_url: 'https://fake.example/authorize', oauth2_token_url: 'https://fake.example/token' }),
      { headers: { 'Content-Type': 'application/json' } });
  };
  let channel: BroadcastChannel | undefined;
  try {
    render(<BCFServerConnectForm initialServerUrl="https://api.bimdata.io/bcf" initialUsername="" onSignedIn={() => { throw new Error('abandoned sign-in'); }} />);
    type(input('bcf-server-oauth-client-id'), 'test-client'); click(button('Connect'));
    await waitFor(() => !!popup.location.href, 'OAuth navigation');
    const state = new URL(popup.location.href).searchParams.get('state');
    channel = new BroadcastChannel('ifc-lite:oauth-callback');
    channel.postMessage({ type: 'ifc-lite:oauth-callback', state, url: `${window.location.origin}/oauth/bcf/callback?code=good&state=${state}` });
    await waitFor(() => callbackClosed, 'callback delivery');
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
    assert.equal(exchanges, 0);
  } finally { channel?.close(); window.open = realOpen; }
});


function chooseOption(triggerId: string, label: string) {
  const trigger = document.body.querySelector('#'+triggerId);
  assert.ok(!!trigger);
  act(() => trigger!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })));
  const option = [...document.body.querySelectorAll('[role="option"]')].find(item => item.textContent?.trim() === label);
  assert.ok(!!option);
  act(() => option!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
}

for (const method of ['password', 'oauth', 'token', 'client credentials'] as const)
for (const stage of method === 'token' ? ['identity-body', 'completed'] as const : ['token', 'identity-body', 'completed'] as const) {
  it(`PR #9583 B1: ${method} sign-in ${stage} keeps persistence and the real dialog author together`, async () => {
    installFakeServer();
    const realOpen = window.open;
    const popup = { closed: false, location: { href: '' }, close() { this.closed = true; } };
    window.open = (() => popup) as unknown as typeof window.open;
    let release!: () => void, paused = false;
    let requestSignal: AbortSignal | null | undefined;
    const held = new Promise<void>(resolve => { release = resolve; });
    const server = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const response = await server(input, init);
      const path = new URL(String(input)).pathname;
      if (stage === 'token' && path.endsWith('/token')) { requestSignal = init?.signal; paused = true; await held; }
      if (stage === 'identity-body' && path.endsWith('/current-user')) {
        const read = response.json.bind(response);
        response.json = async () => { requestSignal = init?.signal; paused = true; await held; return read(); };
      }
      return response;
    };
    function Harness() {
      const [open, setOpen] = useState(true);
      return <BCFServerDialog open={open} onOpenChange={setOpen} />;
    }
    let channel: BroadcastChannel | undefined;
    try {
      render(<Harness />);
      if (method === 'oauth') { chooseOption('bcf-server-preset', 'BIMData.io'); type(input('bcf-server-oauth-client-id'), 'test-client'); }
      else {
        type(input('bcf-server-url'), 'https://fake.example/bcf');
        if (method === 'token') { chooseOption('bcf-server-auth', 'Access token'); type(input('bcf-server-token'), 'token-1'); }
        else if (method === 'client credentials') {
          chooseOption('bcf-server-auth', 'Client ID & secret');
          type(input('bcf-server-client-id'), 'app'); type(input('bcf-server-client-secret'), 'secret');
        } else { type(input('bcf-server-user'), 'tester@example.com'); type(input('bcf-server-password'), 'right'); }
      }
      click(button('Connect'));
      if (method === 'oauth') {
        await waitFor(() => !!popup.location.href, 'OAuth navigation');
        const state = new URL(popup.location.href).searchParams.get('state');
        channel = new BroadcastChannel('ifc-lite:oauth-callback');
        channel.postMessage({ type: 'ifc-lite:oauth-callback', state, url: `${window.location.origin}/oauth/bcf/callback?code=good&state=${state}` });
      }
      if (stage === 'completed') {
        await waitFor(() => document.body.textContent?.includes('Project One') ?? false, 'connected project list');
        assert.equal(loadBcfServerConfig()?.userId, 'tester@example.com');
        assert.equal(useViewerStore.getState().bcfAuthor, 'tester@example.com', 'a completed sign-in adopts the author');
      } else {
        await waitFor(() => paused, 'held '+stage);
        click(button('Close'));
        await act(async () => { release(); await new Promise(resolve => setTimeout(resolve, 100)); });
        assert.equal(loadBcfServerConfig() === null, true, 'dismissal is a real cancellation, with nothing saved');
        assert.equal(useViewerStore.getState().bcfAuthor, 'user@example.com');
        assert.equal(requestSignal?.aborted, true, 'the identity and token fetches receive the run signal');
      }
    } finally { release(); channel?.close(); window.open = realOpen; }
  });
}
