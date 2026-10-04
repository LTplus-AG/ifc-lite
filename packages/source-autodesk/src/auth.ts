/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import {
  createAuthorizationRequest, exchangeAuthorizationCode, NotSignedInError,
  parseAuthorizationCallback, TokenManager, waitForOAuthCallback,
} from '@ifc-lite/oauth-pkce';
import type { PluginContext, SourceAuth, SourceIdentity } from '@ifc-lite/plugin-api';
import { APS_ORIGIN, AutodeskError, checkResponse, optionalText, record, text, type AutodeskService } from './api.js';

export const REDIRECT_PATH = '/oauth/autodesk/callback';
const PENDING_KEY = 'ifc-lite:autodesk:authorization';
const CALLBACK_KEY = 'ifc-lite:autodesk:callback';
const TIMEOUT = 5 * 60_000;
const SCOPE = 'data:read user-profile:read';

export class AutodeskAuth implements SourceAuth {
  private readonly memory = new Map<string, string>();
  private manager?: TokenManager;
  private managerClient?: string;
  private attempt?: AbortController;
  private generation = 0;
  private cancellation: Promise<void> = Promise.resolve();
  constructor(private readonly service?: AutodeskService) {}

  private async tokens(ctx: PluginContext): Promise<TokenManager> {
    const clientId = (await ctx.getPreference('clientId'))?.trim();
    if (!clientId) throw new AutodeskError('unconfigured', 'Autodesk is not configured. Ask the viewer administrator to register an APS application.');
    if (!this.manager || this.managerClient !== clientId) {
      await this.manager?.clear();
      this.managerClient = clientId;
      this.manager = new TokenManager({
        clientId, tokenEndpoint: `${APS_ORIGIN}/authentication/v2/token`, fetch: ctx.fetch,
        storageKey: 'tokens', storage: {
          get: async (key) => this.memory.get(key),
          set: async (key, value) => { this.memory.set(key, value); },
          delete: async (key) => { this.memory.delete(key); },
        },
      });
    }
    return this.manager;
  }
  async accessToken(ctx: PluginContext): Promise<string> {
    return (await this.tokens(ctx)).getValidAccessToken();
  }
  async getIdentity(ctx: PluginContext): Promise<SourceIdentity | null> {
    const generation = this.generation;
    try {
      if (this.service) {
        const identity = await this.service.identity();
        return generation === this.generation ? identity : null;
      }
      // Read the Autodesk OIDC profile, rather than decoding token claims.
      const response = await ctx.fetch('https://api.userprofile.autodesk.com/userinfo', {
        headers: { Authorization: `Bearer ${await this.accessToken(ctx)}` },
      });
      checkResponse(response);
      const value = record(await response.json());
      if (generation !== this.generation) return null;
      return { id: text(value.sub), displayName: optionalText(value.name), email: optionalText(value.email) };
    } catch (error) {
      if (error instanceof NotSignedInError || (error instanceof AutodeskError && ['unconfigured', 'http-401'].includes(error.code))) return null;
      throw error;
    }
  }
  async restore(ctx: PluginContext): Promise<SourceIdentity | null> {
    if (typeof window !== 'undefined') {
      const pending = sessionStorage.getItem(PENDING_KEY);
      const callback = sessionStorage.getItem(CALLBACK_KEY);
      sessionStorage.removeItem(PENDING_KEY);
      sessionStorage.removeItem(CALLBACK_KEY);
      if (pending && callback && !this.service) {
        const transaction = record(JSON.parse(pending));
        if (typeof transaction.expiresAt !== 'number' || transaction.expiresAt < Date.now()) {
          throw new AutodeskError('expired', 'Autodesk sign-in expired. Try again.');
        }
        await this.finish(ctx, callback, text(transaction.state), text(transaction.verifier), this.generation);
      }
    }
    return this.getIdentity(ctx);
  }
  cancelSignIn(): void {
    this.generation++;
    if (this.attempt && this.service?.cancelSignIn) {
      this.cancellation = this.service.cancelSignIn().catch((error: unknown) => {
        console.warn('[autodesk] Could not cancel the server sign-in transaction', error instanceof Error ? error.name : 'unknown error');
      });
    }
    this.attempt?.abort(new DOMException('Autodesk sign-in cancelled', 'AbortError'));
    this.attempt = undefined;
  }
  async signIn(ctx: PluginContext): Promise<SourceIdentity> {
    if (typeof window === 'undefined') throw new Error('Autodesk sign-in requires a browser.');
    this.cancelSignIn();
    const generation = this.generation;
    const attempt = new AbortController();
    this.attempt = attempt;
    // Open before preferences, crypto or network awaits consume user activation.
    const popup = window.open('about:blank', 'ifc-lite-autodesk-signin', 'width=520,height=720');
    try {
      await this.cancellation;
      attempt.signal.throwIfAborted();
      const clientId = this.service ? undefined : (await ctx.getPreference('clientId'))?.trim();
      if (!this.service && !clientId) throw new AutodeskError('unconfigured', 'Configure the Autodesk APS application ID in source settings.');
      const request = this.service
        ? await this.service.startSignIn(attempt.signal)
        : await createAuthorizationRequest({
          authorizationEndpoint: `${APS_ORIGIN}/authentication/v2/authorize`, clientId: clientId!,
          redirectUri: `${window.location.origin}${REDIRECT_PATH}`, scope: SCOPE,
        });
      attempt.signal.throwIfAborted();
      if (!popup) {
        // Full-tab fallback survives the redirect without persisting tokens.
        sessionStorage.setItem(PENDING_KEY, JSON.stringify({
          state: request.state, verifier: 'codeVerifier' in request ? request.codeVerifier : '',
          expiresAt: Date.now() + TIMEOUT, returnPath: `${window.location.pathname}${window.location.hash}`,
        }));
        window.location.assign(request.url);
        throw new AutodeskError('redirecting', 'Continue Autodesk sign-in in this tab.');
      }
      const waiting = waitForOAuthCallback({
        expectedState: request.state, timeoutMs: TIMEOUT, timeoutMessage: 'Autodesk sign-in timed out. Try again.',
        signal: attempt.signal,
      });
      popup.location.href = request.url;
      const callback = await waiting;
      attempt.signal.throwIfAborted();
      if (this.service) {
        const result = new URL(callback);
        if (result.origin !== window.location.origin || result.pathname !== REDIRECT_PATH ||
            result.searchParams.get('state') !== request.state || result.searchParams.get('connected') !== '1') {
          throw new AutodeskError('sign-in-failed', 'Autodesk sign-in was denied or expired. Try again.');
        }
      } else {
        if (!('codeVerifier' in request)) throw new Error('Missing PKCE transaction.');
        await this.finish(ctx, callback, request.state, request.codeVerifier, generation);
      }
      const identity = await this.getIdentity(ctx);
      if (!identity || generation !== this.generation) throw new NotSignedInError();
      return identity;
    } catch (error) {
      popup?.close();
      throw error;
    } finally {
      if (this.attempt === attempt) this.attempt = undefined;
    }
  }
  private async finish(ctx: PluginContext, url: string, state: string, verifier: string, generation: number): Promise<void> {
    const parsed = new URL(url);
    if (parsed.pathname !== REDIRECT_PATH) throw new AutodeskError('invalid-callback', 'Invalid Autodesk sign-in callback.');
    const callback = parseAuthorizationCallback(url, { expectedRedirectOrigin: window.location.origin, expectedState: state });
    const clientId = text(await ctx.getPreference('clientId'), 'APS application ID');
    const tokens = await exchangeAuthorizationCode({
      tokenEndpoint: `${APS_ORIGIN}/authentication/v2/token`, clientId,
      redirectUri: `${window.location.origin}${REDIRECT_PATH}`, code: callback.code, codeVerifier: verifier, fetch: ctx.fetch,
    });
    if (generation !== this.generation) throw new NotSignedInError();
    await (await this.tokens(ctx)).setTokens(tokens);
    if (generation !== this.generation) { await this.manager?.clear(); throw new NotSignedInError(); }
  }
  async signOut(): Promise<void> {
    this.cancelSignIn();
    await this.manager?.clear();
    this.memory.clear();
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.removeItem(PENDING_KEY); sessionStorage.removeItem(CALLBACK_KEY);
    }
    await this.cancellation;
    await this.service?.signOut();
  }
}
