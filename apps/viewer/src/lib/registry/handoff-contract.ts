/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { repositoryName, RegistryError } from './protocol';

export const HANDOFF_PROTOCOL = 'oci-handoff/1';
export const HANDOFF_PATH = '/open-artifact';
export const HANDOFF_CALLBACK = '/open-artifact/callback';
export interface TokenExchangeSettings {
  endpoint: string;
  authorization_resource: string;
  read_scope: string;
  write_scope: string;
  publication_endpoint?: string;
}
export interface RegistryConnection {
  name?: string;
  registry: string;
  authorization_server: string;
  client_id: string;
  token_exchange?: TokenExchangeSettings;
}
export interface ArtifactSource { registry: string; repository: string; digest: string }
export interface ArtifactDestination { registry: string; repository: string }
export interface OciHandoff { protocol: typeof HANDOFF_PROTOCOL; source: ArtifactSource; intent: 'view' | 'edit'; destination?: ArtifactDestination }

export function webAddress(value: string): URL {
  const url = new URL(value);
  if (url.username || url.password || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
    throw new RegistryError('Use a trusted HTTPS address or a local development address.');
  }
  return url;
}
export function registryOrigin(value: string): string {
  const url = webAddress(value);
  if (url.pathname !== '/' || url.search || value !== url.origin) throw new RegistryError('Use the configured registry address without a folder or trailing slash.');
  return url.origin;
}
function tokenExchangeSettings(value: unknown): TokenExchangeSettings {
  if (!value || typeof value !== 'object' ||
    !('endpoint' in value) || typeof value.endpoint !== 'string' ||
    !('authorization_resource' in value) || typeof value.authorization_resource !== 'string' ||
    !('read_scope' in value) || typeof value.read_scope !== 'string' || !value.read_scope.trim() ||
    !('write_scope' in value) || typeof value.write_scope !== 'string' || !value.write_scope.trim()) {
    throw new RegistryError('Configure the token exchange endpoint, resource, and sign-in scopes.');
  }
  const resource = webAddress(value.authorization_resource);
  const endpoint = webAddress(value.endpoint);
  if (endpoint.origin !== resource.origin) throw new RegistryError('Use a token exchange endpoint on the configured authorization resource origin.');
  let publication_endpoint: string | undefined;
  if ('publication_endpoint' in value) {
    if (typeof value.publication_endpoint !== 'string' || webAddress(value.publication_endpoint).origin !== resource.origin) {
      throw new RegistryError('Use a publication endpoint on the configured authorization resource origin.');
    }
    publication_endpoint = value.publication_endpoint;
  }
  return { endpoint: value.endpoint, authorization_resource: value.authorization_resource,
    read_scope: value.read_scope, write_scope: value.write_scope, publication_endpoint };
}
export function registryConnections(input = import.meta.env?.VITE_REGISTRY_CONNECTIONS): RegistryConnection[] {
  if (!input) return [];
  const value: unknown = JSON.parse(input);
  if (!Array.isArray(value) || !value.length || value.length > 32) throw new RegistryError('Configure the available file stores for this application.');
  const seen = new Set<string>();
  return value.map((entry: unknown) => {
    if (!entry || typeof entry !== 'object' || !('registry' in entry) || typeof entry.registry !== 'string' ||
      !('authorization_server' in entry) || typeof entry.authorization_server !== 'string' || !('client_id' in entry) || typeof entry.client_id !== 'string' || !entry.client_id) throw new RegistryError('Invalid file-store connection configuration.');
    const registry = registryOrigin(entry.registry);
    const issuer = webAddress(entry.authorization_server);
    if (issuer.search || seen.has(registry)) throw new RegistryError('Configure a unique file store and an exact authorization issuer.');
    seen.add(registry);
    return { registry, authorization_server: entry.authorization_server, client_id: entry.client_id,
      name: 'name' in entry && typeof entry.name === 'string' ? entry.name : undefined,
      token_exchange: 'token_exchange' in entry ? tokenExchangeSettings(entry.token_exchange) : undefined };
  });
}
export function connectionFor(registry: string, connections = registryConnections()): RegistryConnection {
  const connection = connections.find(c => c.registry === registryOrigin(registry));
  if (!connection) throw new RegistryError('Ask your administrator to configure this file store before opening it.');
  return connection;
}
export function handoffContext(value: unknown, connections = registryConnections()): OciHandoff {
  if (!value || typeof value !== 'object' || !('protocol' in value) || value.protocol !== HANDOFF_PROTOCOL ||
    !('intent' in value) || (value.intent !== 'view' && value.intent !== 'edit') || !('source' in value) || !value.source || typeof value.source !== 'object') throw new RegistryError('This file-opening link is invalid.');
  const source = value.source;
  if (!('registry' in source) || typeof source.registry !== 'string' || !('repository' in source) || typeof source.repository !== 'string' ||
    !('digest' in source) || typeof source.digest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(source.digest)) throw new RegistryError('Open a version identified by its complete content fingerprint.');
  connectionFor(source.registry, connections);
  let destination: ArtifactDestination | undefined;
  if ('destination' in value && value.destination !== undefined) {
    const target = value.destination;
    if (!target || typeof target !== 'object' || !('registry' in target) || typeof target.registry !== 'string' || !('repository' in target) || typeof target.repository !== 'string') throw new RegistryError('The suggested save location is invalid.');
    connectionFor(target.registry, connections);
    destination = { registry: target.registry, repository: repositoryName(target.repository) };
  }
  return { protocol: HANDOFF_PROTOCOL, source: { registry: source.registry, repository: repositoryName(source.repository), digest: source.digest }, intent: value.intent, ...(destination ? { destination } : {}) };
}
export function artifactSource(value: unknown, registry: string): ArtifactSource {
  if (!value || typeof value !== 'object' || !('registry' in value) || value.registry !== registry ||
      !('repository' in value) || typeof value.repository !== 'string' ||
      !('digest' in value) || typeof value.digest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value.digest)) {
    throw new RegistryError('The file store did not identify a saved version.');
  }
  return { registry, repository: repositoryName(value.repository), digest: value.digest };
}
export function readHandoff(href: string, connections = registryConnections()): OciHandoff {
  const url = new URL(href), params = new URLSearchParams(url.hash.slice(1));
  const encoded = params.get('handoff');
  if (url.pathname !== HANDOFF_PATH || url.search || params.size !== 1 || !encoded || encoded.length > 8192 || !/^[A-Za-z0-9_-]+$/.test(encoded)) throw new RegistryError('Return to the files and choose Open with again.');
  return handoffContext(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(encoded.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0)))), connections);
}
