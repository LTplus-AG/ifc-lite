/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { repositoryName, RegistryError } from './protocol';
const localRegistryAddress = import.meta.env?.VITE_REGISTRY_ADDRESS ?? 'http://localhost:5001';

export const HANDOFF_PROTOCOL = 'oci-handoff/1';
export const HANDOFF_PATH = '/open-artifact';
export const HANDOFF_CALLBACK = '/open-artifact/callback';
export interface RegistryConnection { name?: string; registry: string; authorization_server: string; client_id: string }
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
export function registryConnections(input = import.meta.env?.VITE_REGISTRY_CONNECTIONS): RegistryConnection[] {
  const value: unknown = input ? JSON.parse(input) : [{ registry: localRegistryAddress, authorization_server: 'http://localhost:8080/realms/subsoil', client_id: 'ifc-lite' }];
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
      name: 'name' in entry && typeof entry.name === 'string' ? entry.name : undefined };
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
export function readHandoff(href: string, connections = registryConnections()): OciHandoff {
  const url = new URL(href), params = new URLSearchParams(url.hash.slice(1));
  const encoded = params.get('handoff');
  if (url.pathname !== HANDOFF_PATH || url.search || params.size !== 1 || !encoded || encoded.length > 8192 || !/^[A-Za-z0-9_-]+$/.test(encoded)) throw new RegistryError('Return to the files and choose Open with again.');
  return handoffContext(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(encoded.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0)))), connections);
}
