/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { localRegistryAddress } from './connection';
import { discoverRegistryOAuth, registryOAuthLogin } from './oauth';
import { exchangeRegistrySession, revokeRegistrySession } from './session-exchange';
import { RegistryError, repositoryName, type RegistrySession, type RegistryAuthorization } from './protocol';

/** Registry-owned PKCE sign-in and scoped Bearer requests. No persistent secrets. */
export class RegistryTransport {
  private token: string | null = null;
  private generation = 0;
  private attempt: AbortController | null = null;
  private current: RegistrySession | null = null;
  private authorization: RegistryAuthorization | null = null;
  private renewing: AbortController | null = null;
  private refreshing: Promise<RegistrySession> | null = null;
  private restoring: Promise<RegistrySession | null> | null = null;
  private pendingRevoke: { clientId: string; refreshToken?: string; remembered: boolean } | null = null;
  private suppressedRestore = false;
  private channel: BroadcastChannel | null = null;
  readonly origin: string;

  constructor(origin: string, private readonly registryOrigin = localRegistryAddress, private readonly onSession?: (session: RegistrySession | null) => void) {
    const url = new URL(origin);
    if (url.username || url.password || (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
      throw new RegistryError('Use HTTPS or the local viewer address.');
    }
    this.origin = url.origin;
  }

  get session(): RegistrySession | null { return this.current; }
  can(action: 'pull' | 'push', repository = this.current?.repository): boolean {
    return Boolean(this.current && !this.pendingRevoke && this.current.sessionExpiresAt > Date.now() && this.current.repositories.some(access => access.repository === repository && access.actions.includes(action)));
  }
  logout(notify = true): void {
    this.generation += 1;
    this.attempt?.abort(); this.attempt = null;
    this.renewing?.abort(); this.renewing = null; this.refreshing = null; this.restoring = null;
    this.token = null; this.current = null; this.authorization = null; this.suppressedRestore = true;
    this.channel?.close(); this.channel = null;
    if (notify) this.onSession?.(null);
  }

  private accept(authorization: RegistryAuthorization, generation: number, previous?: RegistryAuthorization): RegistrySession {
    if (generation !== this.generation) throw new DOMException('Registry sign-in was cancelled', 'AbortError');
    if (previous) {
      if (previous.session.subject !== authorization.session.subject || previous.session.remembered !== authorization.session.remembered) throw new RegistryError('The registry session identity changed. Please sign in again.');
      authorization.session.sessionExpiresAt = Math.min(previous.session.sessionExpiresAt, authorization.session.sessionExpiresAt);
    }
    this.authorization = authorization; this.token = authorization.token; this.current = authorization.session; this.suppressedRestore = false;
    if (!this.channel && typeof BroadcastChannel !== 'undefined') {
      this.channel = new BroadcastChannel('ifc-lite:registry-session');
      this.channel.onmessage = event => {
        const data: unknown = event.data;
        if (data && typeof data === 'object' && 'type' in data && data.type === 'signed-out' && 'registry' in data && data.registry === this.registryOrigin &&
          'clientId' in data && data.clientId === this.authorization?.clientId && this.authorization?.session.remembered) this.logout();
      };
    }
    this.onSession?.(this.current);
    return this.current;
  }

  async signOut(): Promise<void> {
    const authorization = this.authorization;
    const target = authorization ? { clientId: authorization.clientId, refreshToken: authorization.refreshToken, remembered: authorization.session.remembered }
      : this.pendingRevoke ?? { clientId: '', remembered: true };
    this.pendingRevoke = target;
    this.logout(false);
    if (!target.clientId) target.clientId = (await discoverRegistryOAuth(this.origin, this.registryOrigin, AbortSignal.timeout(15000))).clientId;
    await revokeRegistrySession(this.origin, this.registryOrigin, target.clientId, target.refreshToken);
    this.pendingRevoke = null; this.onSession?.(null);
    if (target.remembered && typeof BroadcastChannel !== 'undefined') {
      const channel = new BroadcastChannel('ifc-lite:registry-session');
      channel.postMessage({ type: 'signed-out', registry: this.registryOrigin, clientId: target.clientId }); channel.close();
    }
  }

  async restore(signal?: AbortSignal): Promise<RegistrySession | null> {
    if (this.current) return this.current;
    if (this.suppressedRestore || this.pendingRevoke) return null;
    if (this.restoring) return this.restoring;
    const generation = this.generation;
    const controller = new AbortController(); this.attempt = controller;
    const abort = () => controller.abort(signal?.reason);
    signal?.throwIfAborted(); signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(new RegistryError('Registry session restore timed out.')), 15000);
    const restoring = (async () => {
      try {
        const { clientId } = await discoverRegistryOAuth(this.origin, this.registryOrigin, controller.signal);
        const authorization = await exchangeRegistrySession(this.origin, this.registryOrigin, clientId,
          new URLSearchParams({ grant_type: 'refresh_token', client_id: clientId }), null, controller.signal);
        if (!authorization.session.remembered) throw new RegistryError('Invalid remembered registry session.');
        return this.accept(authorization, generation);
      } catch (error) {
        if (error instanceof RegistryError && [400, 401].includes(error.status)) return null;
        throw error;
      } finally {
        clearTimeout(timer); signal?.removeEventListener('abort', abort);
        if (this.attempt === controller) this.attempt = null;
      }
    })().finally(() => { if (this.restoring === restoring) this.restoring = null; });
    this.restoring = restoring;
    return restoring;
  }

  private renew(): Promise<RegistrySession> {
    if (this.refreshing) return this.refreshing;
    const previous = this.authorization;
    if (!previous || previous.session.sessionExpiresAt <= Date.now()) { this.logout(); return Promise.reject(new RegistryError('Your sign-in has expired. Please sign in again.', 401)); }
    const generation = this.generation;
    const controller = new AbortController(); this.renewing = controller;
    const timer = setTimeout(() => controller.abort(new RegistryError('Registry renewal timed out. Please reconnect.')), 15000);
    const body = new URLSearchParams({ grant_type: 'refresh_token', client_id: previous.clientId });
    if (previous.refreshToken) body.set('refresh_token', previous.refreshToken);
    const refreshing = exchangeRegistrySession(this.origin, this.registryOrigin, previous.clientId, body,
      previous.session.repository || null, controller.signal, previous.session.remembered)
      .then(authorization => this.accept(authorization, generation, previous))
      .catch((error: unknown) => { if (generation === this.generation) this.logout(); throw error; })
      .finally(() => {
        clearTimeout(timer);
        if (this.renewing === controller) this.renewing = null;
        if (this.refreshing === refreshing) this.refreshing = null;
      });
    this.refreshing = refreshing;
    return refreshing;
  }

  url(path: string): URL {
    const url = new URL(path, this.origin);
    if (url.origin !== this.origin || url.username || url.password) {
      throw new RegistryError('The registry tried to send a request to another address.');
    }
    return url;
  }

  async login(repository: string | null, signal?: AbortSignal): Promise<RegistrySession> {
    if (this.pendingRevoke) throw new RegistryError('Please finish signing out of the registry before connecting again.');
    this.logout();
    const generation = this.generation;
    if (repository) repositoryName(repository);
    signal?.throwIfAborted();
    const attempt = new AbortController(); this.attempt = attempt;
    const abort = () => attempt.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const authorization = await registryOAuthLogin(this.origin, this.registryOrigin, repository, attempt.signal);
      attempt.signal.throwIfAborted();
      if (generation !== this.generation) throw new RegistryError('Sign-in was cancelled.');
      return this.accept(authorization, generation);
    } finally {
      signal?.removeEventListener('abort', abort);
      if (this.attempt === attempt) this.attempt = null;
    }
  }

  async request(path: string | URL, init: RequestInit = {}, allowMissing = false, retried = false): Promise<Response> {
    if (!this.current || !this.token || this.current.sessionExpiresAt <= Date.now()) {
      this.logout();
      throw new RegistryError('Your sign-in has expired. Please sign in again.', 401);
    }
    if (this.current.expiresAt <= Date.now() + 30000) await this.renew();
    if (!this.current || !this.token) throw new RegistryError('Your sign-in has expired. Please sign in again.', 401);
    init.signal?.throwIfAborted();
    const sentToken = this.token;
    const generation = this.generation;
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${this.token}`);
    const target = this.url(path.toString());
    if (!target.pathname.startsWith('/v2/')) throw new RegistryError('The request is outside this registry connection.');
    // Blob storage may redirect GETs to object storage. Fetch strips Authorization
    // across origins; RegistryArtifacts still verifies the downloaded source digest.
    const blobGet = (init.method ?? 'GET').toUpperCase() === 'GET' && /\/blobs\/sha256:[a-f0-9]{64}$/.test(target.pathname);
    const response = await fetch(target, { ...init, headers, credentials: 'omit', redirect: blobGet ? 'follow' : 'error' });
    if (generation !== this.generation) throw new DOMException('Registry request was cancelled', 'AbortError');
    if (response.status === 401) {
      if (!retried && generation === this.generation) {
        if (sentToken === this.token) await this.renew();
        return this.request(path, init, allowMissing, true);
      }
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
