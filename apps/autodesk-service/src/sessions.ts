/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { randomBytes } from 'node:crypto';
import { TokenManager, createAuthorizationRequest, parseAuthorizationCallback } from '@ifc-lite/oauth-pkce';
import type { SourceIdentity } from '@ifc-lite/plugin-api';
import type { AutodeskServiceConfig } from './config.js';
import { apsResponse, ServiceError } from './upstream.js';

const APS = 'https://developer.api.autodesk.com';
export interface Session {
  id: string;
  csrf: string;
  expiresAt: number;
  lastSeen: number;
  active: boolean;
  signInGeneration: number;
  tokens: TokenManager;
  identity?: SourceIdentity;
  transaction?: { state: string; verifier: string; expiresAt: number };
  operations: Set<AbortController>;
}
/** Bounded single-process store. Restart signs users out; never persists tokens to disk. */
export class Sessions {
  private readonly sessions = new Map<string, Session>();
  readonly cookieName: string;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  constructor(private readonly config: AutodeskServiceConfig) {
    this.cookieName = config.insecureLocalhost ? 'ifclite-autodesk' : '__Host-ifclite-autodesk';
    this.now = config.now ?? Date.now;
    const original = config.fetch ?? fetch;
    this.fetcher = async (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set('Authorization', `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`);
      return original(input, { ...init, headers, redirect: 'error', signal: AbortSignal.timeout(30_000) });
    };
  }
  close(): void { for (const session of this.sessions.values()) this.discard(session); }
  cookie(session?: Session): string {
    return `${this.cookieName}=${session?.id ?? ''}; Path=/; HttpOnly; SameSite=Lax; ${this.config.insecureLocalhost ? '' : 'Secure; '}Max-Age=${session ? 8 * 3600 : 0}`;
  }
  get(request: Request): Session | undefined {
    this.prune();
    const id = (request.headers.get('cookie') ?? '').split(';').map((part) => part.trim()).find((part) => part.startsWith(`${this.cookieName}=`))?.slice(this.cookieName.length + 1);
    const session = id ? this.sessions.get(id) : undefined;
    if (session?.active) session.lastSeen = this.now();
    return session?.active ? session : undefined;
  }
  create(): Session {
    this.prune();
    if (this.sessions.size >= (this.config.maxSessions ?? 1000)) throw new ServiceError(503, 'session-capacity', 'Autodesk connections are at capacity. Try again later.');
    let raw: string | undefined;
    const session: Session = {
      id: randomBytes(32).toString('base64url'), csrf: randomBytes(32).toString('base64url'),
      expiresAt: this.now() + 8 * 3600_000, lastSeen: this.now(), active: true, signInGeneration: 0, operations: new Set(),
      tokens: new TokenManager({
        clientId: this.config.clientId, tokenEndpoint: `${APS}/authentication/v2/token`, fetch: this.fetcher,
        storageKey: 'tokens', storage: {
          get: async () => raw,
          set: async (_key, value) => { raw = value; },
          delete: async () => { raw = undefined; },
        }, now: this.now,
      }),
    };
    this.sessions.set(session.id, session);
    return session;
  }
  private prune(): void {
    for (const session of this.sessions.values()) {
      if (session.expiresAt <= this.now() || session.lastSeen + 30 * 60_000 <= this.now()) this.discard(session);
    }
  }
  discard(session: Session): void {
    session.active = false;
    session.transaction = undefined;
    for (const controller of session.operations) controller.abort();
    this.sessions.delete(session.id);
    void session.tokens.clear();
  }
  cancelSignIn(session: Session): void {
    session.signInGeneration++;
    session.transaction = undefined;
  }
  async authorize(session: Session): Promise<{ url: string; state: string }> {
    const generation = session.signInGeneration;
    const request = await createAuthorizationRequest({
      authorizationEndpoint: `${APS}/authentication/v2/authorize`, clientId: this.config.clientId,
      redirectUri: `${this.config.origin}/api/autodesk/callback`, scope: 'data:read user-profile:read',
    });
    if (!session.active || generation !== session.signInGeneration) throw new ServiceError(401, 'signed-out', 'Sign in with Autodesk again.');
    session.signInGeneration++;
    session.transaction = { state: request.state, verifier: request.codeVerifier, expiresAt: this.now() + 5 * 60_000 };
    return { url: request.url, state: request.state };
  }
  async callback(request: Request, session: Session): Promise<Session> {
    const generation = session.signInGeneration;
    const transaction = session.transaction;
    session.transaction = undefined; // Single-use, even on denial or failed exchange.
    if (!transaction || transaction.expiresAt < this.now()) throw new ServiceError(400, 'expired-transaction', 'Autodesk sign-in expired. Try again.');
    const callback = parseAuthorizationCallback(request.url, { expectedRedirectOrigin: this.config.origin, expectedState: transaction.state });
    const response = await this.fetcher(`${APS}/authentication/v2/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code: callback.code,
        client_id: this.config.clientId, redirect_uri: `${this.config.origin}/api/autodesk/callback`, code_verifier: transaction.verifier }),
    });
    if (!response.ok) throw new ServiceError(401, 'exchange-failed', 'Autodesk sign-in could not be completed.');
    const payload: unknown = await response.json();
    if (!payload || typeof payload !== 'object') throw new ServiceError(502, 'invalid-token', 'Invalid Autodesk token response.');
    const value = payload as Record<string, unknown>;
    if (typeof value.access_token !== 'string' || typeof value.expires_in !== 'number' || value.expires_in <= 0) throw new ServiceError(502, 'invalid-token', 'Invalid Autodesk token response.');
    if (!session.active || generation !== session.signInGeneration) throw new ServiceError(401, 'signed-out', 'Autodesk sign-in was cancelled.');
    // Rotate the opaque session at login; tokens never enter browser cookies.
    const signedIn = this.create();
    await signedIn.tokens.setTokens({ accessToken: value.access_token, expiresAt: this.now() + value.expires_in * 1000,
      refreshToken: typeof value.refresh_token === 'string' ? value.refresh_token : undefined });
    try {
      signedIn.identity = await this.identity(signedIn);
      if (!session.active || generation !== session.signInGeneration) throw new ServiceError(401, 'signed-out', 'Autodesk sign-in was cancelled.');
      this.discard(session);
      return signedIn;
    } catch (error) {
      this.discard(signedIn);
      throw error;
    }
  }
  async identity(session: Session): Promise<SourceIdentity> {
    const response = await apsResponse(this.config.fetch ?? fetch, '/authentication/v2/userinfo', await session.tokens.getValidAccessToken(), 'US');
    const value: unknown = await response.json();
    if (!value || typeof value !== 'object' || !('sub' in value) || typeof value.sub !== 'string') throw new ServiceError(502, 'invalid-identity', 'Autodesk returned no user identity.');
    return { id: value.sub, displayName: 'name' in value && typeof value.name === 'string' ? value.name : undefined,
      email: 'email' in value && typeof value.email === 'string' ? value.email : undefined };
  }
}
