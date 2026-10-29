/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { RegistryError, REGISTRY_REFRESH_COOKIE, responseBytes, registryTokenSession } from './protocol';

/** Serialize cookie rotation and revocation across tabs sharing the viewer's cookie jar. */
export async function registrySessionLock<T>(registryOrigin: string, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const locks = globalThis.navigator?.locks;
  if (!locks) throw new RegistryError('Registry browser sign-in requires a browser with Web Locks support.');
  return locks.request(`ifc-lite:registry-session:${registryOrigin}`, { mode: 'exclusive', signal }, operation);
}

export async function registryJsonReply(response: Response): Promise<unknown> {
  if (!response.ok) throw new RegistryError(`Registry sign-in failed (${response.status}).`, response.status);
  const body = new TextDecoder().decode(await responseBytes(response, 64 * 1024));
  try { return JSON.parse(body); }
  catch { throw new RegistryError('The registry returned an invalid sign-in response.'); }
}

export async function exchangeRegistrySession(origin: string, registryOrigin: string, clientId: string, body: URLSearchParams,
  repository: string | null, signal: AbortSignal, remembered = true) {
  return registrySessionLock(registryOrigin, async () => {
    signal.throwIfAborted();
    const reply = await registryJsonReply(await fetch(new URL('/oauth/token', origin), {
      method: 'POST', credentials: remembered ? 'include' : 'omit', referrerPolicy: 'same-origin', redirect: 'error', cache: 'no-store', signal,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body,
    }));
    signal.throwIfAborted();
    return registryTokenSession(reply, repository, clientId);
  }, signal);
}

export async function revokeRegistrySession(origin: string, registryOrigin: string, clientId: string, refreshToken?: string) {
  const signal = AbortSignal.timeout(15000);
  return registrySessionLock(registryOrigin, async () => {
    const body = new URLSearchParams({ client_id: clientId });
    if (refreshToken) body.set('token', refreshToken);
    const response = await fetch(new URL('/oauth/revoke', origin), { method: 'POST', credentials: refreshToken ? 'omit' : 'include', referrerPolicy: 'same-origin', redirect: 'error', cache: 'no-store',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body, signal });
    if (!response.ok) throw new RegistryError('Could not finish signing out of the registry. Please retry.', response.status);
  }, signal);
}

export function validateRegistrySessionConfig(value: object): void {
  if (!('refresh_cookie_name' in value) || value.refresh_cookie_name !== REGISTRY_REFRESH_COOKIE ||
    !('revocation_endpoint' in value) || value.revocation_endpoint !== '/oauth/revoke' ||
    !('session_max_age' in value) || value.session_max_age !== 8 * 3600 ||
    !('remembered_session_max_age' in value) || value.remembered_session_max_age !== 30 * 24 * 3600) {
    throw new RegistryError('This registry does not support the required browser session configuration.');
  }
}
