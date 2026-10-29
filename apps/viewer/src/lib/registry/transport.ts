/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { localRegistryAddress } from './connection';
import { registryOAuthLogin } from './oauth';
import { RegistryError, repositoryName, type RegistrySession } from './protocol';

/** Registry-owned PKCE sign-in and scoped Bearer requests. No persistent secrets. */
export class RegistryTransport {
  private token: string | null = null;
  private generation = 0;
  private attempt: AbortController | null = null;
  private current: RegistrySession | null = null;
  readonly origin: string;

  constructor(origin: string, private readonly registryOrigin = localRegistryAddress) {
    const url = new URL(origin);
    if (url.username || url.password || (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
      throw new RegistryError('Use HTTPS or the local viewer address.');
    }
    this.origin = url.origin;
  }

  get session(): RegistrySession | null { return this.current; }
  can(action: 'pull' | 'push', repository = this.current?.repository): boolean {
    return Boolean(this.current && this.current.expiresAt > Date.now() && this.current.repositories.some(access => access.repository === repository && access.actions.includes(action)));
  }
  logout(): void {
    this.generation += 1;
    this.attempt?.abort(); this.attempt = null;
    this.token = null; this.current = null;
  }

  url(path: string): URL {
    const url = new URL(path, this.origin);
    if (url.origin !== this.origin || url.username || url.password) {
      throw new RegistryError('The registry tried to send a request to another address.');
    }
    return url;
  }

  async login(repository: string | null, signal?: AbortSignal): Promise<RegistrySession> {
    this.logout();
    const generation = this.generation;
    if (repository) repositoryName(repository);
    signal?.throwIfAborted();
    const attempt = new AbortController(); this.attempt = attempt;
    const abort = () => attempt.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const { token, session } = await registryOAuthLogin(this.origin, this.registryOrigin, repository, attempt.signal);
      attempt.signal.throwIfAborted();
      if (generation !== this.generation) throw new RegistryError('Sign-in was cancelled.');
      this.token = token; this.current = session;
      return session;
    } finally {
      signal?.removeEventListener('abort', abort);
      if (this.attempt === attempt) this.attempt = null;
    }
  }

  async request(path: string | URL, init: RequestInit = {}, allowMissing = false): Promise<Response> {
    if (!this.current || !this.token || this.current.expiresAt <= Date.now()) {
      this.logout();
      throw new RegistryError('Your sign-in has expired. Please sign in again.', 401);
    }
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${this.token}`);
    const target = this.url(path.toString());
    if (!target.pathname.startsWith('/v2/')) throw new RegistryError('The request is outside this registry connection.');
    const response = await fetch(target, { ...init, headers, credentials: 'omit', redirect: 'error' });
    if (response.status === 401) {
      this.logout();
      throw new RegistryError('Your sign-in has expired. Please sign in again.', 401);
    }
    if (response.status === 403) throw new RegistryError('Your account does not have permission for this action.', 403);
    if (!response.ok && !(allowMissing && response.status === 404)) {
      throw new RegistryError(`The registry request failed (${response.status}).`, response.status);
    }
    return response;
  }

  path(repository: string, suffix: string): string {
    if (!this.current) throw new RegistryError('Please sign in to the registry.', 401);
    if (!this.current.repositories.some(access => access.repository === repositoryName(repository) && access.actions.includes('pull'))) {
      throw new RegistryError('Sign in to the selected repository first.', 403);
    }
    return `/v2/${repository}/${suffix}`;
  }
}
