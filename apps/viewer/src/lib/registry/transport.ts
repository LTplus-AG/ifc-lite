/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

export class RegistryError extends Error {
  constructor(message: string, readonly status = 0) { super(message); }
}

export interface RegistrySession {
  repository: string;
  actions: string[];
  expiresAt: number;
}

export function repositoryName(value: string): string {
  if (value.length > 255 || !/^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/.test(value)) {
    throw new RegistryError('Enter a repository such as project/model.');
  }
  return value;
}

export function releaseName(value: string): string {
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(value)) {
    throw new RegistryError('Use letters, numbers, dots, underscores or hyphens for the version.');
  }
  return value;
}

export async function responseBytes(response: Response, limit: number): Promise<Uint8Array<ArrayBuffer>> {
  const reader = response.body?.getReader();
  if (!reader) throw new RegistryError('The registry returned an empty response.');
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) throw new RegistryError('The registry response exceeds the supported size.');
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

/** OCI Bearer discovery for the local same-origin registry proxy. No persistent secrets. */
export class RegistryTransport {
  private token: string | null = null;
  private generation = 0;
  private current: RegistrySession | null = null;
  readonly origin: string;

  constructor(origin: string) {
    const url = new URL(origin);
    if (url.username || url.password || (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
      throw new RegistryError('Use HTTPS or the local viewer address.');
    }
    this.origin = url.origin;
  }

  get session(): RegistrySession | null { return this.current; }
  can(action: 'pull' | 'push'): boolean {
    return Boolean(this.current && this.current.expiresAt > Date.now() && this.current.actions.includes(action));
  }
  logout(): void { this.generation += 1; this.token = null; this.current = null; }

  url(path: string): URL {
    const url = new URL(path, this.origin);
    if (url.origin !== this.origin || url.username || url.password) {
      throw new RegistryError('The registry tried to send a request to another address.');
    }
    return url;
  }

  async login(repository: string, username: string, password: string, signal?: AbortSignal): Promise<RegistrySession> {
    this.logout();
    const generation = this.generation;
    repositoryName(repository);
    const challenge = await fetch(this.url('/v2/'), { credentials: 'omit', redirect: 'error', signal });
    const header = challenge.headers.get('www-authenticate') ?? '';
    if (challenge.status !== 401 || !/^Bearer /i.test(header)) {
      throw new RegistryError('The registry did not offer a supported sign-in.');
    }
    const fields = new Map([...header.matchAll(/([\w]+)="([^"]*)"/g)].map(m => [m[1].toLowerCase(), m[2]]));
    if (!fields.get('realm') || !fields.get('service')) throw new RegistryError('The sign-in challenge is incomplete.');
    const realm = this.url(fields.get('realm')!);
    realm.searchParams.set('service', fields.get('service')!);
    realm.searchParams.set('scope', `repository:${repository}:pull,push`);
    const credentials = new TextEncoder().encode(`${username}:${password}`);
    const basic = btoa(Array.from(credentials, byte => String.fromCharCode(byte)).join(''));
    const response = await fetch(realm, {
      credentials: 'omit', redirect: 'error', signal, headers: { Authorization: `Basic ${basic}` },
    });
    if (!response.ok) throw new RegistryError('Sign-in failed. Check your username and password.', response.status);
    const reply: unknown = JSON.parse(new TextDecoder().decode(await responseBytes(response, 64 * 1024)));
    if (!reply || typeof reply !== 'object' || !('token' in reply) || typeof reply.token !== 'string' ||
      !('expires_in' in reply) || typeof reply.expires_in !== 'number' || reply.expires_in <= 0 ||
      !('access' in reply) || !Array.isArray(reply.access)) throw new RegistryError('Invalid registry sign-in response.');
    const actions: string[] = [];
    for (const access of reply.access as unknown[]) {
      if (access && typeof access === 'object' && 'name' in access && access.name === repository &&
        'type' in access && access.type === 'repository' && 'actions' in access && Array.isArray(access.actions)) {
        for (const action of access.actions as unknown[]) {
          if (action === 'pull' || action === 'push') actions.push(action);
        }
      }
    }
    if (!actions.includes('pull')) throw new RegistryError('This account cannot receive releases from this repository.', 403);
    signal?.throwIfAborted();
    if (generation !== this.generation) throw new RegistryError('Sign-in was cancelled.');
    this.token = reply.token;
    this.current = { repository, actions: [...new Set(actions)], expiresAt: Date.now() + reply.expires_in * 1000 };
    return this.current;
  }

  async request(path: string | URL, init: RequestInit = {}, allowMissing = false): Promise<Response> {
    if (!this.current || !this.token || this.current.expiresAt <= Date.now()) {
      this.logout();
      throw new RegistryError('Your sign-in has expired. Please sign in again.', 401);
    }
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${this.token}`);
    const response = await fetch(this.url(path.toString()), { ...init, headers, credentials: 'omit', redirect: 'error' });
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
    if (repositoryName(repository) !== this.current.repository) {
      throw new RegistryError('Sign in to the selected repository first.', 403);
    }
    return `/v2/${repository}/${suffix}`;
  }
}
