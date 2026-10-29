/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createAuthorizationRequest, parseAuthorizationCallback, waitForOAuthCallback } from '@ifc-lite/oauth-pkce';
import { RegistryError, responseBytes, registryTokenSession } from './protocol';

export const REGISTRY_CALLBACK_PATH = '/oauth/registry/callback';
const TIMEOUT_MS = 5 * 60 * 1000;

export function validateRegistryOAuthConfig(value: unknown, registryOrigin: string, redirectUri: string): { clientId: string; authorizationEndpoint: string } {
  if (!value || typeof value !== 'object' || !('client_id' in value) || typeof value.client_id !== 'string' || !/^[A-Za-z0-9._~-]{1,128}$/.test(value.client_id) ||
    !('authorization_endpoint' in value) || typeof value.authorization_endpoint !== 'string' ||
    !('token_endpoint' in value) || value.token_endpoint !== '/oauth/token' ||
    !('code_challenge_methods_supported' in value) || !Array.isArray(value.code_challenge_methods_supported) || !value.code_challenge_methods_supported.includes('S256') ||
    !('redirect_uris' in value) || !Array.isArray(value.redirect_uris) || !value.redirect_uris.includes(redirectUri)) {
    throw new RegistryError('Registry browser sign-in is not configured for this viewer. Register its callback address with ifcx-oci.');
  }
  const endpoint = new URL(value.authorization_endpoint);
  if (endpoint.origin !== new URL(registryOrigin).origin || endpoint.pathname !== '/oauth/authorize' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new RegistryError('The registry returned an unexpected sign-in address.');
  }
  return { clientId: value.client_id, authorizationEndpoint: endpoint.href };
}

export function validateRegistryCallback(callback: string, redirectUri: string, state: string): string {
  const received = new URL(callback);
  const expected = new URL(redirectUri);
  if (received.origin !== expected.origin || received.pathname !== expected.pathname || received.username || received.password || received.hash ||
    received.searchParams.getAll('state').length !== 1 || received.searchParams.getAll('code').length > 1 || received.searchParams.getAll('error').length > 1 ||
    received.searchParams.get('state') !== state || (received.searchParams.has('code') && received.searchParams.has('error'))) {
    throw new RegistryError('The registry sign-in response does not match this request.');
  }
  return parseAuthorizationCallback(callback, { expectedRedirectOrigin: expected.origin, expectedState: state }).code;
}

async function jsonReply(response: Response): Promise<unknown> {
  if (!response.ok) throw new RegistryError(`Registry sign-in failed (${response.status}).`, response.status);
  const body = new TextDecoder().decode(await responseBytes(response, 64 * 1024));
  try { return JSON.parse(body); }
  catch { throw new RegistryError('The registry returned an invalid sign-in response.'); }
}

/** Passwords are entered only on the registry origin; the viewer redeems a bound code. */
export async function registryOAuthLogin(origin: string, registryOrigin: string, repository: string | null, signal: AbortSignal) {
  signal.throwIfAborted();
  if (typeof window === 'undefined') throw new RegistryError('Registry sign-in requires a browser.');
  // Open synchronously in the click handler before discovery or Web Crypto can lose activation.
  const popup = window.open('about:blank', 'ifc-lite-registry-signin', 'width=520,height=720');
  if (!popup) throw new RegistryError('Allow the model registry sign-in popup and try again.');
  const attempt = new AbortController();
  const abort = () => attempt.abort(signal.reason);
  signal.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(() => attempt.abort(new RegistryError('Registry sign-in timed out. Please try again.')), TIMEOUT_MS);
  try {
    const redirectUri = `${window.location.origin}${REGISTRY_CALLBACK_PATH}`;
    const config = await jsonReply(await fetch(new URL('/oauth/config', origin), { credentials: 'omit', redirect: 'error', cache: 'no-store', signal: attempt.signal }));
    const { authorizationEndpoint, clientId } = validateRegistryOAuthConfig(config, registryOrigin, redirectUri);
    const request = await createAuthorizationRequest({ authorizationEndpoint, clientId, redirectUri,
      scope: repository ? `repository:${repository}:pull,push` : 'registry:catalog:read' });
    attempt.signal.throwIfAborted();
    const waiting = waitForOAuthCallback({ expectedState: request.state, timeoutMs: TIMEOUT_MS,
      timeoutMessage: 'Registry sign-in timed out. Please try again.', signal: attempt.signal });
    try { popup.location.href = request.url; }
    catch (error) { attempt.abort(error); }
    const code = validateRegistryCallback(await waiting, redirectUri, request.state);
    attempt.signal.throwIfAborted();
    // Retain the registry's subject/access extensions, which the generic OAuth token helper omits.
    const reply = await jsonReply(await fetch(new URL('/oauth/token', origin), {
      method: 'POST', credentials: 'omit', redirect: 'error', cache: 'no-store', signal: attempt.signal,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, redirect_uri: redirectUri, code, code_verifier: request.codeVerifier }),
    }));
    attempt.signal.throwIfAborted();
    return registryTokenSession(reply, repository);
  } finally {
    clearTimeout(timeout); attempt.abort();
    signal.removeEventListener('abort', abort);
    popup.close();
  }
}
