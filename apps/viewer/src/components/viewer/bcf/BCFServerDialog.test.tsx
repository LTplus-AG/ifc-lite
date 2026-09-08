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
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { render, cleanup, click } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { clearBcfServerConfig, saveBcfServerConfig } from '@/services/bcf-server';
import type { BCFProject } from '@ifc-lite/bcf';
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
      return json({ oauth2_token_url: 'https://fake.example/bcf/oauth2/token' });
    }
    if (path === '/bcf/oauth2/token') {
      const form = new URLSearchParams(String(init?.body));
      if (form.get('password') !== 'right') {
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
  assert.ok(el, `input #${id} must render`);
  return el as HTMLInputElement;
}

function button(label: string): HTMLButtonElement {
  const el = [...document.body.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === label,
  );
  assert.ok(el, `button "${label}" must render`);
  return el as HTMLButtonElement;
}

/** Open a Radix Select by id and return its portaled options. */
function openSelect(triggerId: string): HTMLElement[] {
  const trigger = document.body.querySelector(`#${triggerId}`);
  assert.ok(trigger, `select trigger #${triggerId} must render`);
  act(() => {
    trigger.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }),
    );
  });
  return [...document.body.querySelectorAll('[role="option"]')] as HTMLElement[];
}

/** Commit a Radix Select option (Enter keydown, per Radix's keyboard model). */
function chooseOption(triggerId: string, label: string): void {
  const option = openSelect(triggerId).find((o) => o.textContent?.trim() === label);
  assert.ok(option, `option "${label}" must be offered`);
  act(() => {
    option.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
  });
}

/** Drive a React-controlled input the way typing does. */
function type(el: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value',
  )?.set;
  assert.ok(setter, 'HTMLInputElement value setter must exist');
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

describe('BCFServerDialog', () => {
  it('renders the sign-in form with Connect gated on all three fields', () => {
    installFakeServer();
    render(<BCFServerDialog open onOpenChange={() => {}} />);
    assert.ok(input('bcf-server-url'));
    assert.ok(input('bcf-server-user'));
    assert.ok(input('bcf-server-password'));
    assert.equal(button('Connect').disabled, true);
    type(input('bcf-server-url'), 'https://fake.example/bcf');
    type(input('bcf-server-user'), 'tester@example.com');
    assert.equal(button('Connect').disabled, true, 'password still missing');
    type(input('bcf-server-password'), 'right');
    assert.equal(button('Connect').disabled, false);
  });

  it('signs in, pulls the selected project, and hydrates the BCF store', async () => {
    installFakeServer();
    let openState = true;
    render(<BCFServerDialog open onOpenChange={(open) => (openState = open)} />);
    type(input('bcf-server-url'), 'https://fake.example/bcf');
    type(input('bcf-server-user'), 'tester@example.com');
    type(input('bcf-server-password'), 'right');
    click(button('Connect'));
    await waitFor(
      () => document.body.textContent?.includes('Signed in as tester@example.com') ?? false,
      'signed-in banner',
    );
    // Sign-in adopts the server identity as the BCF author.
    assert.equal(useViewerStore.getState().bcfAuthor, 'tester@example.com');
    await waitFor(
      () => document.body.textContent?.includes('Project One') ?? false,
      'project list',
    );
    click(button('Load topics'));
    await waitFor(() => useViewerStore.getState().bcfProject !== null, 'project in store');
    const project = useViewerStore.getState().bcfProject;
    assert.equal(project?.topics.size, 2);
    assert.equal(project?.topics.get('t1')?.title, 'First topic');
    assert.equal(project?.topics.get('t1')?.comments.length, 1);
    assert.deepEqual(project?.extensions?.topicStatuses, ['Open', 'Resolved']);
    assert.equal(openState, false, 'dialog closes after a successful pull');
  });

  it('pre-fills the URL and narrows auth methods when a known public server is picked', () => {
    installFakeServer();
    render(<BCFServerDialog open onOpenChange={() => {}} />);
    // Custom preset default: password fields shown.
    assert.ok(document.body.querySelector('#bcf-server-password'));
    chooseOption('bcf-server-preset', 'BIMData.io');
    assert.equal(input('bcf-server-url').value, 'https://api.bimdata.io/bcf');
    // Vendors default to the browser OAuth sign-in: password fields gone,
    // the client-id field and the registered-redirect-URI hint shown, and a
    // method dropdown offering the token-paste fallback.
    assert.equal(document.body.querySelector('#bcf-server-password'), null);
    assert.ok(document.body.querySelector('#bcf-server-oauth-client-id'));
    assert.ok(document.body.textContent?.includes('/oauth/bcf/callback'));
    assert.ok(document.body.querySelector('#bcf-server-auth'));
    chooseOption('bcf-server-auth', 'Access token');
    assert.ok(document.body.querySelector('#bcf-server-token'));
    assert.equal(document.body.querySelector('#bcf-server-oauth-client-id'), null);
  });

  it('clears the URL when switching from a fixed preset to a tenant-hosted one', () => {
    installFakeServer();
    render(<BCFServerDialog open onOpenChange={() => {}} />);
    chooseOption('bcf-server-preset', 'BIMData.io');
    assert.equal(input('bcf-server-url').value, 'https://api.bimdata.io/bcf');
    // BIMcollab is per-space: carrying BIMData's URL over would label one
    // server while connecting to another.
    chooseOption('bcf-server-preset', 'BIMcollab');
    assert.equal(input('bcf-server-url').value, '');
  });

  it('connects with a pasted access token', async () => {
    installFakeServer();
    render(<BCFServerDialog open onOpenChange={() => {}} />);
    chooseOption('bcf-server-auth', 'Access token');
    type(input('bcf-server-url'), 'https://fake.example/bcf');
    type(input('bcf-server-token'), 'pasted-token');
    click(button('Connect'));
    await waitFor(
      () => document.body.textContent?.includes('Signed in as tester@example.com') ?? false,
      'signed-in banner after token sign-in',
    );
    await waitFor(
      () => document.body.textContent?.includes('Project One') ?? false,
      'project list after token sign-in',
    );
  });

  it('requires a second, explicit click before replacing unsaved local topics', async () => {
    installFakeServer();
    const localProject: BCFProject = {
      version: '2.1',
      topics: new Map([
        [
          'local-1',
          {
            guid: 'local-1',
            title: 'Unsaved local topic',
            creationDate: '2026-08-25T10:00:00Z',
            creationAuthor: 'user@example.com',
            comments: [],
            viewpoints: [],
          },
        ],
      ]),
    };
    useViewerStore.setState({ bcfProject: localProject });
    render(<BCFServerDialog open onOpenChange={() => {}} />);
    type(input('bcf-server-url'), 'https://fake.example/bcf');
    type(input('bcf-server-user'), 'tester@example.com');
    type(input('bcf-server-password'), 'right');
    click(button('Connect'));
    await waitFor(
      () => document.body.textContent?.includes('Project One') ?? false,
      'project list',
    );
    click(button('Load topics'));
    await waitFor(
      () => document.body.textContent?.includes('replace the 1 topic') ?? false,
      'replace warning',
    );
    // First click must not have touched the local project.
    assert.equal(useViewerStore.getState().bcfProject, localProject);
    click(button('Replace and load'));
    await waitFor(
      () => useViewerStore.getState().bcfProject?.topics.has('t1') ?? false,
      'server project replaces local one after confirmation',
    );
    assert.equal(useViewerStore.getState().bcfProject?.topics.size, 2);
  });

  it('shows the server rejection on bad credentials and stores nothing', async () => {
    installFakeServer();
    render(<BCFServerDialog open onOpenChange={() => {}} />);
    type(input('bcf-server-url'), 'https://fake.example/bcf');
    type(input('bcf-server-user'), 'tester@example.com');
    type(input('bcf-server-password'), 'wrong');
    click(button('Connect'));
    await waitFor(
      () => document.body.textContent?.includes('bad credentials') ?? false,
      'error banner',
    );
    assert.equal(useViewerStore.getState().bcfProject, null);
  });

  it('rejects a plain-http server URL before contacting it', async () => {
    installFakeServer();
    const requested: string[] = [];
    const fakeServer = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requested.push(String(input));
      return fakeServer(input, init);
    }) as typeof fetch;
    render(<BCFServerDialog open onOpenChange={() => {}} />);
    type(input('bcf-server-url'), 'http://insecure.example/bcf');
    type(input('bcf-server-user'), 'tester@example.com');
    type(input('bcf-server-password'), 'right');
    click(button('Connect'));
    await waitFor(
      () =>
        document.body.textContent?.includes('BCF server URLs must use https://') ?? false,
      'the validateBcfServerUrl message',
    );
    assert.deepEqual(requested, [], 'no request may reach an http server');
  });

  it('adopts another tab signing into a different account on the same server', async () => {
    installFakeServer();
    saveBcfServerConfig({
      serverUrl: 'https://fake.example/bcf',
      userId: 'alice@example.com',
      accessToken: 'token-1',
      refreshToken: '',
      tokenExpiresAt: 0,
      clientId: '',
      clientSecret: '',
      projectId: 'p1',
      projectName: 'Project One',
    });
    render(<BCFServerDialog open onOpenChange={() => {}} />);
    await waitFor(
      () => document.body.textContent?.includes('Signed in as alice@example.com') ?? false,
      'alice banner',
    );
    const bob = {
      serverUrl: 'https://fake.example/bcf',
      userId: 'bob@example.com',
      accessToken: 'token-1',
      refreshToken: '',
      tokenExpiresAt: 0,
      clientId: '',
      clientSecret: '',
      projectId: 'p1',
      projectName: 'Project One',
    };
    localStorage.setItem('ifc-lite:bcf-server:v1', JSON.stringify(bob));
    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: 'ifc-lite:bcf-server:v1',
          newValue: JSON.stringify(bob),
        }),
      );
    });
    await waitFor(
      () => document.body.textContent?.includes('Signed in as bob@example.com') ?? false,
      'bob banner after cross-tab sign-in',
    );
  });

  it('drops a topic pull that finishes after another tab switches accounts', async () => {
    installFakeServer();
    let openTopics = () => {};
    const topicsGate = new Promise<void>((resolve) => {
      openTopics = resolve;
    });
    const inner = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith('/topics')) await topicsGate;
      return inner(input, init);
    }) as typeof fetch;
    saveBcfServerConfig({
      serverUrl: 'https://fake.example/bcf',
      userId: 'alice@example.com',
      accessToken: 'token-1',
      refreshToken: '',
      tokenExpiresAt: 0,
      clientId: '',
      clientSecret: '',
      projectId: 'p1',
      projectName: 'Project One',
    });
    let openState = true;
    render(<BCFServerDialog open onOpenChange={(open) => (openState = open)} />);
    await waitFor(
      () => document.body.textContent?.includes('Project One') ?? false,
      'alice project list',
    );
    click(button('Load topics'));
    const bob = {
      serverUrl: 'https://fake.example/bcf',
      userId: 'bob@example.com',
      accessToken: 'token-1',
      refreshToken: '',
      tokenExpiresAt: 0,
      clientId: '',
      clientSecret: '',
      projectId: 'p1',
      projectName: 'Project One',
    };
    localStorage.setItem('ifc-lite:bcf-server:v1', JSON.stringify(bob));
    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: 'ifc-lite:bcf-server:v1',
          newValue: JSON.stringify(bob),
        }),
      );
    });
    await waitFor(
      () => document.body.textContent?.includes('Signed in as bob@example.com') ?? false,
      'bob banner while alice pull is still in flight',
    );
    openTopics();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    assert.equal(useViewerStore.getState().bcfProject, null, 'alice topics must not land after the account switch');
    assert.equal(openState, true, 'dialog must stay open');
    assert.ok(
      document.body.textContent?.includes('Signed in as bob@example.com'),
      'banner must still show bob',
    );
  });
});
