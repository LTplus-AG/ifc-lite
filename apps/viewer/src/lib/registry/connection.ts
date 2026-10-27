/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { RegistryError, releaseName, repositoryName } from './transport';
export interface RegistryAddress { origin: string; repository?: string; reference?: string }
export const localRegistryAddress = import.meta.env?.VITE_REGISTRY_ADDRESS ?? 'http://127.0.0.1:5000';
const loopback = new Set(['localhost', '127.0.0.1', '[::1]']);

/** The dev proxy stays pinned to one explicit local destination; pasted URLs cannot route it. */
export function parseRegistryAddress(input: string, allowed = localRegistryAddress): RegistryAddress {
  let url: URL;
  try { url = new URL(input.trim().replace(/^oci:\/\//, 'http://').replace(/^(?![a-z]+:\/\/)/i, 'http://')); }
  catch { throw new RegistryError('Paste a registry address, for example http://localhost:5000.'); }
  const pinned = new URL(allowed);
  if (url.username || url.password || url.search || url.hash || !loopback.has(url.hostname) ||
    url.protocol !== pinned.protocol || url.port !== pinned.port || !loopback.has(pinned.hostname)) {
    throw new RegistryError(`This demo connects to the local registry at ${pinned.origin}. Paste an address from that registry.`);
  }
  let path: string;
  try { path = decodeURIComponent(url.pathname).replace(/^\/v2(?:\/|$)/, '').replace(/^\/+|\/+$/g, ''); }
  catch { throw new RegistryError('The registry address contains an invalid model path.'); }
  let reference: string | undefined;
  const manifest = path.lastIndexOf('/manifests/');
  if (manifest >= 0) { reference = path.slice(manifest + 11); path = path.slice(0, manifest); }
  else if (path.includes('@')) {
    const parts = path.split('@');
    if (parts.length !== 2) throw new RegistryError('The release address is not valid.');
    [path, reference] = parts;
  }
  else if (path.includes(':')) { const split = path.lastIndexOf(':'); reference = path.slice(split + 1); path = path.slice(0, split); }
  if (reference === '') throw new RegistryError('The release address is missing its version.');
  if (path) repositoryName(path);
  if (reference && !/^sha256:[a-f0-9]{64}$/.test(reference)) releaseName(reference);
  if (reference && !path) throw new RegistryError('The release address is missing its model name.');
  return { origin: pinned.origin, repository: path || undefined, reference };
}
