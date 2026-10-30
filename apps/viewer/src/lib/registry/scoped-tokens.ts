/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { RegistryError } from './protocol';
import { registryJsonReply } from './session-exchange';

/** Coalesce concrete OCI exchanges. Root credentials never accompany artifact requests. */
export class ScopedTokens {
  private entries = new Map<string, Promise<{ token: string; expires: number }>>();
  clear(): void { this.entries.clear(); }
  async token(origin: string, root: string, repository: string): Promise<string> {
    const key = `${root}\0${repository}`;
    const previous = this.entries.get(key);
    if (previous) {
      const entry = await previous;
      if (entry.expires > Date.now() + 10000) return entry.token;
      if (this.entries.get(key) === previous) this.entries.delete(key);
    }
    const pending = this.entries.get(key);
    if (pending) return (await pending).token;
    const exchange = (async () => {
      const url = new URL('/token', origin); url.searchParams.set('scope', `repository:${repository}:pull,push`);
      const reply = await registryJsonReply(await fetch(url, { headers: { Authorization: `Bearer ${root}` }, credentials: 'omit', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15000) }));
      if (!reply || typeof reply !== 'object' || !('access_token' in reply) || typeof reply.access_token !== 'string' || !reply.access_token ||
        !('expires_in' in reply) || typeof reply.expires_in !== 'number' || !Number.isSafeInteger(reply.expires_in) || reply.expires_in <= 0 || reply.expires_in > 900 ||
        !('access' in reply) || !Array.isArray(reply.access) || !reply.access.length || !reply.access.every((a: unknown) => a && typeof a === 'object' &&
          'type' in a && a.type === 'repository' && 'name' in a && a.name === repository && 'actions' in a && Array.isArray(a.actions) && a.actions.every((action: unknown) => action === 'pull' || action === 'push'))) throw new RegistryError('Invalid scoped registry token.');
      return { token: reply.access_token, expires: Date.now() + reply.expires_in * 1000 };
    })();
    this.entries.set(key, exchange);
    try { return (await exchange).token; }
    catch (error) { if (this.entries.get(key) === exchange) this.entries.delete(key); throw error; }
  }
}
