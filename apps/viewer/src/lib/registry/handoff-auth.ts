/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createAuthorizationRequest, waitForOAuthCallback } from '@ifc-lite/oauth-pkce';

import { RegistryError, repositoryName, responseBytes } from './protocol';
import { connectionFor, HANDOFF_CALLBACK, handoffContext, readHandoff, registryConnections, webAddress, type OciHandoff, type RegistryConnection } from './handoff-contract';

export interface ResourceSession { accessToken: string; expiresAt: number; registry: string; scope: string }
interface Metadata { authorization_endpoint: string; token_endpoint: string; issuerInCallback: boolean }
interface AuthorizationRequest { scope: string; resource: string }
interface Pending { handoff: OciHandoff; registry: string; issuer: string; issuerRequired: boolean; clientId: string; redirectUri: string; state: string; verifier: string; scope: string; created: number }
const PENDING = 'ifc-lite:oci-handoff:pkce';
export const PUSH_CALLBACK = '/oauth/registry/callback';
const TIMEOUT = 5 * 60 * 1000;

function validateRegistryCallback(href: string, redirectUri: string, state: string, issuer: string, issuerRequired: boolean): string {
  const callback = new URL(href), expected = new URL(redirectUri);
  if (callback.origin !== expected.origin || callback.pathname !== expected.pathname || callback.username || callback.password || callback.hash || callback.searchParams.getAll('state').length !== 1 || callback.searchParams.get('state') !== state || callback.searchParams.getAll('code').length !== 1 || callback.searchParams.has('error')) throw new RegistryError('The authorization response was cancelled or did not match this request.');
  const issuers = callback.searchParams.getAll('iss');
  if ((issuerRequired || issuers.length > 0) && (issuers.length !== 1 || issuers[0] !== issuer)) {
    throw new RegistryError('The authorization response did not identify the expected issuer.');
  }
  return callback.searchParams.get('code')!;
}
function hasOtherIssuer(connection: RegistryConnection, connections: readonly RegistryConnection[]): boolean {
  // All configured issuers share the same callback URL for each flow.
  return connections.some(other => other.authorization_server !== connection.authorization_server);
}
async function json(response: Response): Promise<unknown> {
  if (!response.ok) throw new RegistryError(`File-store authorization failed (${response.status}). Sign in again or ask the owner for access.`, response.status);
  return JSON.parse(new TextDecoder().decode(await responseBytes(response, 64 * 1024)));
}
export async function authorizationMetadata(connection: RegistryConnection, signal: AbortSignal): Promise<Metadata> {
  const issuer = webAddress(connection.authorization_server);
  const url = new URL(`/.well-known/oauth-authorization-server${issuer.pathname === '/' ? '' : issuer.pathname}`, issuer.origin);
  let reply = await fetch(url, { credentials: 'omit', redirect: 'error', cache: 'no-store', signal });
  // OIDC discovery is also a standard metadata route, used by Keycloak.
  if (reply.status === 404) {
    await reply.body?.cancel();
    const discovery = new URL(issuer.pathname.replace(/\/$/, '') + '/.well-known/openid-configuration', issuer.origin);
    reply = await fetch(discovery, { credentials: 'omit', redirect: 'error', cache: 'no-store', signal });
  }
  const value = await json(reply);
  if (!value || typeof value !== 'object' || !('issuer' in value) || value.issuer !== connection.authorization_server ||
    !('authorization_endpoint' in value) || typeof value.authorization_endpoint !== 'string' || !('token_endpoint' in value) || typeof value.token_endpoint !== 'string' ||
    !('response_types_supported' in value) || !Array.isArray(value.response_types_supported) || !value.response_types_supported.includes('code') ||
    !('code_challenge_methods_supported' in value) || !Array.isArray(value.code_challenge_methods_supported) || !value.code_challenge_methods_supported.includes('S256')) throw new RegistryError('This authorization server must support Authorization Code with PKCE S256.');
  webAddress(value.authorization_endpoint); webAddress(value.token_endpoint);
  return {
    authorization_endpoint: value.authorization_endpoint,
    token_endpoint: value.token_endpoint,
    issuerInCallback: 'authorization_response_iss_parameter_supported' in value &&
      value.authorization_response_iss_parameter_supported === true,
  };
}
function bearerGrant(value: unknown): { token: string; expiresAt: number; scope?: string } {
  if (!value || typeof value !== 'object' || !('access_token' in value) || typeof value.access_token !== 'string' || !value.access_token ||
    !('token_type' in value) || typeof value.token_type !== 'string' || value.token_type.toLowerCase() !== 'bearer' ||
    !('expires_in' in value) || typeof value.expires_in !== 'number' || !Number.isSafeInteger(value.expires_in) || value.expires_in <= 0 ||
    ('scope' in value && typeof value.scope !== 'string')) throw new RegistryError('The authorization server returned an invalid access token response.');
  return { token: value.access_token, expiresAt: Date.now() + value.expires_in * 1000,
    scope: 'scope' in value && typeof value.scope === 'string' ? value.scope : undefined };
}
export function resourceSession(value: unknown, registry: string, requestedScope: string): ResourceSession {
  const grant = bearerGrant(value);
  const scope = grant.scope ?? requestedScope;
  const actions = (scopes: string) => new Set(scopes.split(/\s+/).filter(Boolean).flatMap(s => {
    const match = /^repository:([^:]+):([a-z,]+)$/.exec(s);
    if (!match || match[2].split(',').some(a => a !== 'pull' && a !== 'push')) throw new RegistryError('The authorization server returned unsupported permissions.');
    repositoryName(match[1]); return match[2].split(',').map(a => `${match[1]}:${a}`);
  }));
  const requested = actions(requestedScope), granted = actions(scope);
  if (!granted.size || [...granted].some(a => !requested.has(a))) throw new RegistryError('The returned access exceeds the requested folders and actions.');
  return { registry, scope, accessToken: grant.token, expiresAt: grant.expiresAt };
}
export function resourceAllows(session: ResourceSession, repository: string, action: 'pull' | 'push'): boolean {
  return session.expiresAt > Date.now() + 5000 && session.scope.split(/\s+/).some(s => {
    const [type, name, actions] = s.split(':'); return type === 'repository' && name === repository && actions.split(',').includes(action);
  });
}
const accessTokenType = 'urn:ietf:params:oauth:token-type:access_token';

function authorizationRequest(connection: RegistryConnection, repositoryScope: string, write: boolean): AuthorizationRequest {
  const exchange = connection.token_exchange;
  return exchange
    ? { scope: write ? exchange.write_scope : exchange.read_scope, resource: exchange.authorization_resource }
    : { scope: repositoryScope, resource: connection.registry };
}
function postToken(endpoint: string, body: URLSearchParams, signal: AbortSignal) {
  return fetch(endpoint, { method: 'POST', credentials: 'omit', redirect: 'error', cache: 'no-store', signal,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body }).then(json);
}

/** Exchange an OAuth access token for the exact registry repository actions requested. */
export async function exchangeRegistryToken(connection: RegistryConnection, subjectToken: string, scope: string, signal: AbortSignal): Promise<ResourceSession> {
  const exchange = connection.token_exchange;
  if (!exchange) throw new RegistryError('No token exchange endpoint is configured for this file store.');
  const response = await postToken(exchange.endpoint, new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
    client_id: connection.client_id,
    resource: connection.registry,
    scope,
    subject_token: subjectToken,
    subject_token_type: accessTokenType,
    requested_token_type: accessTokenType,
  }), signal);
  if (!response || typeof response !== 'object' || !('issued_token_type' in response) || response.issued_token_type !== accessTokenType) {
    throw new RegistryError('The token exchange did not issue registry access.');
  }
  return resourceSession(response, connection.registry, scope);
}
function redeem(
  connection: RegistryConnection, tokenEndpoint: string, redirectUri: string,
  code: string, verifier: string, resource: string, signal: AbortSignal,
): Promise<unknown> {
  return postToken(tokenEndpoint, new URLSearchParams({
    grant_type: 'authorization_code', client_id: connection.client_id, redirect_uri: redirectUri,
    code, code_verifier: verifier, resource,
  }), signal);
}
export async function prepareHandoff(href: string, signal: AbortSignal, connections = registryConnections()): Promise<string> {
  sessionStorage.removeItem(PENDING);
  const handoff = readHandoff(href, connections), connection = connectionFor(handoff.source.registry, connections);
  const metadata = await authorizationMetadata(connection, signal);
  const redirectUri = new URL(HANDOFF_CALLBACK, window.location.origin).href;
  const scope = `repository:${handoff.source.repository}:pull`;
  const authorization = authorizationRequest(connection, scope, false);
  const request = await createAuthorizationRequest({ authorizationEndpoint: metadata.authorization_endpoint, clientId: connection.client_id,
    redirectUri, scope: authorization.scope, extraParams: { resource: authorization.resource } });
  signal.throwIfAborted();
  const pending: Pending = { handoff, registry: connection.registry, issuer: connection.authorization_server, clientId: connection.client_id,
    issuerRequired: metadata.issuerInCallback || hasOtherIssuer(connection, connections),
    redirectUri, scope, state: request.state, verifier: request.codeVerifier, created: Date.now() };
  sessionStorage.setItem(PENDING, JSON.stringify(pending));
  return request.url;
}
export async function finishHandoff(href: string, signal: AbortSignal, connections = registryConnections()): Promise<{ handoff: OciHandoff; session: ResourceSession }> {
  const stored = sessionStorage.getItem(PENDING); sessionStorage.removeItem(PENDING);
  if (!stored || stored.length > 16384) throw new RegistryError('The opening request expired. Open the file again.');
  const p: unknown = JSON.parse(stored);
  if (!p || typeof p !== 'object' || !('handoff' in p) || !('registry' in p) || typeof p.registry !== 'string' || !('issuer' in p) || typeof p.issuer !== 'string' ||
    !('clientId' in p) || typeof p.clientId !== 'string' || !('redirectUri' in p) || p.redirectUri !== new URL(HANDOFF_CALLBACK, window.location.origin).href ||
    !('state' in p) || typeof p.state !== 'string' || !('verifier' in p) || typeof p.verifier !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(p.verifier) ||
    !('scope' in p) || typeof p.scope !== 'string' || !('created' in p) || typeof p.created !== 'number' || Date.now() < p.created || Date.now() - p.created > TIMEOUT) throw new RegistryError('The opening request expired or could not be verified.');
  const handoff = handoffContext(p.handoff, connections), connection = connectionFor(p.registry, connections);
  if (connection.registry !== handoff.source.registry || connection.authorization_server !== p.issuer || connection.client_id !== p.clientId || p.scope !== `repository:${handoff.source.repository}:pull`) throw new RegistryError('The file-store configuration changed. Open the file again.');
  const issuerRequired = !('issuerRequired' in p) || p.issuerRequired !== false || hasOtherIssuer(connection, connections);
  const code = validateRegistryCallback(href, p.redirectUri, p.state, p.issuer, issuerRequired);
  const metadata = await authorizationMetadata(connection, signal);
  const authorization = authorizationRequest(connection, p.scope, false);
  const reply = await redeem(connection, metadata.token_endpoint, p.redirectUri, code, p.verifier, authorization.resource, signal);
  const session = connection.token_exchange
    ? await exchangeRegistryToken(connection, bearerGrant(reply).token, p.scope, signal)
    : resourceSession(reply, connection.registry, p.scope);
  if (!resourceAllows(session, handoff.source.repository, 'pull')) throw new RegistryError('This account cannot open the selected folder.', 403);
  return { handoff, session };
}
async function repositoryGrant(connection: RegistryConnection, authorization: AuthorizationRequest, signal: AbortSignal, connections: readonly RegistryConnection[]): Promise<unknown> {
  const popup = window.open('about:blank', 'ifc-lite-oci-repository', 'width=520,height=720');
  if (!popup) throw new RegistryError('Allow the file-store sign-in popup and try again.');
  try {
    const metadata = await authorizationMetadata(connection, signal);
    const redirectUri = new URL(PUSH_CALLBACK, window.location.origin).href;
    const request = await createAuthorizationRequest({ authorizationEndpoint: metadata.authorization_endpoint, clientId: connection.client_id,
      redirectUri, scope: authorization.scope, extraParams: { resource: authorization.resource } });
    signal.throwIfAborted();
    const waiting = waitForOAuthCallback({ expectedState: request.state, timeoutMs: TIMEOUT, timeoutMessage: 'File-store sign-in timed out. Try again.', signal });
    popup.location.href = request.url;
    const code = validateRegistryCallback(await waiting, redirectUri, request.state, connection.authorization_server,
      metadata.issuerInCallback || hasOtherIssuer(connection, connections));
    return await redeem(connection, metadata.token_endpoint, redirectUri, code, request.codeVerifier, authorization.resource, signal);
  } finally { popup.close(); }
}

/** Write access is obtained independently of the read-only handoff grant. */
export async function authorizeRepository(connection: RegistryConnection, repository: string, action: 'pull' | 'push', signal: AbortSignal, connections: readonly RegistryConnection[]): Promise<ResourceSession> {
  repositoryName(repository);
  const write = action === 'push';
  const pull = `repository:${repository}:pull`;
  const scope = write ? `${pull} repository:${repository}:push` : pull;
  const reply = await repositoryGrant(connection, authorizationRequest(connection, scope, write), signal, connections);
  const session = connection.token_exchange
    ? await exchangeRegistryToken(connection, bearerGrant(reply).token, scope, signal)
    : resourceSession(reply, connection.registry, scope);
  if (!resourceAllows(session, repository, 'pull') || (write && !resourceAllows(session, repository, 'push'))) {
    throw new RegistryError(write
      ? 'Ask the owner for permission to view and publish in this folder.'
      : 'Ask the owner for permission to view this folder.', 403);
  }
  return session;
}
