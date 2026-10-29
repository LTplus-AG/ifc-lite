/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { OAUTH_CALLBACK_CHANNEL } from '@ifc-lite/oauth-pkce';
import { REGISTRY_CALLBACK_PATH } from '@/lib/registry/oauth';

export function registryOAuthConfig(registryOrigin: string) {
  return { client_id: 'ifc-lite', authorization_endpoint: `${registryOrigin}/oauth/authorize`, token_endpoint: '/oauth/token',
    redirect_uris: [`${window.location.origin}${REGISTRY_CALLBACK_PATH}`], code_challenge_methods_supported: ['S256'] };
}

export function registryTokenReply(subject = 'writer', actions = ['pull', 'push']) {
  return { token: 'test-session-only', access_token: 'test-session-only', token_type: 'Bearer', expires_in: 900, subject,
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
        callback.searchParams.set('state', request.searchParams.get('state')!); callback.searchParams.set('error', 'server_error');
        const channel = new BroadcastChannel(OAUTH_CALLBACK_CHANNEL);
        channel.postMessage({ type: OAUTH_CALLBACK_CHANNEL, state: request.searchParams.get('state'), url: callback.href });
        channel.close();
      });
    } }, get closed() { throw new Error('COOP popups cannot be polled'); } } as unknown as Window;
  };
  return { requests, errors, opens: () => opens, restore: () => { window.open = original; } };
}

/** Drive the real registry's credential/consent page, never the viewer's origin. */
export async function approveRegistryLogin(request: URL, subject: string, password: string): Promise<string> {
  const response = await fetch(request, { redirect: 'manual' });
  assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie')?.split(';')[0]; assert(cookie);
  const page = new DOMParser().parseFromString(await response.text(), 'text/html');
  const requestId = page.querySelector<HTMLInputElement>('input[name="request_id"]')?.value; assert(requestId);
  const approved = await fetch(new URL('/oauth/authorize', request.origin), {
    method: 'POST', redirect: 'manual', headers: { Origin: request.origin, Cookie: cookie },
    body: new URLSearchParams({ request_id: requestId, username: subject, password, decision: 'allow' }),
  });
  assert.equal(approved.status, 303);
  const callback = approved.headers.get('location'); assert(callback);
  return callback;
}
