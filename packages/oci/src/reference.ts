/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { OciError } from './errors.js';
import type { OciReference, OciRepositoryRef } from './types.js';

// Grammar from the OCI distribution spec (and docker/distribution's
// reference package). A path component is lowercase alphanumerics joined by
// `.`, `_`, `__` or runs of `-`.
const PATH_COMPONENT = /^[a-z0-9]+(?:(?:\.|_|__|-+)[a-z0-9]+)*$/;
const TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/;
const DOMAIN_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
const IPV6 = /^\[[0-9A-Fa-f:.]+\]$/;
const MAX_REPOSITORY_LENGTH = 255;

function invalid(input: string, why: string): OciError {
  return new OciError('INVALID_REFERENCE', `Invalid OCI reference "${input}": ${why}`);
}

/** True when a `host` (`name[:port]`) or bare hostname is listed as insecure. */
export function isInsecureHost(host: string, insecureHosts: readonly string[] | undefined): boolean {
  if (!insecureHosts || insecureHosts.length === 0) return false;
  const lowered = host.toLowerCase();
  const hostname = splitHost(lowered).hostname;
  return insecureHosts.some((entry) => {
    const e = entry.toLowerCase();
    return e === lowered || e === hostname;
  });
}

function splitHost(host: string): { hostname: string; port?: string } {
  if (host.startsWith('[')) {
    const close = host.indexOf(']');
    if (close < 0) return { hostname: host };
    const rest = host.slice(close + 1);
    return rest.startsWith(':') ? { hostname: host.slice(0, close + 1), port: rest.slice(1) } : { hostname: host.slice(0, close + 1) };
  }
  const colon = host.lastIndexOf(':');
  return colon < 0 ? { hostname: host } : { hostname: host.slice(0, colon), port: host.slice(colon + 1) };
}

function validateRegistry(input: string, registry: string): void {
  if (registry.includes('@')) throw invalid(input, 'userinfo (user@host) is not allowed in a reference');
  const { hostname, port } = splitHost(registry);
  if (port !== undefined) {
    if (!/^[0-9]{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
      throw invalid(input, `"${port}" is not a valid port (a tag goes after the repository, not the host)`);
    }
  }
  if (IPV6.test(hostname)) return;
  const labels = hostname.split('.');
  if (labels.some((label) => !DOMAIN_LABEL.test(label))) {
    throw invalid(input, `"${hostname}" is not a valid registry host`);
  }
}

function validateRepository(input: string, repository: string): void {
  if (repository.length === 0) throw invalid(input, 'missing repository path');
  if (repository.length > MAX_REPOSITORY_LENGTH) {
    throw invalid(input, `repository is longer than ${MAX_REPOSITORY_LENGTH} characters`);
  }
  for (const component of repository.split('/')) {
    if (component === '') throw invalid(input, 'empty path segment in repository');
    if (component === '.' || component === '..') throw invalid(input, 'relative path segment in repository');
    if (component !== component.toLowerCase()) throw invalid(input, 'repository names must be lowercase');
    if (!PATH_COMPONENT.test(component)) throw invalid(input, `"${component}" is not a valid repository path component`);
  }
}

/**
 * Parses `[oci://]host[:port]/repo[/more][:tag][@sha256:<hex>]`.
 *
 * The first path segment is the registry only if it contains `.` or `:` or
 * is `localhost`; there is no implicit `docker.io`, so `library/alpine` is
 * rejected rather than silently resolved against a registry the caller never
 * named. The origin is `https:` unless the host appears in `insecureHosts`.
 * A repository-only reference (no tag, no digest) is valid for `tags()`.
 */
export function parseReference(input: string, options: { insecureHosts?: readonly string[] } = {}): OciReference {
  let rest = input;
  if (rest.startsWith('oci://')) rest = rest.slice('oci://'.length);
  else if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(rest)) throw invalid(input, 'only the oci:// prefix is accepted');
  if (rest.length === 0) throw invalid(input, 'empty reference');
  if (/[\s\\?#%]/.test(rest)) throw invalid(input, 'contains whitespace or URL syntax');

  const slash = rest.indexOf('/');
  if (slash < 0) throw invalid(input, 'expected host/repository');
  const registryRaw = rest.slice(0, slash);
  if (registryRaw.length === 0) throw invalid(input, 'missing registry host');
  if (!(registryRaw.includes('.') || registryRaw.includes(':') || registryRaw === 'localhost')) {
    throw invalid(input, `"${registryRaw}" is not a registry host (no implicit default registry; name the host, e.g. ghcr.io/${rest})`);
  }
  validateRegistry(input, registryRaw);
  const registry = registryRaw.toLowerCase();

  let path = rest.slice(slash + 1);
  let digest: string | undefined;
  const at = path.indexOf('@');
  if (at >= 0) {
    digest = path.slice(at + 1);
    path = path.slice(0, at);
    if (!digest.startsWith('sha256:')) throw invalid(input, 'only sha256 digests are supported');
    if (!SHA256_DIGEST.test(digest)) throw invalid(input, 'digest must be sha256: followed by 64 lowercase hex characters');
  }

  let tag: string | undefined;
  const lastSlash = path.lastIndexOf('/');
  const colon = path.indexOf(':', lastSlash + 1);
  if (colon >= 0) {
    tag = path.slice(colon + 1);
    path = path.slice(0, colon);
    if (!TAG.test(tag)) throw invalid(input, `"${tag}" is not a valid tag`);
  }
  if (path.includes(':')) throw invalid(input, 'unexpected ":" in repository path');
  validateRepository(input, path);

  const scheme = isInsecureHost(registry, options.insecureHosts) ? 'http' : 'https';
  const ref: OciReference = { registry, origin: `${scheme}://${registry}`, repository: path };
  if (tag !== undefined) ref.tag = tag;
  if (digest !== undefined) ref.digest = digest;
  return ref;
}

/**
 * Validates an `OciReference` handed to the client (it may have been built by
 * hand rather than by `parseReference`) and returns its normalized origin.
 */
export function checkRepositoryRef(ref: OciRepositoryRef, insecureHosts: readonly string[] | undefined): string {
  let url: URL;
  try {
    url = new URL(ref.origin);
  } catch (err) {
    throw new OciError('INVALID_REFERENCE', `Invalid registry origin "${ref.origin}"`, { cause: err });
  }
  if (url.username || url.password) throw new OciError('INVALID_REFERENCE', 'Registry origin must not carry userinfo');
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new OciError('INVALID_REFERENCE', `Registry origin "${ref.origin}" must be scheme://host[:port] only`);
  }
  if (url.protocol === 'http:') {
    if (!isInsecureHost(url.host, insecureHosts)) {
      throw new OciError('INVALID_REFERENCE', `Refusing plain http to ${url.host}; list it in insecureHosts to allow it`);
    }
  } else if (url.protocol !== 'https:') {
    throw new OciError('INVALID_REFERENCE', `Unsupported registry origin scheme ${url.protocol}`);
  }
  validateRepository(ref.repository, ref.repository);
  return url.origin;
}

/** Checks the tag/digest an `OciReference` carries and returns the manifest reference to request. */
export function manifestReference(ref: OciReference): string {
  if (ref.digest !== undefined) {
    if (!SHA256_DIGEST.test(ref.digest)) throw new OciError('INVALID_REFERENCE', `Invalid digest "${ref.digest}"`);
    return ref.digest;
  }
  if (ref.tag !== undefined) {
    if (!TAG.test(ref.tag)) throw new OciError('INVALID_REFERENCE', `Invalid tag "${ref.tag}"`);
    return ref.tag;
  }
  throw new OciError('INVALID_REFERENCE', `Reference to ${ref.repository} names neither a tag nor a digest`);
}

export function isSha256Digest(value: string): boolean {
  return SHA256_DIGEST.test(value);
}
