/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { repositoryName, RegistryError } from './protocol';

export const HANDOFF_PROTOCOL = 'oci-handoff/1';
export const HANDOFF_PATH = '/open-artifact';
export const HANDOFF_CALLBACK = '/open-artifact/callback';
const CONNECTIONS_KEY = 'ifc-lite:oci-file-stores:v1';
const MAX_CONNECTIONS = 32;
export interface TokenExchangeSettings {
  endpoint: string;
  authorization_resource: string;
  read_scope: string;
  write_scope: string;
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

export function registryConnectionIdentity(connection: RegistryConnection): string {
  const exchange = connection.token_exchange;
  return JSON.stringify([
    connection.registry, connection.authorization_server, connection.client_id, connection.name,
    exchange?.endpoint, exchange?.authorization_resource, exchange?.read_scope, exchange?.write_scope,
  ]);
}

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
  return { endpoint: value.endpoint, authorization_resource: value.authorization_resource,
    read_scope: value.read_scope, write_scope: value.write_scope };
}
function parseConnection(entry: unknown): RegistryConnection {
  if (!entry || typeof entry !== 'object' || !('registry' in entry) || typeof entry.registry !== 'string' ||
      !('authorization_server' in entry) || typeof entry.authorization_server !== 'string' ||
      !('client_id' in entry) || typeof entry.client_id !== 'string' || !entry.client_id.trim()) {
    throw new RegistryError('Enter a registry address, authorization issuer, and client ID.');
  }
  const registry = webAddress(entry.registry.trim());
  if (registry.pathname !== '/' || registry.search) throw new RegistryError('Enter the registry origin without a folder or query.');
  const authorization_server = entry.authorization_server.trim();
  if (webAddress(authorization_server).search) throw new RegistryError('Enter the exact authorization issuer without a query.');
  return {
    registry: registry.origin, authorization_server, client_id: entry.client_id.trim(),
    name: 'name' in entry && typeof entry.name === 'string' ? entry.name : undefined,
    token_exchange: 'token_exchange' in entry && entry.token_exchange !== undefined ? tokenExchangeSettings(entry.token_exchange) : undefined,
  };
}

function parseConnections(input: string): RegistryConnection[] {
  const value: unknown = JSON.parse(input);
  if (!Array.isArray(value) || value.length > MAX_CONNECTIONS) throw new RegistryError('Invalid saved file stores.');
  const connections = value.map(parseConnection);
  if (new Set(connections.map(connection => connection.registry)).size !== connections.length) {
    throw new RegistryError('Save one file store per registry origin.');
  }
  return connections;
}

export function registryConnections(input?: string): RegistryConnection[] {
  if (input !== undefined) return parseConnections(input);
  try {
    const stored = globalThis.localStorage?.getItem(CONNECTIONS_KEY);
    return stored ? parseConnections(stored) : [];
  } catch {
    console.warn('Could not load saved file stores from browser storage.');
    return [];
  }
}

/** Unlike `registryConnections`, refuses unreadable storage so a save cannot overwrite it. */
function storedConnectionsForSave(): RegistryConnection[] {
  let stored: string | null | undefined;
  try {
    stored = globalThis.localStorage.getItem(CONNECTIONS_KEY);
  } catch {
    throw new RegistryError('Could not save the file store. Check that browser storage is available.');
  }
  try {
    return stored ? parseConnections(stored) : [];
  } catch {
    throw new RegistryError('The file stores saved in this browser could not be read, so none were changed.');
  }
}

export function saveRegistryConnection(value: RegistryConnection, replace?: boolean) {
  const connection = parseConnection(value);
  const existing = storedConnectionsForSave();
  const duplicate = existing.some(store => store.registry === connection.registry);
  if (duplicate && !replace) throw new RegistryError('This registry already has a file store. Select it and choose Edit file store.');
  if (replace && !duplicate) throw new RegistryError('This file store changed. Open the file-store settings again.');
  if (!duplicate && existing.length >= MAX_CONNECTIONS) throw new RegistryError('This browser already has 32 file stores.');
  const connections = duplicate
    ? existing.map(store => store.registry === connection.registry ? connection : store)
    : [...existing, connection];
  try {
    globalThis.localStorage.setItem(CONNECTIONS_KEY, JSON.stringify(connections));
  } catch {
    throw new RegistryError('Could not save the file store. Check that browser storage is available.');
  }
  return { connection, connections };
}
export function connectionFor(registry: string, connections = registryConnections()): RegistryConnection {
  const connection = connections.find(c => c.registry === registryOrigin(registry));
  if (!connection) throw new RegistryError('Add this file store in File → Cloud Sources, then reopen the link.');
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
/** The `/open-artifact` link that `readHandoff` decodes. */
export function handoffLink(source: ArtifactSource, intent: OciHandoff['intent']): string {
  const bytes = new TextEncoder().encode(JSON.stringify({ protocol: HANDOFF_PROTOCOL, source, intent }));
  const encoded = btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
  return `${HANDOFF_PATH}#handoff=${encoded}`;
}
export function readHandoff(href: string, connections = registryConnections()): OciHandoff {
  const url = new URL(href), params = new URLSearchParams(url.hash.slice(1));
  const encoded = params.get('handoff');
  if (url.pathname !== HANDOFF_PATH || url.search || params.size !== 1 || !encoded || encoded.length > 8192 || !/^[A-Za-z0-9_-]+$/.test(encoded)) throw new RegistryError('Return to the files and choose Open with again.');
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(encoded.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0))));
  } catch {
    throw new RegistryError('Return to the files and choose Open with again.');
  }
  return handoffContext(value, connections);
}
