/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readBody } from './digest.js';
import { OciError } from './errors.js';
import { isInsecureHost } from './reference.js';
import { guardedFetch } from './transport.js';
import type { OciCredentials } from './types.js';

export interface Challenge {
  /** Lowercased auth scheme (`bearer`, `basic`, ...). */
  scheme: string;
  /** Parameter names lowercased; values unquoted. */
  params: Record<string, string>;
}

const TOKEN_CHARS = /[A-Za-z0-9!#$%&'*+.^_`|~-]/;
const DEFAULT_EXPIRES_IN_SECONDS = 60;
/** Treat a token as expired this long before the server says it is. */
const EXPIRY_MARGIN_SECONDS = 5;
const MAX_TOKEN_RESPONSE_BYTES = 64 * 1024;

/**
 * Parses a `WWW-Authenticate` value (RFC 9110 §11.6.1) into challenges.
 * Handles quoted values containing commas (`scope="repository:a:pull,push"`),
 * backslash escapes, and several challenges joined by commas, which is how
 * `Headers.get` folds repeated headers.
 */
export function parseChallenges(header: string): Challenge[] {
  const out: Challenge[] = [];
  let i = 0;
  const n = header.length;
  const skipSpace = (): void => {
    while (i < n && (header[i] === ' ' || header[i] === '\t')) i++;
  };
  const readToken = (): string => {
    const start = i;
    while (i < n && TOKEN_CHARS.test(header[i])) i++;
    return header.slice(start, i);
  };
  let current: Challenge | undefined;
  while (i < n) {
    skipSpace();
    if (header[i] === ',') {
      i++;
      continue;
    }
    const start = i;
    const token = readToken();
    if (token === '') {
      i++; // stray character: skip it rather than loop forever
      continue;
    }
    skipSpace();
    if (header[i] === '=' && current) {
      i++;
      skipSpace();
      let value = '';
      if (header[i] === '"') {
        i++;
        while (i < n && header[i] !== '"') {
          if (header[i] === '\\' && i + 1 < n) i++;
          value += header[i];
          i++;
        }
        i++; // closing quote
      } else {
        value = readToken();
      }
      current.params[token.toLowerCase()] = value;
      continue;
    }
    // A token not followed by `=` starts a new challenge. (`token68`
    // credentials-style payloads are not used by registries and are skipped.)
    if (header[i] === '=' && !current) {
      while (i < n && header[i] !== ',') i++;
      continue;
    }
    current = { scheme: header.slice(start, start + token.length).toLowerCase(), params: {} };
    out.push(current);
  }
  return out;
}

function base64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function basicHeader(credentials: { username: string; password: string }): string {
  return `Basic ${base64Utf8(`${credentials.username}:${credentials.password}`)}`;
}

export function pullScope(repository: string): string {
  return `repository:${repository}:pull`;
}

export interface AuthOptions {
  fetch: typeof fetch;
  credentials?: OciCredentials;
  trustedRealms: ReadonlySet<string>;
  insecureHosts: readonly string[] | undefined;
  baseHeaders: Record<string, string>;
}

interface CachedAuth {
  authorization: string;
  /** Epoch ms; `Infinity` for static credentials. */
  expiresAt: number;
}

/**
 * Turns registry challenges into `Authorization` values and caches them per
 * registry origin and scope. Credential routing is the security boundary:
 *
 * - `{ token }` goes as `Bearer` to the registry origin only.
 * - `{ username, password }` goes as `Basic` to the registry origin (Basic
 *   challenge), or to a Bearer token realm only when that realm is on the
 *   registry's own origin or is listed in `trustedRealms`. A realm on any
 *   other origin gets an anonymous token request.
 */
export class RegistryAuth {
  private readonly cache = new Map<string, CachedAuth>();
  private readonly inflight = new Map<string, Promise<string>>();

  constructor(private readonly options: AuthOptions) {}

  /** A still-valid cached `Authorization` value, if any. */
  cached(origin: string, scope: string): string | undefined {
    const key = `${origin} ${scope}`;
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (Date.now() >= entry.expiresAt) {
      this.cache.delete(key);
      return undefined;
    }
    return entry.authorization;
  }

  invalidate(origin: string, scope: string): void {
    this.cache.delete(`${origin} ${scope}`);
  }

  /** Answers a 401 from `origin`; resolves to the `Authorization` value to retry with. */
  authorize(origin: string, scope: string, wwwAuthenticate: string | null, signal: AbortSignal | undefined): Promise<string> {
    const key = `${origin} ${scope}`;
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const promise = this.resolve(origin, scope, wwwAuthenticate, signal).then(
      (entry) => {
        this.cache.set(key, entry);
        return entry.authorization;
      },
    );
    const settled = promise.finally(() => this.inflight.delete(key));
    this.inflight.set(key, settled);
    return settled;
  }

  private async resolve(origin: string, scope: string, header: string | null, signal: AbortSignal | undefined): Promise<CachedAuth> {
    const credentials = this.options.credentials;
    if (credentials && 'token' in credentials) {
      return { authorization: `Bearer ${credentials.token}`, expiresAt: Number.POSITIVE_INFINITY };
    }
    const challenges = header ? parseChallenges(header) : [];
    const bearer = challenges.find((c) => c.scheme === 'bearer');
    if (bearer) return this.exchange(origin, scope, bearer, signal);
    const basic = challenges.find((c) => c.scheme === 'basic');
    if (basic) {
      if (!credentials) {
        throw new OciError('UNAUTHORIZED', `${origin} requires Basic credentials and none were configured`, { status: 401 });
      }
      return { authorization: basicHeader(credentials), expiresAt: Number.POSITIVE_INFINITY };
    }
    throw new OciError(
      'UNAUTHORIZED',
      header ? `${origin} answered 401 with an unsupported auth challenge` : `${origin} answered 401 without a WWW-Authenticate challenge`,
      { status: 401 },
    );
  }

  private async exchange(origin: string, scope: string, challenge: Challenge, signal: AbortSignal | undefined): Promise<CachedAuth> {
    const realmRaw = challenge.params.realm;
    if (!realmRaw) throw new OciError('PROTOCOL', `${origin}: Bearer challenge without a realm`, { status: 401 });
    let realm: URL;
    try {
      realm = new URL(realmRaw, origin);
    } catch (err) {
      throw new OciError('PROTOCOL', `${origin}: unparseable token realm`, { status: 401, cause: err });
    }
    if (realm.username || realm.password) throw new OciError('PROTOCOL', `${origin}: token realm carries userinfo`);
    if (realm.protocol === 'http:') {
      if (!isInsecureHost(realm.host, this.options.insecureHosts)) {
        throw new OciError('PROTOCOL', `${origin}: refusing plain-http token realm on ${realm.host}`);
      }
    } else if (realm.protocol !== 'https:') {
      throw new OciError('PROTOCOL', `${origin}: unsupported token realm scheme ${realm.protocol}`);
    }
    // The challenge's own `scope` is ignored: registries send a placeholder
    // there (GHCR's root challenge names `repository:user/image:pull`).
    if (challenge.params.service !== undefined) realm.searchParams.set('service', challenge.params.service);
    realm.searchParams.set('scope', scope);

    const headers: Record<string, string> = { ...this.options.baseHeaders, accept: 'application/json' };
    const credentials = this.options.credentials;
    if (credentials && 'username' in credentials) {
      const trusted = realm.origin === origin || this.options.trustedRealms.has(realm.origin);
      if (trusted) headers.authorization = basicHeader(credentials);
    }
    const response = await guardedFetch(this.options.fetch, realm.href, { method: 'GET', headers, redirect: 'manual', signal });
    const what = `token request to ${realm.origin}`;
    if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
      await response.body?.cancel();
      throw new OciError('PROTOCOL', `${what}: token realm redirected; not followed`, { status: response.status || undefined });
    }
    if (response.status === 401) {
      await response.body?.cancel();
      throw new OciError('UNAUTHORIZED', `${what}: credentials rejected (401)`, { status: 401 });
    }
    if (response.status === 403) {
      await response.body?.cancel();
      throw new OciError('DENIED', `${what}: access denied (403)`, { status: 403 });
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new OciError('PROTOCOL', `${what}: unexpected HTTP status ${response.status}`, { status: response.status });
    }
    const bytes = await readBody(response, { cap: MAX_TOKEN_RESPONSE_BYTES, what });
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(bytes));
    } catch (err) {
      throw new OciError('PROTOCOL', `${what}: reply is not JSON`, { cause: err });
    }
    if (typeof parsed !== 'object' || parsed === null) throw new OciError('PROTOCOL', `${what}: reply is not a JSON object`);
    const record = parsed as Record<string, unknown>;
    const token = typeof record.token === 'string' && record.token !== '' ? record.token : record.access_token;
    if (typeof token !== 'string' || token === '') {
      throw new OciError('PROTOCOL', `${what}: reply carries neither "token" nor "access_token"`);
    }
    const expiresIn =
      typeof record.expires_in === 'number' && Number.isFinite(record.expires_in) && record.expires_in > 0
        ? record.expires_in
        : DEFAULT_EXPIRES_IN_SECONDS;
    const lifetimeMs = Math.max(0, expiresIn - EXPIRY_MARGIN_SECONDS) * 1000;
    return { authorization: `Bearer ${token}`, expiresAt: Date.now() + lifetimeMs };
  }
}
