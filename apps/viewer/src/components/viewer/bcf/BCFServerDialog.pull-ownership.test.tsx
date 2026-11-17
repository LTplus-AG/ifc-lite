/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * BCF server dialog (C-2): a topic pull belongs to the connection it was
 * started for. With the first pull held open by the test, an account switch
 * or a disconnect from another tab followed by a new sign-in frees "Load topics" for the new session at
 * once, and the old pull's late answer never lands. The server is faked at the
 * fetch boundary; assertions are on request counts and the store's project.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, click, render } from '@/test/render.js';
import { deferred, type Deferred } from '@/test/race.js';
import { useViewerStore } from '@/store';
import { clearBcfServerConfig, saveBcfServerConfig, type BcfServerConfig } from '@/services/bcf-server';
import { BCFServerDialog } from './BCFServerDialog.js';

const realFetch = globalThis.fetch;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/**
 * One project; the FIRST topics request waits on `held`, later ones answer at
 * once. Each answer names the account whose token asked, so the test can tell
 * which pull landed.
 */
function installServer() {
  const held: Deferred<void> = deferred();
  let topicRequests = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    const token = new Headers(init?.headers).get('Authorization') ?? '';
    if (path === '/bcf/2.1/auth') return json({ oauth2_token_url: 'https://fake.example/bcf/oauth2/token' });
    if (path === '/bcf/oauth2/token') return json({ access_token: 'token-reconnected', expires_in: 3600 });
    if (path === '/bcf/2.1/current-user') return json({ id: 'second@example.com' });
    if (path === '/bcf/2.1/projects') return json([{ project_id: 'p1', name: 'Project One' }]);
    if (path === '/bcf/2.1/projects/p1') return json({ project_id: 'p1', name: 'Project One' });
    if (path.endsWith('/extensions')) return json({ topic_status: ['Open'] });
    if (path.endsWith('/topics')) {
      topicRequests++;
      if (topicRequests === 1) await held.promise;
      return json([{ guid: `t-${topicRequests}`, title: `pulled with ${token}`, topic_status: 'Open' }]);
    }
    if (path.endsWith('/comments') || path.endsWith('/viewpoints')) return json([]);
    return json({ message: `unhandled ${path}` }, 500);
  }) as typeof fetch;
  return { held, topicRequests: () => topicRequests };
}

const account = (userId: string, accessToken: string): BcfServerConfig => ({
  serverUrl: 'https://fake.example/bcf', userId, accessToken, refreshToken: '', tokenExpiresAt: 0,
  clientId: '', clientSecret: '', tokenRelay: '', projectId: 'p1', projectName: 'Project One',
});

async function waitFor(predicate: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  }
  assert.ok(predicate(), `timed out waiting for: ${what}`);
}

function button(label: string): HTMLButtonElement {
  const found = [...document.body.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);
  assert.ok(found, `button "${label}" must render`);
  return found as HTMLButtonElement;
}
const hasButton = (label: string) => [...document.body.querySelectorAll('button')].some((b) => b.textContent?.trim() === label);
const pulledTitles = () => [...(useViewerStore.getState().bcfProject?.topics.values() ?? [])].map((topic) => topic.title);

function type(id: string, value: string): void {
  const el = document.body.querySelector(`#${id}`);
  assert.ok(el instanceof window.HTMLInputElement, `input #${id} must render`);
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  assert.ok(setter);
  act(() => { setter.call(el, value); el.dispatchEvent(new window.Event('input', { bubbles: true })); });
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

/** Open the dialog on a saved connection and start a pull that the server holds open. */
async function holdFirstPull() {
  const server = installServer();
  saveBcfServerConfig(account('first@example.com', 'token-first'));
  render(<BCFServerDialog open onOpenChange={() => {}} />);
  await waitFor(() => hasButton('Load topics') && !button('Load topics').disabled, 'project list for the first account');
  click(button('Load topics'));
  await waitFor(() => server.topicRequests() === 1, 'the first pull reached the topics request');
  return server;
}

describe('BCFServerDialog pull ownership (C-2)', () => {
  it('an account switch mid-pull frees Load topics for the new account, and the old pull never lands', async () => {
    const server = await holdFirstPull();
    act(() => saveBcfServerConfig(account('second@example.com', 'token-second')));
    await waitFor(() => hasButton('Load topics') && !button('Load topics').disabled, 'Load topics is usable for the new account');
    click(button('Load topics'));
    await waitFor(() => pulledTitles().length > 0, "the new account's pull lands");
    assert.equal(server.topicRequests(), 2, "the new account's pull started while the old one was still held");
    await act(async () => { server.held.resolve(); });
    await waitFor(() => server.topicRequests() === 2, 'settled');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    assert.deepEqual(pulledTitles(), ['pulled with Bearer token-second'], "the old account's late answer is dropped");
  });

  it('a disconnect in another tab mid-pull, then signing in again here, frees Load topics, and the old pull never lands', async () => {
    const server = await holdFirstPull();
    // Disconnect is disabled here while the pull runs; another tab clearing the shared connection is not.
    assert.equal(button('Disconnect').disabled, true);
    act(() => clearBcfServerConfig());
    await waitFor(() => document.body.querySelector('#bcf-server-url') !== null, 'the sign-in form');
    type('bcf-server-url', 'https://fake.example/bcf');
    type('bcf-server-user', 'second@example.com');
    type('bcf-server-password', 'right');
    click(button('Connect'));
    await waitFor(() => hasButton('Load topics') && !button('Load topics').disabled, 'Load topics is usable after signing in again');
    click(button('Load topics'));
    await waitFor(() => pulledTitles().length > 0, "the new session's pull lands");
    assert.equal(server.topicRequests(), 2, "the new session's pull started while the old one was still held");
    await act(async () => { server.held.resolve(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    assert.deepEqual(pulledTitles(), ['pulled with Bearer token-reconnected'], "the disconnected session's late answer is dropped");
  });
});
