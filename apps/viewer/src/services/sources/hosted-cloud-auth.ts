/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { PluginContext, SourceAuth, SourceIdentity } from '@ifc-lite/plugin-api';
import { waitForOAuthCallback } from '@ifc-lite/oauth-pkce';
import { HostedCloudClient, HostedCloudError, object, type HostedVendor } from './hosted-cloud-client';
const TIMEOUT = 5 * 60_000;
export function validateHostedCallback(url: string, vendor: HostedVendor, origin: string, state: string): void {
  const result = new URL(url);
  if (result.origin !== origin || result.pathname !== `/oauth/${vendor}/callback` ||
      result.searchParams.get('state') !== state || result.searchParams.get('connected') !== '1' || result.searchParams.has('error')) {
    throw new Error('Cloud sign-in was denied or expired. Try again.');
  }
}
export function validateHostedAuthorization(url: string, vendor: HostedVendor): void {
  const result = new URL(url);
  const valid = vendor === 'dropbox' ? result.origin === 'https://www.dropbox.com' && result.pathname === '/oauth2/authorize'
    : result.origin === 'https://login.microsoftonline.com' && /^\/[a-zA-Z0-9.-]+\/oauth2\/v2.0\/authorize$/.test(result.pathname);
  if (!valid || result.username || result.password) throw new Error('Invalid cloud sign-in destination.');
}
export class HostedCloudAuth implements SourceAuth {
  private generation = 0;
  private attempt?: AbortController;
  private cancellation: Promise<void> = Promise.resolve();
  private readonly pendingKey: string;
  private readonly callbackKey: string;
  constructor(private readonly client: HostedCloudClient) {
    this.pendingKey = `ifc-lite:cloud:${client.vendor}:authorization`;
    this.callbackKey = `ifc-lite:cloud:${client.vendor}:callback`;
  }
  async getIdentity(_ctx: PluginContext): Promise<SourceIdentity | null> {
    const generation = this.generation;
    const session = await this.client.session();
    return generation === this.generation ? session.identity : null;
  }
  async restore(ctx: PluginContext): Promise<SourceIdentity | null> {
    const pending = sessionStorage.getItem(this.pendingKey);
    const callback = sessionStorage.getItem(this.callbackKey);
    sessionStorage.removeItem(this.pendingKey); sessionStorage.removeItem(this.callbackKey);
    if (pending) {
      try {
        const transaction = object(JSON.parse(pending));
        if (!callback || typeof transaction.state !== 'string' || typeof transaction.expiresAt !== 'number' || transaction.expiresAt <= Date.now()) {
          throw new Error('Cloud sign-in expired. Try again.');
        }
        validateHostedCallback(callback, this.client.vendor, window.location.origin, transaction.state);
      } catch (error) { await this.client.post('cancel-signin'); throw error; }
    }
    return this.getIdentity(ctx);
  }
  cancelSignIn(): void {
    this.generation++;
    const attempt = this.attempt;
    attempt?.abort(new DOMException('Cloud sign-in cancelled', 'AbortError'));
    this.attempt = undefined;
    sessionStorage.removeItem(this.pendingKey); sessionStorage.removeItem(this.callbackKey);
    if (attempt) this.cancellation = this.cancellation.then(async () => { await this.client.post('cancel-signin'); }).catch((error: unknown) => {
      console.warn('[sources] Could not cancel cloud sign-in', error instanceof Error ? error.name : 'unknown');
    });
  }
  async signIn(ctx: PluginContext): Promise<SourceIdentity> {
    this.cancelSignIn();
    const generation = this.generation;
    const attempt = new AbortController(); this.attempt = attempt;
    // Preserve browser user activation; all network work happens afterward.
    const popup = window.open('about:blank', `ifc-lite-${this.client.vendor}-signin`, 'width=520,height=720');
    let redirecting = false;
    try {
      await this.cancellation; attempt.signal.throwIfAborted();
      const session = await this.client.session(attempt.signal);
      if (!session.configured) throw new HostedCloudError(503, 'unconfigured');
      const request = object(await (await this.client.post('authorize', {}, attempt.signal)).json());
      attempt.signal.throwIfAborted();
      if (typeof request.url !== 'string' || typeof request.state !== 'string' || !request.state) throw new Error('Invalid cloud authorization response.');
      validateHostedAuthorization(request.url, this.client.vendor);
      if (!popup) {
        sessionStorage.setItem(this.pendingKey, JSON.stringify({ state: request.state, expiresAt: Date.now() + TIMEOUT,
          returnPath: `${window.location.pathname}${window.location.search}${window.location.hash}` }));
        redirecting = true; window.location.assign(request.url);
        throw new Error('Continue cloud sign-in in this tab.');
      }
      const waiting = waitForOAuthCallback({ expectedState: request.state, timeoutMs: TIMEOUT,
        timeoutMessage: 'Cloud sign-in timed out. Try again.', signal: attempt.signal });
      popup.location.href = request.url;
      validateHostedCallback(await waiting, this.client.vendor, window.location.origin, request.state);
      attempt.signal.throwIfAborted();
      const identity = await this.getIdentity(ctx);
      if (!identity || generation !== this.generation) throw new Error('Cloud sign-in did not complete. Try again.');
      return identity;
    } catch (error) {
      popup?.close();
      if (!redirecting && this.attempt === attempt) this.cancelSignIn();
      throw error;
    } finally { if (this.attempt === attempt) this.attempt = undefined; }
  }
  async signOut(_ctx: PluginContext): Promise<void> {
    this.cancelSignIn(); await this.cancellation;
    // No local identity is cleared until the server confirms sign-out.
    await this.client.post('signout');
  }
}
