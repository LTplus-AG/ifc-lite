/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { OAUTH_CALLBACK_CHANNEL } from '@ifc-lite/oauth-pkce';
import { REGISTRY_CALLBACK_PATH } from '@/lib/registry/oauth';

// Use platform Web Locks when available; fill the DOM harness's missing API with a serialized fixture.
if (!globalThis.navigator?.locks) {
  const queues = new Map<string, Promise<void>>();
  const fallback: Pick<LockManager, 'request'> = {
    async request(name, optionsOrCallback, callback?) {
      const options = typeof optionsOrCallback === 'function' ? {} : optionsOrCallback;
      const run = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback;
      assert.equal(typeof run, 'function');
      if (typeof run !== 'function') throw new Error('A Web Locks callback is required');
      const before = queues.get(name) ?? Promise.resolve();
      let release!: () => void;
      const done = new Promise<void>(resolve => { release = resolve; });
      const queued = before.then(() => done); queues.set(name, queued);
      await before;
      try { options.signal?.throwIfAborted(); return await run({ name, mode: options.mode ?? 'exclusive' }); }
      finally { release(); if (queues.get(name) === queued) queues.delete(name); }
    },
  };
  Object.defineProperty(globalThis.navigator, 'locks', { configurable: true, value: fallback });
}

export function registryOAuthConfig(registryOrigin: string) {
  return { client_id: 'ifc-lite', authorization_endpoint: `${registryOrigin}/oauth/authorize`, token_endpoint: '/oauth/token', session_scope: 'example:session', scoped_token_endpoint: '/token',
    redirect_uris: [`${window.location.origin}${REGISTRY_CALLBACK_PATH}`], code_challenge_methods_supported: ['S256'],
    refresh_cookie_name: 'oci_registry_refresh', revocation_endpoint: '/oauth/revoke', session_max_age: 28800, remembered_session_max_age: 2592000 };
}

export function registryTokenReply(subject = 'writer', actions = ['pull', 'push'], remember = false) {
  const seconds = remember ? 2592000 : 28800;
  return { token: 'test-session-only', access_token: 'test-session-only', token_type: 'Bearer', expires_in: 900, subject,
    publication_headers: { publisher: 'example-registry-publisher', pushed_at: 'example-registry-pushed-at' },
    ...(remember ? {} : { refresh_token: 'test-refresh-only' }), remember_me: remember, session_expires_in: seconds, session_expires_at: Math.floor(Date.now() / 1000) + seconds,
    access: [{ type: 'registry', name: 'catalog', actions: ['read'] }, { type: 'repository', name: 'project/model', actions }] };
}

export function registryCallback(request: URL, code = 'test-code'): string {
  const callback = new URL(request.searchParams.get('redirect_uri')!);
  callback.searchParams.set('state', request.searchParams.get('state')!);
  callback.searchParams.set('code', code);
  return callback.href;
}

/** Emulate only the popup's navigation/handoff; execute the real PKCE client and token requests. */
export function installRegistryPopup(authorize: (request: URL) => string | Promise<string>) {
  const original = window.open;
  const requests: URL[] = [];
  const errors: unknown[] = [];
  let opens = 0;
  window.open = () => {
    opens++;
    return { close() {}, location: { set href(url: string) {
      const request = new URL(url); requests.push(request);
      void Promise.resolve().then(() => authorize(request)).then(callback => {
        const channel = new BroadcastChannel(OAUTH_CALLBACK_CHANNEL);
        channel.postMessage({ type: OAUTH_CALLBACK_CHANNEL, state: request.searchParams.get('state'), url: callback });
        channel.close();
      }, error => {
        errors.push(error);
        const callback = new URL(request.searchParams.get('redirect_uri')!);
        callback.searchParams.set('state', request.searchParams.get('state')!); callback.searchParams.set('error', 'fixture_error');
        callback.searchParams.set('error_description', error instanceof Error ? error.message : String(error));
        const channel = new BroadcastChannel(OAUTH_CALLBACK_CHANNEL);
        channel.postMessage({ type: OAUTH_CALLBACK_CHANNEL, state: request.searchParams.get('state'), url: callback.href });
        channel.close();
      });
    } }, get closed() { throw new Error('COOP popups cannot be polled'); } } as unknown as Window;
  };
  return { requests, errors, opens: () => opens, restore: () => { window.open = original; } };
}

async function expectRegistryStatus(response: Response, expected: number, step: string): Promise<void> {
  if (response.status === expected) return;
  const retryAfter = response.headers.get('retry-after');
  const body = await response.text();
  throw new Error(`Registry ${step} returned HTTP ${response.status} (expected ${expected})${retryAfter ? `; Retry-After: ${retryAfter}` : ''}; ${body}`);
}

/** Drive the real registry's credential/consent page, never the viewer's origin. */
export async function approveRegistryLogin(request: URL, subject: string, password: string, remember = false): Promise<string> {
  const response = await fetch(request, { redirect: 'manual' });
  await expectRegistryStatus(response, 200, 'authorization page');
  const cookie = response.headers.get('set-cookie')?.split(';')[0]; assert(cookie);
  const page = new DOMParser().parseFromString(await response.text(), 'text/html');
  const requestId = page.querySelector<HTMLInputElement>('input[name="request_id"]')?.value; assert(requestId);
  const body = new URLSearchParams({ request_id: requestId, username: subject, password, decision: 'allow' });
  if (remember) body.set('remember_me', 'true');
  const approved = await fetch(new URL('/oauth/authorize', request.origin), {
    method: 'POST', redirect: 'manual', headers: { Origin: request.origin, Cookie: cookie },
    body,
  });
  await expectRegistryStatus(approved, 303, 'consent');
  const callback = approved.headers.get('location'); assert(callback);
  return callback;
}
